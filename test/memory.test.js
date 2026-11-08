import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryData, serializeMemoryData, buildClockPrompt, buildContextMessages } from "../src/memory.js";
import { MEMORY_MAX_CHARS, MEMORY_UPDATE_INTERVAL, MAX_CONTEXT_MESSAGES } from "../src/config.js";

test("parseMemoryData tolerates invalid input", () => {
  assert.deepEqual(parseMemoryData(null), {});
  assert.deepEqual(parseMemoryData(""), {});
  assert.deepEqual(parseMemoryData("not json"), {});
  assert.deepEqual(parseMemoryData("[1,2]"), {});
  assert.deepEqual(parseMemoryData("null"), {});
});

test("serialize/parse round trip preserves benign data", () => {
  const data = {
    preferred_name: "Ali",
    communication_style: "direct and concise",
    interests: ["reading", "coding"],
    tools: ["VS Code"],
    projects: ["Nyra"],
    explicit_facts: ["lives in Tehran"],
    last_updated: 1700000000
  };
  const s = serializeMemoryData(data);
  const back = parseMemoryData(s);
  assert.equal(back.preferred_name, "Ali");
  assert.equal(back.communication_style, "direct and concise");
  assert.deepEqual(back.interests, ["reading", "coding"]);
  assert.deepEqual(back.projects, ["Nyra"]);
  assert.deepEqual(back.explicit_facts, ["lives in Tehran"]);
  assert.equal(back.last_updated, 1700000000);
});

test("serialized memory never exceeds MEMORY_MAX_CHARS", () => {
  const data = {
    preferred_name: "A".repeat(500),
    communication_style: "B".repeat(1000),
    interests: Array.from({ length: 50 }, (_, i) => "interest " + i + " " + "x".repeat(100)),
    tools: Array.from({ length: 50 }, (_, i) => "tool " + i + " " + "y".repeat(100)),
    projects: Array.from({ length: 50 }, (_, i) => "project " + i + " " + "z".repeat(100)),
    explicit_facts: Array.from({ length: 100 }, (_, i) => "fact " + i + " " + "f".repeat(200)),
    last_updated: 1700000000
  };
  const s = serializeMemoryData(data);
  assert.ok(s.length <= MEMORY_MAX_CHARS, `serialized length ${s.length} > ${MEMORY_MAX_CHARS}`);
  const back = parseMemoryData(s);
  assert.equal(typeof back, "object");
});


test("memory consolidates every 20 messages", () => {
  assert.equal(MEMORY_UPDATE_INTERVAL, 20);
  assert.equal(MAX_CONTEXT_MESSAGES, 20);
});

test("buildClockPrompt always includes current date and timezone", () => {
  const text = buildClockPrompt({ timezone: "UTC" });
  assert.match(text, /Current date and time:/);
  assert.match(text, /timezone: UTC/);
  assert.match(text, /UTC: \d{4}-\d{2}-\d{2}T/);
  assert.match(text, /Always use this clock/);
});

test("buildContextMessages includes rolling history and clock in system", () => {
  const recent = [
    { role: "user", content: "hi", created_at: 1700000000, user_id: 1, user_name: "A" },
    { role: "assistant", content: "hello", created_at: 1700000060 }
  ];
  const messages = buildContextMessages(
    { id: "default", prompt: "Be helpful." },
    { telegram_id: 1, timezone: "UTC", locale: "en-US" },
    null,
    recent,
    "how are you?",
    "normal"
  );
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Current date and time:/);
  assert.ok(messages.some((m) => m.role === "user" && String(m.content).indexOf("hi") !== -1));
  assert.ok(messages.some((m) => m.role === "assistant" && String(m.content).indexOf("hello") !== -1));
  assert.equal(messages[messages.length - 1].content, "how are you?");
});
