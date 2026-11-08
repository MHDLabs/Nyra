// Chat commands: full in-chat control (Mini App optional).
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/commands.js", import.meta.url), "utf8");

describe("Commands surface", () => {
  it("registers core user commands", () => {
    for (const cmd of ["start", "help", "settings", "personality", "memory", "usage", "remember", "forget", "setname"]) {
      assert.ok(src.includes('cmd === "' + cmd + '"'), "missing " + cmd);
    }
  });

  it("registers admin panel and stats/broadcast", () => {
    assert.ok(src.includes('cmd === "admin"'));
    assert.ok(src.includes('cmd === "stats"'));
    assert.ok(src.includes('cmd === "broadcast"'));
    assert.ok(src.includes("showAdminMenu"));
  });

  it("does not force Mini App for settings", () => {
    assert.ok(src.includes("showSettingsMenu"));
    assert.ok(!src.includes("commands.legacy.moved") || src.indexOf("showSettingsMenu") < src.indexOf("commands.legacy.moved") || !src.includes("commands.legacy.moved"));
  });

  it("keeps reminder commands", () => {
    for (const cmd of ["remind", "reminders", "timezone"]) {
      assert.ok(src.includes('"' + cmd + '"'), "missing reminder " + cmd);
    }
  });
});
