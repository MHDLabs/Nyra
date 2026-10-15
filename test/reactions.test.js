import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReact } from "../src/reactions.js";

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
