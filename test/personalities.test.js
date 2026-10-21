import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PERSONALITIES, RETIRED_PERSONALITY_IDS } from "../src/config.js";
import { buildContextMessages } from "../src/memory.js";

test("built-in personality catalog keeps only the surviving modes", () => {
  const ids = new Set(DEFAULT_PERSONALITIES.map(personality => personality.id));
  for (const id of ["default", "friendly", "romantic", "funny", "creative"]) assert.ok(ids.has(id), id);
  assert.equal(DEFAULT_PERSONALITIES.length, 5);
  const friend = DEFAULT_PERSONALITIES.find(personality => personality.id === "friendly");
  const romantic = DEFAULT_PERSONALITIES.find(personality => personality.id === "romantic");
  assert.match(friend.prompt, /strictly platonic/i);
  assert.match(romantic.prompt, /fictional/i);
  assert.match(romantic.prompt, /dependency/i);
  assert.equal(new Set(DEFAULT_PERSONALITIES.map(personality => personality.id)).size, DEFAULT_PERSONALITIES.length);
});

test("retired personalities are gone from the catalog and listed for cleanup", () => {
  const ids = DEFAULT_PERSONALITIES.map(personality => personality.id);
  const retired = ["sarcastic", "teacher", "researcher", "debater", "minimal", "calm", "professional", "coder"];
  for (const id of retired) {
    assert.equal(ids.indexOf(id), -1, id + " must not be a builtin");
    assert.ok(RETIRED_PERSONALITY_IDS.indexOf(id) !== -1, id + " must be in the retire list");
  }
  assert.equal(RETIRED_PERSONALITY_IDS.length, retired.length);
});

test("selected personality is composed into actual model system prompt", () => {
  const messages = buildContextMessages({ id: "friendly", prompt: "Be a warm platonic friend." }, { telegram_id: 1 }, null, [], "Explain", "normal");
  assert.match(messages[0].content, /Be a warm platonic friend/);
});