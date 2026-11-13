import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("admin block helpers", () => {
  it("users.js exposes blockUser with blocked_at/blocked_by columns", () => {
    const src = readFileSync(new URL("../src/db/users.js", import.meta.url), "utf8");
    assert.match(src, /export async function blockUser/);
    assert.match(src, /blocked_at, blocked_by/);
    assert.doesNotMatch(src, /INSERT OR IGNORE INTO blocked_users \(telegram_id, created_at\)/);
  });

  it("admin-panel router uses blockUser helper", () => {
    const src = readFileSync(new URL("../src/admin-panel/router.js", import.meta.url), "utf8");
    assert.match(src, /blockUser\(env/);
    assert.doesNotMatch(src, /created_at\) VALUES/);
  });

  it("createSession refuses missing KV", () => {
    const src = readFileSync(new URL("../src/admin-panel/auth.js", import.meta.url), "utf8");
    assert.match(src, /KV_UNAVAILABLE/);
    assert.match(src, /if \(!env\.KV\) throw/);
  });
});
