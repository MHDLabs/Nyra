import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentWithConnection } from "../src/providers/fallback.js";
import { encryptCredential } from "../src/crypto.js";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

async function connection(provider) {
  const env = { ENCRYPTION_KEY: key };
  const encrypted = await encryptCredential(env, 12, "test-api-key");
  return { env, connection: { provider, model: "tool-test", base_url: "https://provider.example/v1", encrypted_key: encrypted.ct, key_iv: encrypted.iv, telegram_id: 12 } };
}

test("OpenAI native tool call receives result and final answer uses result", async () => {
  const { env, connection: conn } = await connection("openai");
  const bodies = [];
  let request = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    request++;
    return new Response(JSON.stringify({ choices: [{ message: request === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "remember_fact", arguments: '{"fact":"Prefers brief replies"}' } }] }
      : { role: "assistant", content: "Saved: Prefers brief replies" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  };
  const writes = [];
  env.DB = { prepare(sql) { return { bind(...args) { this.args = args; return this; }, async first() { return { memory_data: "{}", memory_mode: "normal" }; }, async run() { writes.push(this.args); return { meta: { changes: 1 } }; } }; } };
  const result = await generateAgentWithConnection(env, { telegram_id: 12 }, conn, [{ role: "user", content: "remember that I prefer brief replies" }], { max_tokens: 200 });
  assert.equal(result.text, "Saved: Prefers brief replies");
  assert.equal(request, 2);
  assert.equal(writes.length, 1);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
});

test("Anthropic tool_use response is continued with matching tool_result block", async () => {
  const { env, connection: conn } = await connection("anthropic");
  const bodies = [];
  let request = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    request++;
    const response = request === 1
      ? { content: [{ type: "tool_use", id: "tool-1", name: "remember_fact", input: { fact: "Uses metric units" } }], stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2 } }
      : { content: [{ type: "text", text: "I saved that you use metric units." }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 5 } };
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  env.DB = { prepare() { return { bind() { return this; }, async first() { return { memory_data: "{}", memory_mode: "normal" }; }, async run() { return { meta: { changes: 1 } }; } }; } };
  const result = await generateAgentWithConnection(env, { telegram_id: 12 }, conn, [{ role: "user", content: "remember that I use metric units" }], { max_tokens: 200 });
  assert.equal(result.text, "I saved that you use metric units.");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].input_schema.type, "object");
  assert.equal(bodies[1].messages.at(-1).content[0].tool_use_id, "tool-1");
});

test("Workers AI fallback obeys disabled/admin-only/all policy server-side", async () => {
  let calls = 0;
  const base = {
    AI: { run: async () => { calls++; return { response: "Workers AI answer" }; } },
    ADMIN_IDS: "12",
    DB: { prepare(sql) { return { key: null, bind(key) { this.key = key; return this; }, async first() { return this.key === "workers_ai_policy" ? { value: "disabled" } : null; }, async all() { return { results: [] }; } }; } }
  };
  const user = { telegram_id: 12, active_connection_id: null };
  const messages = [{ role: "user", content: "hi" }];
  let events = [];
  for await (const event of (await import("../src/providers/fallback.js")).tryAgentWithFallback(base, user, messages, { totalBudgetMs: 5000 })) events.push(event);
  assert.equal(calls, 0);

  base.DB.prepare = function () { return { key: null, bind(key) { this.key = key; return this; }, async first() { return this.key === "workers_ai_policy" ? { value: "admins" } : null; }, async all() { return { results: [] }; } }; };
  events = [];
  for await (const event of (await import("../src/providers/fallback.js")).tryAgentWithFallback(base, user, messages, { totalBudgetMs: 5000 })) events.push(event);
  assert.equal(calls, 1);
  assert.equal(events.find(event => event.type === "text").text, "Workers AI answer");

  base.DB.prepare = function () { return { key: null, bind(key) { this.key = key; return this; }, async first() { return this.key === "workers_ai_policy" ? { value: "all" } : null; }, async all() { return { results: [] }; } }; };
  const nonAdminEvents = [];
  for await (const event of (await import("../src/providers/fallback.js")).tryAgentWithFallback(base, { telegram_id: 99 }, messages, { totalBudgetMs: 5000 })) nonAdminEvents.push(event);
  assert.equal(calls, 2);
  assert.equal(nonAdminEvents.find(event => event.type === "text").text, "Workers AI answer");
});