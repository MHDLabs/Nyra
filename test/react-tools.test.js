import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldReact } from "../src/reactions.js";
import { readFileSync } from "node:fs";

describe("reactions and tools", () => {
  const identity = { id: 99, username: "nyrabot" };
  it("reacts on @mention", () => {
    assert.equal(shouldReact({ text: "hey @nyrabot how are you today?" }, { type: "supergroup" }, identity), true);
  });
  it("reacts on reply to bot", () => {
    assert.equal(shouldReact({ text: "ok", reply_to_message: { from: { id: 99 } } }, { type: "group" }, identity), true);
  });
  it("ignores unrelated group chat", () => {
    assert.equal(shouldReact({ text: "hello everyone here" }, { type: "supergroup" }, identity), false);
  });
  it("exposes react_to_message tool", () => {
    const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
    assert.match(src, /react_to_message/);
  });
  it("supports_tools column is migrated", () => {
    const src = readFileSync(new URL("../src/db/schema.js", import.meta.url), "utf8");
    assert.match(src, /supports_tools/);
    assert.match(src, /seedWorkersAiCatalog/);
  });
});
