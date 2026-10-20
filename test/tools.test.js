import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAgentTool, toolDefinitions } from "../src/tools.js";

function memoryEnv(memory, changes = 1) {
  const calls = [];
  let current = memory;
  return {
    calls,
    DB: { prepare(sql) { return { args: [], bind(...args) { this.args = args; return this; }, async first() { calls.push({ sql, args: this.args, type: "first" }); return { memory_data: current, memory_mode: "normal" }; }, async run() { calls.push({ sql, args: this.args, type: "run" }); if (this.args[3] === current) current = this.args[0]; return { meta: { changes } }; } }; } }
  };
}

test("tool definitions preserve OpenAI and Anthropic native formats", () => {
  assert.equal(toolDefinitions("openai-compatible")[0].type, "function");
  assert.equal(toolDefinitions("anthropic")[0].input_schema.type, "object");
  assert.equal(toolDefinitions("anthropic").length, 4);
});

test("registered tools reject unknown names and malformed/unexpected args", async () => {
  await assert.rejects(executeAgentTool({}, 1, "shell", {}), /not permitted/);
  await assert.rejects(executeAgentTool({}, 1, "web_search", { query: "news", extra: true }), /Unexpected argument/);
  await assert.rejects(executeAgentTool({}, 1, "web_search", { query: "news" }), /TAVILY_API_KEY/);
});

test("remember writes one user's persistent memory and checks D1 success", async () => {
  const env = memoryEnv(JSON.stringify({ explicit_facts: ["Likes tea"] }));
  const result = JSON.parse(await executeAgentTool(env, 73, "remember_fact", { fact: "Prefers concise answers" }));
  assert.equal(result.saved, true);
  const update = env.calls.find(call => call.type === "run");
  assert.match(update.sql, /WHERE telegram_id = \? AND memory_data = \?/);
  assert.equal(update.args[2], 73);
  assert.deepEqual(JSON.parse(update.args[0]).explicit_facts, ["Likes tea", "Prefers concise answers"]);
  await assert.rejects(executeAgentTool(memoryEnv("{}", 0), 73, "remember_fact", { fact: "New fact" }), /not confirmed/);
});

test("forget only deletes one unambiguous matching item", async () => {
  const env = memoryEnv(JSON.stringify({ explicit_facts: ["Likes tea", "Likes coffee"] }));
  const ambiguous = JSON.parse(await executeAgentTool(env, 5, "forget_fact", { query: "Likes" }));
  assert.equal(ambiguous.clarification_required, true);
  assert.equal(env.calls.some(call => call.type === "run"), false);
  const deleted = JSON.parse(await executeAgentTool(env, 5, "forget_fact", { query: "coffee" }));
  assert.equal(deleted.deleted, true);
  assert.deepEqual(JSON.parse(env.calls.filter(call => call.type === "run")[0].args[0]).explicit_facts, ["Likes tea"]);
});

test("web fetch rejects local/private targets before making requests", async () => {
  await assert.rejects(executeAgentTool({}, 1, "web_fetch", { url: "http://127.0.0.1/" }), /public HTTP\(S\)/);
  await assert.rejects(executeAgentTool({}, 1, "web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }), /public HTTP\(S\)/);
  await assert.rejects(executeAgentTool({}, 1, "web_fetch", { url: "file:///etc/passwd" }), /public HTTP\(S\)/);
});

test("web fetch rejects DNS answers mapped to IPv4 loopback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const type = new URL(url).searchParams.get("type");
    const answer = type === "AAAA"
      ? { name: "example.com", type: 28, data: "::ffff:7f00:1" }
      : { name: "example.com", type: 1, data: "93.184.216.34" };
    return new Response(JSON.stringify({ Answer: [answer] }), { headers: { "content-type": "application/dns-json" } });
  };
  await assert.rejects(executeAgentTool({}, 1, "web_fetch", { url: "https://example.com" }), /non-public address/);
});

test("web fetch rejects non-public DNS answers, including mapped private IPv6", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const type = new URL(url).searchParams.get("type");
    const answer = type === "AAAA" ? { name: "example.com", type: 28, data: "::ffff:127.0.0.1" } : { name: "example.com", type: 1, data: "93.184.216.34" };
    return new Response(JSON.stringify({ Answer: [answer] }), { headers: { "content-type": "application/dns-json" } });
  };
  await assert.rejects(executeAgentTool({}, 1, "web_fetch", { url: "https://example.com" }), /non-public address/);
});