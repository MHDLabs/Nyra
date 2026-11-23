import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCentralAgent, streamCentralAI } from "../src/providers/agent.js";

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
    const frame = call === 1
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "remember_fact", arguments: '{"fact":"Prefers brief replies"}' } }] } }] }
      : { choices: [{ delta: { content: "Saved: Prefers brief replies" } }] };
    return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" }
    });
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
  const result = await generateCentralAgent(
    env,
    { telegram_id: 12, is_group: false },
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
  assert.equal(call, 2, "one request for the tool call and one for the final answer");
});

test("central execution performs one model attempt and never switches providers", async () => {
  const env = centralEnv();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      "data: " + JSON.stringify({ choices: [{ delta: { content: "Central answer" } }] }) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  const events = [];
  for await (const event of streamCentralAI(env, { telegram_id: 12 }, [{ role: "user", content: "hello" }], { totalBudgetMs: 5000 })) {
    events.push(event);
  }
  assert.equal(requests, 1);
  assert.equal(events.filter(event => event.type === "done").length, 1);
  assert.equal(events.find(event => event.type === "done").attempts, 1);
});

test("unsupported tool schema retries once on the same model without tools", async () => {
  const env = centralEnv();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Tools are not supported", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      "data: " + JSON.stringify({ choices: [{ delta: { content: "Plain answer" } }] }) + "\\n\\ndata: [DONE]\\n\\n",
      { headers: { "content-type": "text/event-stream" } }
    );
  };

  const events = [];
  for await (const event of streamCentralAI(env, { telegram_id: 12 }, [{ role: "user", content: "hello" }], { totalBudgetMs: 5000 })) {
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].body.model, requests[1].body.model);
  assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length > 0);
  assert.equal(Object.hasOwn(requests[1].body, "tools"), false);
  assert.equal(events.filter(event => event.type === "done").length, 1);
  assert.equal(events.find(event => event.type === "done").attempts, 2);
});

test("a partial stream failure is never retried to avoid duplicated answer text", async () => {
  const env = centralEnv();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    const failure = Object.assign(new Error("stream interrupted"), { status: 400 });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: " + JSON.stringify({ choices: [{ delta: { content: "Partial answer" } }] }) + "\\n\\n"
        ));
        controller.error(failure);
      }
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  const events = [];
  for await (const event of streamCentralAI(env, { telegram_id: 12 }, [{ role: "user", content: "hello" }], { totalBudgetMs: 5000 })) {
    events.push(event);
  }

  assert.equal(requests, 1);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), "Partial answer");
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.equal(events.find(event => event.type === "error").attempts, 1);
});
