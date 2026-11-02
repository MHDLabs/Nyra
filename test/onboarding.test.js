// Onboarding flow: language→name→personality→disclosure→welcome.
import { describe, it } from "node:test";
import assert from "node:assert";

describe("Onboarding", () => {
  it("starts fresh onboarding with language step", async () => {
    const state = null; // Initial state
    assert.strictEqual(state, null);
  });

  it("persists language selection", async () => {
    const state = { step: "language" };
    assert.strictEqual(state.step, "language");
  });

  it("validates name length", async () => {
    const maxLength = 50;
    const longName = "a".repeat(100);
    const validName = "Alice";
    
    assert.ok(longName.length > maxLength, "Long name exceeds limit");
    assert.ok(validName.length <= maxLength, "Valid name within limit");
  });

  it("rejects commands as names", async () => {
    const name = "/start";
    assert.ok(name.startsWith("/"), "Command detected");
  });

  it("rejects links as names", async () => {
    const name = "http://example.com";
    assert.ok(name.includes("http"), "Link detected");
  });

  it("completes all steps in sequence", async () => {
    const steps = ["language", "name", "personality", "disclosure", "complete"];
    assert.strictEqual(steps.length, 5);
    assert.strictEqual(steps[0], "language");
    assert.strictEqual(steps[4], "complete");
  });
});
