import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGroupTrigger } from "../src/db/users.js";
import { readFileSync } from "node:fs";

describe("configurable group triggers", () => {
  const identity = { id: 1, username: "nyrabot" };
  const replyMsg = {
    text: "hi",
    reply_to_message: { from: { id: 1 }, message_id: 9 },
    message_id: 10
  };

  it("respects master off", () => {
    const r = isGroupTrigger({ text: "نیرا hello" }, identity, { enabled: false, reply: true, mention: true, words: ["نیرا"] });
    assert.equal(r.trigger, false);
  });

  it("matches custom words", () => {
    const r = isGroupTrigger({ text: "hey assistant please" }, identity, { enabled: true, reply: true, mention: true, words: ["assistant"] });
    assert.equal(r.trigger, true);
    assert.equal(r.mode, "call");
  });

  it("can disable reply trigger", () => {
    const r = isGroupTrigger(replyMsg, identity, { enabled: true, reply: false, mention: true, words: [] });
    assert.equal(r.trigger, false);
  });

  it("guest prefix helper exists", () => {
    const src = readFileSync(new URL("../src/handlers/ai-message.js", import.meta.url), "utf8");
    assert.match(src, /Guest mode/);
    assert.match(src, /prefixGuestChunks/);
  });
});
