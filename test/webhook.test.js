import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWebhook } from "../src/handlers/webhook.js";
import { getWebhookSecret } from "../src/crypto.js";

function baseEnv(overrides = {}) {
  const sent = overrides.sent || [];
  const inserts = overrides.inserts || [];
  const deletes = overrides.deletes || [];
  return {
    TELEGRAM_BOT_TOKEN: "1:TEST",
    TELEGRAM_SECRET: "webhook-secret-token-value",
    NYRA_QUEUE: {
      async send(body) {
        if (overrides.queueError) throw new Error("queue down");
        sent.push(body);
      }
    },
    DB: {
      prepare(sql) {
        return {
          _sql: sql,
          bind(...args) {
            this._args = args;
            return this;
          },
          async first() {
            if (String(this._sql).includes("INSERT INTO processed_updates")) {
              inserts.push(this._args);
              if (overrides.duplicate) return null;
              return { update_id: this._args[0] };
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (String(this._sql).includes("DELETE FROM processed_updates")) {
              deletes.push(this._args);
            }
            return { meta: { changes: 1 } };
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
    },
    sent,
    inserts,
    deletes,
    ...overrides
  };
}

async function authedRequest(env, body, extraHeaders = {}) {
  const expected = await getWebhookSecret(env);
  const headers = {
    "X-Telegram-Bot-Api-Secret-Token": expected,
    "Content-Type": "application/json",
    ...extraHeaders
  };
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://example.com/webhook", { method: "POST", headers, body: payload });
}

test("handleWebhook rejects missing secret", async () => {
  const res = await handleWebhook(new Request("https://example.com/webhook", { method: "POST", body: "{}" }), baseEnv(), {});
  assert.equal(res.status, 401);
});

test("handleWebhook rejects wrong secret", async () => {
  const res = await handleWebhook(
    new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "nope", "Content-Type": "application/json" },
      body: "{}"
    }),
    baseEnv(),
    {}
  );
  assert.equal(res.status, 401);
});

test("handleWebhook rejects invalid JSON body", async () => {
  const env = baseEnv();
  const res = await handleWebhook(await authedRequest(env, "not-json"), env, {});
  assert.equal(res.status, 400);
});

test("handleWebhook rejects malformed update envelope", async () => {
  const env = baseEnv();
  const res = await handleWebhook(await authedRequest(env, { foo: 1 }), env, {});
  assert.equal(res.status, 400);
});

test("handleWebhook rejects non-finite update_id", async () => {
  const env = baseEnv();
  const res = await handleWebhook(await authedRequest(env, { update_id: "x" }), env, {});
  assert.equal(res.status, 400);
});

test("handleWebhook rejects malformed message on update", async () => {
  const env = baseEnv();
  const res = await handleWebhook(
    await authedRequest(env, { update_id: 1, message: { message_id: 1 } }),
    env,
    {}
  );
  assert.equal(res.status, 400);
});

test("handleWebhook enqueues valid non-command message", async () => {
  const env = baseEnv();
  const body = {
    update_id: 42,
    message: {
      message_id: 7,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false },
      text: "hello"
    }
  };
  const res = await handleWebhook(await authedRequest(env, body), env, {});
  assert.equal(res.status, 200);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].update.update_id, 42);
  assert.equal(env.inserts.length, 1);
});

test("handleWebhook acks duplicate update without re-enqueue", async () => {
  const env = baseEnv({ duplicate: true });
  const body = {
    update_id: 42,
    message: {
      message_id: 7,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false },
      text: "hello"
    }
  };
  const res = await handleWebhook(await authedRequest(env, body), env, {});
  assert.equal(res.status, 200);
  assert.equal(env.sent.length, 0);
});

test("handleWebhook rolls back dedup when queue enqueue fails", async () => {
  const env = baseEnv({ queueError: true });
  const body = {
    update_id: 99,
    message: {
      message_id: 7,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false },
      text: "hello"
    }
  };
  const res = await handleWebhook(await authedRequest(env, body), env, {});
  assert.equal(res.status, 503);
  assert.equal(env.deletes.length, 1);
  assert.equal(env.deletes[0][0], 99);
});
