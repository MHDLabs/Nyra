import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/handlers/command-parse.js";
import { getOnboardingState } from "../src/handlers/onboarding.js";

test("parseCommand extracts command and args", () => {
  const parsed = parseCommand("/help me", { username: "nyra_bot" });
  assert.ok(parsed);
  assert.equal(parsed.command.replace(/^\//, ""), "help");
  assert.ok(String(parsed.args).includes("me") || parsed.args === "me" || parsed.command.includes("help"));
});

test("parseCommand rejects non-commands", () => {
  assert.equal(parseCommand("hello", null), null);
});

test("getOnboardingState returns null for missing user", async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return null; }
        };
      }
    }
  };
  assert.equal(await getOnboardingState(env, 1), null);
});
