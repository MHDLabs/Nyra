import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReact, pickReaction, normalizeLabel, heuristicReaction } from "../src/reactions.js";

test("shouldReact never reacts in private chats", () => {
  assert.equal(shouldReact({ text: "hey Nyra how are you" }, false), false);
});

test("shouldReact ignores group messages that do not name Nyra", () => {
  assert.equal(shouldReact({ text: "good morning everyone, what's up" }, true), false);
  assert.equal(shouldReact({ text: "this is a totally unrelated message" }, true), false);
});

test("shouldReact reacts only when Nyra is named", () => {
  assert.equal(shouldReact({ text: "Nyra can you help me?" }, true), true);
  assert.equal(shouldReact({ text: "nyra, are you there?" }, true), true);
  assert.equal(shouldReact({ text: "یه سوال از نیرا دارم" }, true), true);
  assert.equal(shouldReact({ text: "کجا بودی نيرا" }, true), true);
});

test("shouldReact handles captions and empty input", () => {
  assert.equal(shouldReact({ caption: "Nyra look at this" }, true), true);
  assert.equal(shouldReact({ caption: "just a photo" }, true), false);
  assert.equal(shouldReact({}, true), false);
  assert.equal(shouldReact({ text: "   " }, true), false);
  assert.equal(shouldReact({ text: "ny" }, true), false);
});

test("shouldReact does not match partial words", () => {
  assert.equal(shouldReact({ text: "the nyrablade is sharp" }, true), false);
  assert.equal(shouldReact({ text: "nyras" }, true), false);
});

test("normalizeLabel prefers the longest label (very_positive over positive)", () => {
  assert.equal(normalizeLabel("very_positive"), "very_positive");
  assert.equal(normalizeLabel("very_negative"), "very_negative");
  assert.equal(normalizeLabel("POSITIVE"), "positive");
  assert.equal(normalizeLabel("  Question. "), "question");
  assert.equal(normalizeLabel("label: funny"), "funny");
  assert.equal(normalizeLabel("banana"), null);
  assert.equal(normalizeLabel(""), null);
  assert.equal(normalizeLabel(null), null);
});

test("pickReaction maps instruct-model labels", () => {
  assert.equal(pickReaction({ response: "very_positive" }, "I love it"), "❤️");
  assert.equal(pickReaction({ response: "positive" }, "thanks"), "👍");
  assert.equal(pickReaction({ response: "question" }, "what is this"), "❓");
  assert.equal(pickReaction({ response: "angry" }, "shut up"), "😠");
});

test("pickReaction maps sentiment scores to intensity", () => {
  assert.equal(pickReaction([{ label: "POSITIVE", score: 0.98 }], "great"), "❤️");
  assert.equal(pickReaction([{ label: "POSITIVE", score: 0.4 }], "ok"), "👍");
  assert.equal(pickReaction([{ label: "NEGATIVE", score: 0.95 }], "awful"), "😢");
  assert.equal(pickReaction([{ label: "NEGATIVE", score: 0.3 }], "meh"), "👎");
  assert.equal(pickReaction({ label: "positive", score: 0.2 }, "fine"), "👍");
});

test("pickReaction falls back to the heuristic when the model output is unusable", () => {
  assert.equal(pickReaction({}, "are you there?"), "❓");
  assert.equal(pickReaction(null, "hahaha"), "😄");
  assert.equal(pickReaction(null, "a plain statement"), null);
});

test("heuristicReaction handles Persian punctuation and laughter", () => {
  assert.equal(heuristicReaction("چطوری؟"), "❓");
  assert.equal(heuristicReaction("خخخخ"), "😄");
  assert.equal(heuristicReaction("lmao"), "😄");
  assert.equal(heuristicReaction("nothing special"), null);
  assert.equal(heuristicReaction(""), null);
});
