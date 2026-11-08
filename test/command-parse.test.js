import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, getMessageText } from "../src/handlers/command-parse.js";

test("parseCommand: plain /start", () => {
  const r = parseCommand("/start");
  assert.equal(r.command, "/start");
  assert.equal(r.args, "");
});

test("parseCommand: deep-link payload", () => {
  const r = parseCommand("/start ref_abc123");
  assert.equal(r.command, "/start");
  assert.equal(r.args, "ref_abc123");
});

test("parseCommand: /cmd@BotName with matching identity", () => {
  const r = parseCommand("/help@NyraBot more args here", { username: "NyraBot" });
  assert.equal(r.command, "/help");
  assert.equal(r.args, "more args here");
});

test("parseCommand: ignores command addressed to another bot", () => {
  const r = parseCommand("/help@OtherBot", { username: "NyraBot" });
  assert.equal(r, null);
});

test("parseCommand: entity-based bot_command", () => {
  const message = {
    text: "/start@NyraBot campaign_42",
    entities: [{ type: "bot_command", offset: 0, length: "/start@NyraBot".length }]
  };
  const r = parseCommand(message, { username: "NyraBot" });
  assert.equal(r.command, "/start");
  assert.equal(r.args, "campaign_42");
});

test("parseCommand: caption + caption_entities (media caption command)", () => {
  const message = {
    caption: "/remember buy milk",
    caption_entities: [{ type: "bot_command", offset: 0, length: "/remember".length }],
    photo: [{ file_id: "x" }]
  };
  const r = parseCommand(message, null);
  assert.equal(r.command, "/remember");
  assert.equal(r.args, "buy milk");
});

test("parseCommand: non-command text returns null", () => {
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(null), null);
});

test("getMessageText prefers text then caption", () => {
  assert.equal(getMessageText({ text: " a ", caption: "b" }), "a");
  assert.equal(getMessageText({ caption: "  cap  " }), "cap");
  assert.equal(getMessageText({}), "");
});
