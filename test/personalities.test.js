import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PERSONALITIES } from "../src/config.js";
import { buildContextMessages } from "../src/memory.js";

test("built-in personality catalog contains the requested distinct modes", () => {
  const ids = new Set(DEFAULT_PERSONALITIES.map(personality => personality.id));
  for (const id of ["default", "friendly", "romantic", "professional", "funny", "sarcastic", "teacher", "coder", "researcher", "debater", "creative", "minimal", "calm"]) assert.ok(ids.has(id), id);
  const friend = DEFAULT_PERSONALITIES.find(personality => personality.id === "friendly");
  const romantic = DEFAULT_PERSONALITIES.find(personality => personality.id === "romantic");
  assert.match(friend.prompt, /strictly platonic/i);
  assert.match(romantic.prompt, /fictional/i);
  assert.match(romantic.prompt, /dependency/i);
  assert.equal(new Set(DEFAULT_PERSONALITIES.map(personality => personality.id)).size, DEFAULT_PERSONALITIES.length);
});

test("selected personality is composed into actual model system prompt", () => {
  const messages = buildContextMessages({ id: "teacher", prompt: "Teach by short examples." }, { telegram_id: 1 }, null, [], "Explain", "normal");
  assert.match(messages[0].content, /Teach by short examples/);
});