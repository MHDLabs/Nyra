import { test } from "node:test";
import assert from "node:assert/strict";
import { listFailedUpdates, replayFailedUpdate } from "../src/dlq.js";

/**
 * In-memory D1 stub for the `failed_updates` table plus the queue binding.
 * `rows` is the backing store so tests can assert on writes.
 */
function fakeEnv(rows) {
  const store = (rows || []).map(function (r) { return Object.assign({}, r); });
  const sent = [];
  return {
    store,
    sent,
    DB: {
      prepare(sql) {
        return {
          _args: [],
          bind(...args) { this._args = args; return this; },
          async first() {
            if (sql.indexOf("COUNT(*)") !== -1) return { total: store.length };
            if (sql.indexOf("SELECT error_info") !== -1) {
              const id = this._args[0];
              const row = store.filter(function (r) { return r.id === id; })[0];
              return row ? { error_info: row.error_info, replayed_at: row.replayed_at } : null;
            }
            return null;
          },
          async all() {
            const limit = this._args[0];
            const offset = this._args[1];
            return { results: store.slice(offset, offset + limit) };
          },
          async run() {
            if (sql.indexOf("UPDATE failed_updates SET replayed_at") !== -1) {
              const ts = this._args[0];
              const id = this._args[1];
              store.forEach(function (r) { if (r.id === id) r.replayed_at = ts; });
            }
            return { success: true };
          }
        };
      }
    },
    NYRA_QUEUE: {
      async send(body) { sent.push(body); }
    }
  };
}

function row(over) {
  return Object.assign({
    id: 1, update_id: 555, user_id: 7141112393, chat_id: 7141112393,
    message_text: "hello", error_info: "{}", created_at: 1735689600, replayed_at: null
  }, over || {});
}

test("listFailedUpdates returns rows, total and pagination window", async () => {
  const env = fakeEnv([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })]);
  const result = await listFailedUpdates(env, 2, 1);

  assert.equal(result.total, 3);
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 1);
  assert.equal(result.items.length, 2, "one page of 2 starting at offset 1");
  assert.deepEqual(result.items.map(function (r) { return r.id; }), [2, 3]);
});

test("listFailedUpdates exposes error_info, not just the message text", async () => {
  // Regression: `error_info` was omitted from the SELECT, so the admin DLQ view
  // could show that something failed but never why.
  const env = fakeEnv([row({ id: 7, error_info: '{"attempts":3,"reason":"timeout"}' })]);
  const { items } = await listFailedUpdates(env, 20, 0);

  assert.equal(items.length, 1);
  assert.ok(items[0].error_info, "error_info must be present in the response");
  assert.ok(items[0].error_info.indexOf("timeout") !== -1);
  assert.ok(items[0].error_info.indexOf("attempts") !== -1);
});

test("listFailedUpdates truncates oversized error_info per row", async () => {
  const huge = "x".repeat(20000);
  const env = fakeEnv([row({ id: 9, error_info: huge })]);
  const { items } = await listFailedUpdates(env, 20, 0);

  assert.ok(items[0].error_info.length <= 1000, "must not exceed the 1000 char cap");
  assert.ok(items[0].error_info.length > 0);
});

test("listFailedUpdates tolerates a missing error_info column value", async () => {
  const env = fakeEnv([row({ id: 11, error_info: null })]);
  const { items } = await listFailedUpdates(env, 20, 0);
  assert.equal(items[0].error_info, "");
});

test("listFailedUpdates on an empty table returns zero rows", async () => {
  const env = fakeEnv([]);
  const result = await listFailedUpdates(env, 50, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
});

test("replayFailedUpdate re-enqueues the stored update and stamps replayed_at", async () => {
  const body = { update_id: 555, message: { text: "hello" } };
  const env = fakeEnv([row({ id: 3, error_info: JSON.stringify({ body: body }) })]);

  const ok = await replayFailedUpdate(env, 3);

  assert.equal(ok, true);
  assert.equal(env.sent.length, 1);
  assert.deepEqual(env.sent[0], { update: body });
  assert.ok(env.store[0].replayed_at, "replayed_at must be set so it cannot loop");
});

test("replayFailedUpdate refuses a record that was already replayed", async () => {
  const body = { update_id: 555 };
  const env = fakeEnv([row({ id: 4, replayed_at: 1735689700, error_info: JSON.stringify({ body: body }) })]);

  assert.equal(await replayFailedUpdate(env, 4), false);
  assert.equal(env.sent.length, 0, "must not enqueue a second time");
});

test("replayFailedUpdate returns false for a missing record", async () => {
  const env = fakeEnv([row({ id: 1 })]);
  assert.equal(await replayFailedUpdate(env, 999), false);
  assert.equal(env.sent.length, 0);
});

test("replayFailedUpdate returns false when error_info is unparsable or has no body", async () => {
  const env = fakeEnv([
    row({ id: 20, error_info: "not-json{{" }),
    row({ id: 21, error_info: JSON.stringify({ attempts: 3 }) })
  ]);

  assert.equal(await replayFailedUpdate(env, 20), false);
  assert.equal(await replayFailedUpdate(env, 21), false);
  assert.equal(env.sent.length, 0);
});
