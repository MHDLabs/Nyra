import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBroadcastTargets, startBroadcast, pauseBroadcast,
  resumeBroadcast, cancelBroadcast, createBroadcast
} from "../src/broadcast.js";

const ADMIN_ID = 7141112393;
const OTHER_ID = 111222333;

/**
 * D1 stub covering the broadcast queries. `targets` seeds whichever recipient
 * query runs; `log` records every statement so tests can assert on the SQL and
 * on the resulting counter updates.
 */
function fakeEnv(opts) {
  const o = opts || {};
  const targetRows = o.targets !== undefined ? o.targets : [{ telegram_id: 1 }, { telegram_id: 2 }];
  const state = {
    broadcast: o.broadcast !== undefined ? o.broadcast : {
      broadcast_id: "b1", created_by: ADMIN_ID, message: "hello",
      target_type: "all_users", target_filter: null,
      status: "draft", total_count: 0, sent_count: 0, failed_count: 0
    },
    pending: targetRows.slice()
  };
  const log = [];
  const batched = [];

  return {
    state, log, batched,
    ADMIN_IDS: String(ADMIN_ID),
    KV: { async get() { return null; }, async put() {} },
    DB: {
      prepare(sql) {
        const norm = sql.replace(/\s+/g, " ").trim();
        return {
          _args: [],
          bind(...args) { this._args = args; return this; },
          async first() {
            log.push({ sql: norm, args: this._args });
            if (norm.indexOf("FROM broadcasts WHERE broadcast_id") !== -1) return state.broadcast;
            return null;
          },
          async all() {
            log.push({ sql: norm, args: this._args });
            // Recipient scan inside processBroadcast.
            if (norm.indexOf("FROM broadcast_recipients") !== -1) {
              return { results: state.pending.splice(0, state.pending.length) };
            }
            // Target selection inside calculateBroadcastTargets.
            if (norm.indexOf("FROM users") !== -1 || norm.indexOf("FROM chats") !== -1) {
              return { results: targetRows.slice() };
            }
            return { results: o.rows || [] };
          },
          async run() {
            log.push({ sql: norm, args: this._args });
            if (norm.indexOf("UPDATE broadcasts SET status = 'running'") !== -1) {
              // `pauseAfterStart` simulates an admin pausing the campaign the
              // moment it went live, before the background processor looks at it.
              state.broadcast.status = o.pauseAfterStart ? "paused" : "running";
              state.broadcast.total_count = this._args[0];
            } else if (norm.indexOf("UPDATE broadcasts SET status = 'completed'") !== -1) {
              state.broadcast.status = "completed";
            } else if (norm.indexOf("UPDATE broadcasts SET status = 'paused'") !== -1) {
              state.broadcast.status = "paused";
            } else if (norm.indexOf("UPDATE broadcasts SET status = 'cancelled'") !== -1) {
              state.broadcast.status = "cancelled";
            } else if (norm.indexOf("UPDATE broadcasts SET sent_count = sent_count + 1") !== -1) {
              state.broadcast.sent_count += 1;
            } else if (norm.indexOf("UPDATE broadcasts SET failed_count = failed_count + 1") !== -1) {
              state.broadcast.failed_count += 1;
            }
            return { success: true };
          }
        };
      },
      async batch(stmts) {
        batched.push(stmts);
        return stmts.map(function () { return { success: true }; });
      }
    },
    // createBroadcast / startBroadcast do not touch Telegram; only
    // processBroadcast does, through the global fetch.
    NYRA_QUEUE: { async send() {} }
  };
}

/** Run `fn` with the global fetch replaced, restoring it afterwards. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function okFetch() {
  return async function () {
    return { ok: true, async json() { return { ok: true, result: { message_id: 1 } }; } };
  };
}

function failFetch() {
  return async function () {
    return { ok: true, async json() { return { ok: false, error_code: 400, description: "chat not found" }; } };
  };
}

// --- calculateBroadcastTargets -------------------------------------------

test("all_users excludes blocked users without referencing a users.enabled column", async () => {
  const env = fakeEnv();
  await calculateBroadcastTargets(env, "all_users", null);

  const q = env.log[0].sql;
  assert.ok(q.indexOf("FROM users") !== -1, q);
  assert.ok(q.indexOf("blocked_users") !== -1, "must exclude blocked users: " + q);
  // Regression: `users` has no `enabled` column — the old query threw for
  // every broadcast.
  assert.equal(q.indexOf("users WHERE enabled"), -1, "must not filter on users.enabled: " + q);
});

test("all_chats only targets enabled groups and supergroups", async () => {
  const env = fakeEnv();
  await calculateBroadcastTargets(env, "all_chats", null);

  const q = env.log[0].sql;
  assert.ok(q.indexOf("FROM chats") !== -1, q);
  assert.ok(q.indexOf("enabled = 1") !== -1, "chats does have an enabled column: " + q);
  assert.ok(q.indexOf("'group'") !== -1 && q.indexOf("'supergroup'") !== -1, q);
});

test("active_users applies a seconds-resolution cutoff and dedupes", async () => {
  const env = fakeEnv();
  const before = Math.floor(Date.now() / 1000);
  await calculateBroadcastTargets(env, "active_users", null);
  const after = Math.floor(Date.now() / 1000);

  const q = env.log[0].sql;
  assert.ok(q.indexOf("SELECT DISTINCT") !== -1, "must dedupe: " + q);
  assert.ok(q.indexOf("last_seen_at > ?") !== -1, q);

  // `now()` returns SECONDS; a millisecond cutoff would sit ~55 years in the
  // future and match every row.
  const cutoff = env.log[0].args[0];
  const thirtyDaysAgo = before - 30 * 24 * 60 * 60;
  assert.ok(cutoff >= thirtyDaysAgo - 5 && cutoff <= after - 30 * 24 * 60 * 60 + 5,
    "cutoff must be ~30 days before now in seconds, got " + cutoff);
  assert.ok(cutoff < Date.now(), "a millisecond cutoff would exceed Date.now(): " + cutoff);
});

test("calculateBroadcastTargets rejects an unknown target type", async () => {
  await assert.rejects(
    () => calculateBroadcastTargets(fakeEnv(), "everyone", null),
    /Invalid target type/
  );
});

test("calculateBroadcastTargets returns an empty array when nothing matches", async () => {
  const env = fakeEnv({ targets: [] });
  const rows = await calculateBroadcastTargets(env, "all_users", null);
  assert.deepEqual(rows, []);
});

// --- authorization --------------------------------------------------------

test("createBroadcast throws Unauthorized for a non-admin", async () => {
  await assert.rejects(
    () => createBroadcast(fakeEnv(), OTHER_ID, "hi", "all_users", null),
    /Unauthorized/
  );
});

test("startBroadcast throws Unauthorized for a non-admin", async () => {
  await assert.rejects(
    () => startBroadcast(fakeEnv(), { waitUntil() {} }, "b1", OTHER_ID),
    /Unauthorized/
  );
});

test("pause/resume/cancel all require admin rights", async () => {
  for (const fn of [pauseBroadcast, resumeBroadcast, cancelBroadcast]) {
    await assert.rejects(() => fn(fakeEnv(), "b1", OTHER_ID), /Unauthorized/, fn.name);
  }
});

test("startBroadcast rejects a missing broadcast", async () => {
  const env = fakeEnv({ broadcast: null });
  await assert.rejects(
    () => startBroadcast(env, { waitUntil() {} }, "nope", ADMIN_ID),
    /Broadcast not found/
  );
});

test("startBroadcast refuses a campaign that is not a draft", async () => {
  const env = fakeEnv({ broadcast: { broadcast_id: "b1", status: "running", target_type: "all_users" } });
  await assert.rejects(
    () => startBroadcast(env, { waitUntil() {} }, "b1", ADMIN_ID),
    /already started/
  );
});

test("startBroadcast bails out when there are no recipients", async () => {
  const env = fakeEnv({ targets: [] });
  await assert.rejects(
    () => startBroadcast(env, { waitUntil() {} }, "b1", ADMIN_ID),
    /No recipients found/
  );
});

test("pauseBroadcast refuses a campaign that is not running", async () => {
  const env = fakeEnv({ broadcast: { broadcast_id: "b1", status: "draft" } });
  await assert.rejects(() => pauseBroadcast(env, "b1", ADMIN_ID), /not running/);
});

test("resumeBroadcast refuses a campaign that is not paused", async () => {
  const env = fakeEnv({ broadcast: { broadcast_id: "b1", status: "running" } });
  await assert.rejects(
    () => resumeBroadcast(env, { waitUntil() {} }, "b1", ADMIN_ID),
    /not paused/
  );
});

// --- startBroadcast + processBroadcast ------------------------------------

test("startBroadcast marks the campaign running and inserts every recipient", async () => {
  const env = fakeEnv();
  let queued = null;
  const ctx = { waitUntil(p) { queued = p; } };

  const result = await withFetch(okFetch(), async () => {
    const r = await startBroadcast(env, ctx, "b1", ADMIN_ID);
    await queued; // drain inside the stub so nothing escapes to the network
    return r;
  });

  assert.equal(result.totalCount, 2);
  assert.equal(env.state.broadcast.status, "completed");
  assert.equal(env.state.broadcast.total_count, 2);
  assert.equal(env.batched.length, 1, "recipients are inserted through DB.batch");
  assert.equal(env.batched[0].length, 2);
  assert.ok(queued, "processing is handed to ctx.waitUntil");
});

test("processBroadcast records a successful send as sent, not failed", async () => {
  // Regression: `sendMessage` resolves to a BOOLEAN, so the old `result.ok`
  // check was always falsy and every recipient was counted as a failure.
  const env = fakeEnv();
  let queued = null;
  const ctx = { waitUntil(p) { queued = p; } };

  // The queue must be drained while the stubbed fetch is still installed —
  // otherwise the background processor escapes to the real network.
  await withFetch(okFetch(), async () => {
    await startBroadcast(env, ctx, "b1", ADMIN_ID);
    await queued;
  });

  assert.equal(env.state.broadcast.sent_count, 2, "both recipients sent");
  assert.equal(env.state.broadcast.failed_count, 0, "nothing failed");
  assert.equal(env.state.broadcast.status, "completed");

  const sentUpdates = env.log.filter(function (l) {
    return l.sql.indexOf("SET status = 'sent'") !== -1;
  });
  assert.equal(sentUpdates.length, 2, "each recipient row is stamped sent");
});

test("processBroadcast records a rejected send as failed", async () => {
  const env = fakeEnv();
  let queued = null;
  const ctx = { waitUntil(p) { queued = p; } };

  await withFetch(failFetch(), async () => {
    await startBroadcast(env, ctx, "b1", ADMIN_ID);
    await queued;
  });

  assert.equal(env.state.broadcast.sent_count, 0);
  assert.equal(env.state.broadcast.failed_count, 2, "a Telegram error must count as failed");
  assert.equal(env.state.broadcast.status, "completed");
});

test("processBroadcast stops when the campaign is paused mid-flight", async () => {
  const env = fakeEnv({ pauseAfterStart: true });
  let queued = null;
  const ctx = { waitUntil(p) { queued = p; } };

  await withFetch(okFetch(), async () => {
    await startBroadcast(env, ctx, "b1", ADMIN_ID);
    await queued;
  });

  assert.equal(env.state.broadcast.status, "paused", "a paused campaign is left alone");
  assert.equal(env.state.broadcast.sent_count, 0, "nothing is sent after the pause");
});

test("cancelBroadcast only cancels a cancellable campaign", async () => {
  const env = fakeEnv({ broadcast: { broadcast_id: "b1", status: "draft" } });
  const res = await cancelBroadcast(env, "b1", ADMIN_ID);
  assert.deepEqual(res, { success: true });
  assert.equal(env.state.broadcast.status, "cancelled");
});
