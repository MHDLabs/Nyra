import { test } from "node:test";
import assert from "node:assert/strict";
import { handleStatus } from "../src/handlers/status.js";

test("handleStatus rate-limits excessive callers", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_SECRET: "secret",
    ENCRYPTION_KEY: Buffer.from("0".repeat(32)).toString("base64"),
    ADMIN_IDS: "1",
    NYRA_QUEUE: {},
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 0 } };
          }
        };
      },
      async batch() {
        return [];
      }
    },
    KV: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {}
    }
  };
  // Bypass real telegram by emptying token after first path? ensureWebhook checks token.
  // Call many times with same IP to hit rate limit.
  const adminIds = { valid: ["1"], invalid: [], configured: true };
  let last = null;
  for (let i = 0; i < 35; i++) {
    last = await handleStatus(
      new Request("https://example.com/status", { headers: { "CF-Connecting-IP": "203.0.113.9" } }),
      env,
      adminIds
    );
  }
  assert.equal(last.status, 429);
});

test("handleStatus returns plain text body with secrets section", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_SECRET: "",
    ENCRYPTION_KEY: "bad",
    ADMIN_IDS: "",
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 0 } };
          }
        };
      },
      async batch() {
        return [];
      }
    },
    KV: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {}
    }
  };
  const res = await handleStatus(
    new Request("https://example.com/status", { headers: { "CF-Connecting-IP": "203.0.113.10" } }),
    env,
    { valid: [], invalid: [], configured: false }
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("Nyra is running."));
  assert.ok(text.includes("Secrets:"));
  assert.ok(text.includes("MISSING/INVALID") || text.includes("ok"));
  assert.ok(text.includes("Admin commands are disabled"));
});
