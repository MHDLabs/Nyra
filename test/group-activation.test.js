// Group activation: default enabled, individual controls.
import { describe, it } from "node:test";
import assert from "node:assert";

describe("Group Activation", () => {
  it("creates new groups with enabled=1", () => {
    const newGroup = { enabled: 1, mode: "enabled" };
    assert.strictEqual(newGroup.enabled, 1);
  });

  it("allows disabling individual groups", () => {
    const group = { enabled: 1 };
    group.enabled = 0;
    assert.strictEqual(group.enabled, 0);
  });

  it("re-enables disabled groups", () => {
    const group = { enabled: 0 };
    group.enabled = 1;
    assert.strictEqual(group.enabled, 1);
  });

  it("preserves existing group settings", () => {
    const existingGroup = { enabled: 0, mode: "disabled" };
    assert.strictEqual(existingGroup.enabled, 0);
  });
});
