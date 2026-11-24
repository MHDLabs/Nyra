import { test } from "node:test";
import assert from "node:assert/strict";
import { streamCloudflareAI } from "../src/providers/cloudflare.js";

test("native Workers AI binding streams text and tool-call results", async () => {
  const chunks = [
    'data: {"response":"سلام "}\n\n',
    'data: {"response":"دنیا"}\n\n',
    'data: {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}\n\n'
  ];
  const env = { AI: { async run(model, input) {
    assert.equal(model, "@cf/zai-org/glm-4.7-flash");
    assert.equal(input.stream, true);
    return new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }});
  }}};
  const events = [];
  for await (const event of streamCloudflareAI(env, { model: "@cf/zai-org/glm-4.7-flash", supports_vision: 0 },
    [{ role: "user", content: "سلام" }], { max_tokens: 100 }, new AbortController().signal)) events.push(event);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), "سلام دنیا");
  assert.equal(events.find(event => event.type === "tool_calls").toolCalls[0].function.name, "lookup");
});

test("native Workers AI binding reports a clear error when not configured", async () => {
  await assert.rejects(async () => {
    for await (const _event of streamCloudflareAI({}, { model: "@cf/qwen/qwen3.8-27b", supports_vision: 1 },
      [{ role: "user", content: "hello" }], {}, new AbortController().signal)) {}
  }, /binding is not configured/i);
});
