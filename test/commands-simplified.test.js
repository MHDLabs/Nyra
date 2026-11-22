// Chat commands: retained text-chat and administration surface.
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8");

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

  it("does not expose removed reminder or model-management commands", () => {
    for (const feature of ["remind", "reminders", "timezone", "active_connection_id", "adm:conns", "mypersonal"]) {
      assert.ok(!src.includes(feature), "unexpected legacy feature " + feature);
    }
  });

  it("does not advertise the removed reminders command in Telegram", () => {
    const telegram = readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
    assert.doesNotMatch(telegram, /command:\s*"reminders"/);
  });
});
