import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWebhook } from "../src/handlers/webhook.js";

function mockEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_SECRET: "webhook-secret-token-value",
    ENCRYPTION_KEY: Buffer.from("0".repeat(32)).toString("base64"),
    NYRA_QUEUE: {
      async send() {
        (overrides.sent || (overrides.sent = [])).push(true);
      }
    },
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return { update_id: 1 };
          },
          async run() {
            return { meta: { changes: 1 } };
          }
        };
      }
    },
    KV: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {}
    },
    ...overrides
  };
}

test("handleWebhook rejects missing secret", async () => {
  const res = await handleWebhook(new Request("https://example.com/webhook", { method: "POST", body: "{}" }), mockEnv(), {});
  assert.equal(res.status, 401);
});

test("handleWebhook rejects wrong secret", async () => {
  const res = await handleWebhook(
    new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "nope", "Content-Type": "application/json" },
      body: "{}"
    }),
    mockEnv(),
    {}
  );
  assert.equal(res.status, 401);
});

test("handleWebhook rejects invalid JSON body", async () => {
  // getWebhookSecret derives from TELEGRAM_SECRET / env — use crypto path via real getWebhookSecret
  const { getWebhookSecret } = await import("../src/crypto.js");
  const env = mockEnv();
  const expected = await getWebhookSecret(env);
  assert.ok(expected);
  const res = await handleWebhook(
    new Request("https://example.com/webhook", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": expected,
        "Content-Type": "application/json"
      },
      body: "not-json"
    }),
    env,
    {}
  );
  assert.equal(res.status, 400);
});
