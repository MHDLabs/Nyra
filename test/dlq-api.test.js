import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminFailedUpdates, handleReplayFailedUpdate } from "../src/miniapp/dlq-api.js";

function mockEnv(overrides = {}) {
  const store = overrides.store || [];
  return {
    ADMIN_IDS: "1",
    DB: {
      prepare(sql) {
        return {
          _args: [],
          bind(...args) {
            this._args = args;
            return this;
          },
          async first() {
            if (sql.includes("COUNT(*)")) return { total: store.length };
            if (sql.includes("SELECT error_info")) {
              const id = this._args[0];
              const row = store.find((r) => r.id === id);
              return row ? { error_info: row.error_info, replayed_at: row.replayed_at || null } : null;
            }
            return null;
          },
          async all() {
            const limit = this._args[0];
            const offset = this._args[1];
            return { results: store.slice(offset, offset + limit) };
          },
          async run() {
            if (sql.includes("UPDATE")) {
              const id = this._args[1];
              store.forEach((r) => {
                if (r.id === id) r.replayed_at = this._args[0];
              });
            }
            return { meta: { changes: 1 } };
          }
        };
      }
    },
    NYRA_QUEUE: {
      async send(body) {
        (overrides.sent || (overrides.sent = [])).push(body);
      }
    },
    ...overrides
  };
}

async function readJson(res) {
  return { status: res.status, body: await res.json() };
}

test("handleAdminFailedUpdates defaults page 0 limit 50", async () => {
  const env = mockEnv({ store: [] });
  const { status, body } = await readJson(await handleAdminFailedUpdates(env));
  assert.equal(status, 200);
  assert.equal(body.limit, 50);
  assert.equal(body.offset, 0);
  assert.deepEqual(body.items, []);
});

test("handleAdminFailedUpdates accepts valid page and limit", async () => {
  const env = mockEnv({ store: [{ id: 1, message_text: "a", error_info: "{}", created_at: 1 }] });
  const { status, body } = await readJson(await handleAdminFailedUpdates(env, 1, 10));
  assert.equal(status, 200);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 10);
});

test("handleAdminFailedUpdates rejects invalid page values", async () => {
  const env = mockEnv();
  for (const page of [-1, 1.5, "x", NaN, Infinity, -Infinity]) {
    const { status, body } = await readJson(await handleAdminFailedUpdates(env, page, 50));
    assert.equal(status, 400, String(page));
    assert.equal(body.error, "Invalid page");
  }
});

test("handleAdminFailedUpdates rejects invalid limit and clamps max", async () => {
  const env = mockEnv({ store: [] });
  assert.equal((await readJson(await handleAdminFailedUpdates(env, 0, 0))).status, 400);
  assert.equal((await readJson(await handleAdminFailedUpdates(env, 0, -3))).status, 400);
  assert.equal((await readJson(await handleAdminFailedUpdates(env, 0, 1.2))).status, 400);
  const { status, body } = await readJson(await handleAdminFailedUpdates(env, 0, 500));
  assert.equal(status, 200);
  assert.equal(body.limit, 200);
});

test("handleAdminFailedUpdates rejects offset overflow page", async () => {
  const env = mockEnv();
  const hugePage = Number.MAX_SAFE_INTEGER;
  const { status } = await readJson(await handleAdminFailedUpdates(env, hugePage, 50));
  assert.equal(status, 400);
});

test("handleReplayFailedUpdate accepts numeric and digit-string ids", async () => {
  const body = { update_id: 9 };
  const store = [{ id: 7, error_info: JSON.stringify({ body }), replayed_at: null }];
  const env = mockEnv({ store });
  const a = await readJson(await handleReplayFailedUpdate(env, 7));
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { success: true });

  const store2 = [{ id: 8, error_info: JSON.stringify({ body }), replayed_at: null }];
  const env2 = mockEnv({ store: store2 });
  const b = await readJson(await handleReplayFailedUpdate(env2, "8"));
  assert.equal(b.status, 200);
  assert.deepEqual(b.body, { success: true });
});

test("handleReplayFailedUpdate rejects bad ids", async () => {
  const env = mockEnv();
  for (const id of [null, undefined, "", 0, -1, 1.5, "x", NaN, Infinity]) {
    const { status, body } = await readJson(await handleReplayFailedUpdate(env, id));
    assert.equal(status, 400, String(id));
    assert.equal(body.error, "Missing id");
  }
});

test("list and replay exceptions never leak internal messages", async () => {
  const env = {
    ADMIN_IDS: "1",
    DB: {
      prepare() {
        throw new Error("D1_ERROR: SQLITE_ERROR no such table failed_updates");
      }
    },
    NYRA_QUEUE: { async send() {} }
  };
  const list = await readJson(await handleAdminFailedUpdates(env, 0, 50));
  assert.equal(list.status, 500);
  assert.equal(list.body.error, "Failed to load failed updates");
  assert.ok(!JSON.stringify(list.body).includes("SQLITE"));

  const replay = await readJson(await handleReplayFailedUpdate(env, 1));
  assert.equal(replay.status, 500);
  assert.equal(replay.body.error, "Failed to replay update");
  assert.ok(!JSON.stringify(replay.body).includes("D1_ERROR"));
});
