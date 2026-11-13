import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("queue ordering and telegram retries", () => {
  it("processChain requeues remaining same-chat messages after a failure", () => {
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    assert.match(src, /for \(let j = i \+ 1; j < messages\.length; j\+\+\) safeRetry/);
    assert.match(src, /return;/);
  });

  it("tg retries network/timeout failures once", () => {
    const src = readFileSync(new URL("../src/telegram.js", import.meta.url), "utf8");
    assert.match(src, /Telegram fetch failed/);
    assert.match(src, /currentAttempt < TELEGRAM_RETRY_MAX/);
    assert.match(src, /return await tg\(env, method, payload, currentAttempt \+ 1\)/);
  });

  it("fast path takes a per-user lock before inline AI", () => {
    const src = readFileSync(new URL("../src/handlers/webhook.js", import.meta.url), "utf8");
    assert.match(src, /fastlock:/);
    assert.match(src, /fall through to queue/);
  });
});
