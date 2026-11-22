import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { notifyAdminOnError } from "../src/providers/agent.js";

test("central API key is redacted from administrator error notifications", async () => {
  const secret = "central-private-key-123456789";
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const env = {
      ADMIN_IDS: "123456",
      TELEGRAM_BOT_TOKEN: "telegram-test-token",
      AI_API_KEY: secret,
      AI_MODEL: "central-test-model",
      KV: {
        async get() { return null; },
        async put() { return true; }
      }
    };
    await notifyAdminOnError(env, {
      category: "provider_error",
      raw_error: "Provider rejected request using key " + secret + "; Authorization: Bearer " + secret
    });
    assert.equal(sent.length, 1);
    const body = JSON.stringify(sent[0].body);
    assert.equal(body.includes(secret), false, "central credential must not be included in Telegram admin alert");
    assert.ok(body.includes("[REDACTED]"), "the provider error should be visibly redacted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web admin API selects no provider credential fields for user details", () => {
  const router = readFileSync(new URL("../src/admin-panel/router.ts", import.meta.url), "utf8");
  const detailStart = router.indexOf('if (userMatch && request.method === "GET")');
  const detailEnd = router.indexOf('// PATCH /admin-api/users/:id', detailStart);
  assert.ok(detailStart >= 0 && detailEnd > detailStart);
  const handler = router.slice(detailStart, detailEnd);
  assert.doesNotMatch(handler, /ai_connections|encrypted_key|key_iv|api_key|AI_API_KEY/i);
  assert.match(handler, /memory_data/);
  assert.match(handler, /usage_stats/);
});

test("web admin UI does not receive central API credentials", () => {
  const client = readFileSync(new URL("../public/admin-panel/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(client, /AI_API_KEY|encrypted_key|key_iv/i);
});
