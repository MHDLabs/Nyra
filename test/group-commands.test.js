import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCommand } from "../src/handlers/command-parse.js";

describe("group command policy", () => {
  it("ignores commands addressed to another bot", () => {
    const r = parseCommand("/ban@OtherBot spam", { username: "nyraassisentbot" });
    assert.equal(r, null);
  });
  it("accepts commands addressed to this bot", () => {
    const r = parseCommand("/help@nyraassisentbot", { username: "nyraassisentbot" });
    assert.ok(r);
    assert.equal(r.command, "/help");
  });
  it("commands.js defines GROUP_COMMANDS allowlist", () => {
    const src = readFileSync(new URL("../src/commands.js", import.meta.url), "utf8");
    assert.match(src, /GROUP_COMMANDS/);
    assert.match(src, /if \(isGroup\) return;/);
  });
  it("onboarding version is 2 with custom_intro", () => {
    const src = readFileSync(new URL("../src/handlers/onboarding.js", import.meta.url), "utf8");
    assert.match(src, /ONBOARDING_VERSION = 2/);
    assert.match(src, /custom_intro/);
    assert.match(src, /romantic/);
  });
});
