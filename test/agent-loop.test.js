import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentWithConnection, tryAgentWithFallback } from "../src/providers/fallback.js";

function centralEnv() {
  return {
    AI_BASE_URL: "https://provider.example/v1",
    AI_MODEL: "tool-test",
    AI_API_KEY: "test-api-key",
    AI_SUPPORTS_VISION: "false"
  };
}

test("central OpenAI-compatible tool call receives its result and final answer", async () => {
  const env = centralEnv();
  const requests = [];
  let call = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    call++;
    const message = call === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "remember_fact", arguments: '{"fact":"Prefers brief replies"}' } }] }
      : { role: "assistant", content: "Saved: Prefers brief replies" };
    return new Response(JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 3, completion_tokens: 2 }
    }), { headers: { "content-type": "application/json" } });
  };
  const writes = [];
  env.DB = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return { memory_data: "{}", memory_mode: "normal" }; },
        async run() { writes.push(this.args); return { meta: { changes: 1 } }; }
      };
    }
  };
  const result = await generateAgentWithConnection(
    env,
    { telegram_id: 12, is_group: false },
    null,
    [{ role: "user", content: "remember that I prefer brief replies" }],
    { max_tokens: 200 }
  );

  assert.equal(result.text, "Saved: Prefers brief replies");
  assert.equal(call, 2);
  assert.equal(writes.length, 1);
  assert.equal(requests[0].url, "https://provider.example/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer test-api-key");
  assert.equal(requests[0].body.model, "tool-test");
  assert.equal(requests[1].body.messages.at(-1).role, "tool");
});

test("central execution performs one model attempt and never switches providers", async () => {
  const env = centralEnv();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Central answer" } }]
    }), { headers: { "content-type": "application/json" } });
  };
  const events = [];
  for await (const event of tryAgentWithFallback(env, { telegram_id: 12 }, [{ role: "user", content: "hello" }], { totalBudgetMs: 5000 })) {
    events.push(event);
  }
  assert.equal(requests, 1);
  assert.equal(events.filter(event => event.type === "done").length, 1);
  assert.equal(events.find(event => event.type === "done").attempts, 1);
  assert.equal(events.find(event => event.type === "done").fallbackUsed, false);
});
