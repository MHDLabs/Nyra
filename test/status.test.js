import { test } from "node:test";
import assert from "node:assert/strict";
import { handleStatus } from "../src/handlers/status.js";
import { checkMemoryRate } from "../src/utils.js";

test("status rate-limit key rejects after burst via shared helper", () => {
  const key = "status:203.0.113.55";
  let blocked = false;
  for (let i = 0; i < 35; i++) {
    if (!checkMemoryRate(key, 30, 60000)) {
      blocked = true;
      break;
    }
  }
  assert.equal(blocked, true);
});

test("handleStatus returns plain text body with secrets section", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_SECRET: "",
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
  assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  const text = await res.text();
  assert.ok(text.includes("Nyra is running."));
  assert.ok(text.includes("Secrets:"));
  assert.ok(text.includes("MISSING/INVALID"));
  assert.ok(text.includes("Admin commands are disabled"));
  assert.ok(text.includes("Queue:"));
});

test("handleStatus reports configured admins", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_SECRET: "",
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
    new Request("https://example.com/status", { headers: { "CF-Connecting-IP": "203.0.113.11" } }),
    env,
    { valid: ["1", "2"], invalid: ["x"], configured: true }
  );
  const text = await res.text();
  assert.ok(text.includes("2 configured"));
  assert.ok(text.includes("non-numeric"));
  assert.ok(text.includes("Send /start"));
});
