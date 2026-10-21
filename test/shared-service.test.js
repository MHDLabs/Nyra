import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSharedConnection, reserveSharedRequest, recordSharedTokenUsage,
  getSharedUsage, sharedQuotaMessage, todayUTC
} from "../src/db.js";

/**
 * Minimal D1 stub supporting the exact statements the shared-service helpers
 * issue. `settings` is a plain Map so a test can flip the kill switch.
 */
function fakeEnv(opts) {
  const o = opts || {};
  const settings = new Map(Object.entries(o.settings || {}));
  const usage = new Map(); // `${id}|${date}` -> { requests_count, tokens_used }
  let failOnUpdate = false;
  return {
    usage,
    settings,
    setFailUpdate(v) { failOnUpdate = !!v; },
    DB: {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async first() {
            if (sql.indexOf("FROM app_settings") !== -1) {
              const key = stmt._args[0];
              return settings.has(key) ? { value: settings.get(key) } : null;
            }
            if (sql.indexOf("FROM shared_service_usage") !== -1) {
              const row = usage.get(stmt._args[0] + "|" + stmt._args[1]);
              return row ? { requests_count: row.requests_count, tokens_used: row.tokens_used } : null;
            }
            return null;
          },
          async run() {
            const key = stmt._args[0] + "|" + stmt._args[1];
            const row = usage.get(key) || { requests_count: 0, tokens_used: 0 };
            if (sql.indexOf("INSERT INTO shared_service_usage") !== -1) {
              if (sql.indexOf("tokens_used) VALUES (?, ?, 0, ?)") !== -1) {
                row.tokens_used += Number(stmt._args[2]) || 0;
              }
              usage.set(key, row);
              return { meta: { changes: 1 } };
            }
            if (sql.indexOf("UPDATE shared_service_usage SET requests_count = requests_count + 1") !== -1) {
              if (failOnUpdate) throw new Error("D1 unavailable");
              // args: userId, date, limit, limit
              const limit = Number(stmt._args[2]);
              if (limit !== 0 && row.requests_count >= limit) return { meta: { changes: 0 } };
              row.requests_count += 1;
              usage.set(key, row);
              return { meta: { changes: 1 } };
            }
            if (sql.indexOf("requests_count = MAX(requests_count - 1, 0)") !== -1) {
              row.requests_count = Math.max(row.requests_count - 1, 0);
              usage.set(key, row);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
        };
        return stmt;
      }
    }
  };
}

const GLOBAL = { is_global: 1, telegram_id: 1 };

test("isSharedConnection only counts someone else's global connection", () => {
  assert.equal(isSharedConnection(GLOBAL, 42), true);
  assert.equal(isSharedConnection(GLOBAL, 1), false, "owner's own connection is not shared");
  assert.equal(isSharedConnection({ is_global: 0, telegram_id: 1 }, 42), false);
  assert.equal(isSharedConnection(null, 42), false);
});

test("own connections bypass the shared quota entirely", async () => {
  const env = fakeEnv({ settings: { shared_daily_request_limit: "0" } });
  const res = await reserveSharedRequest(env, 42, { is_global: 0, telegram_id: 42 });
  assert.equal(res.allowed, true);
  assert.equal(res.shared, false);
  assert.equal(env.usage.size, 0, "no counter row is touched");
});

test("shared service is OFF unless an admin explicitly enables it", async () => {
  // Default deployment: no setting row at all must still refuse shared credit.
  const fresh = fakeEnv({ settings: {} });
  const dflt = await reserveSharedRequest(fresh, 42, GLOBAL);
  assert.equal(dflt.allowed, false);
  assert.equal(dflt.reason, "shared_service_disabled");

  const off = fakeEnv({ settings: { shared_service_enabled: "0" } });
  const res = await reserveSharedRequest(off, 42, GLOBAL);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "shared_service_disabled");
  assert.match(sharedQuotaMessage(res.reason, 0, 0), /disabled by the administrator/);

  const on = fakeEnv({ settings: { shared_service_enabled: "1" } });
  assert.equal((await reserveSharedRequest(on, 42, GLOBAL)).allowed, true);
});

test("request quota is enforced and reports the reason", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "2" } });
  assert.equal((await reserveSharedRequest(env, 7, GLOBAL)).allowed, true);
  assert.equal((await reserveSharedRequest(env, 7, GLOBAL)).allowed, true);
  const third = await reserveSharedRequest(env, 7, GLOBAL);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "shared_request_quota_exceeded");
  assert.equal(third.used, 2);
  assert.equal(third.quota, 2);
});

test("concurrent reservations cannot exceed the limit (atomic increment)", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "5" } });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => reserveSharedRequest(env, 9, GLOBAL))
  );
  const allowed = results.filter(r => r.allowed).length;
  assert.equal(allowed, 5, "exactly the quota is handed out under concurrency");
  assert.equal(env.usage.get("9|" + todayUTC()).requests_count, 5);
});

test("request limit 0 means unlimited requests", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "0" } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await reserveSharedRequest(env, 11, GLOBAL)).allowed, true);
  }
  assert.equal(env.usage.get("11|" + todayUTC()).requests_count, 3);
});

test("token quota breach refuses and refunds the reserved request unit", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "10", shared_daily_token_limit: "100" } });
  env.usage.set("12|" + todayUTC(), { requests_count: 1, tokens_used: 100 });
  const res = await reserveSharedRequest(env, 12, GLOBAL);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "shared_token_quota_exceeded");
  assert.equal(env.usage.get("12|" + todayUTC()).requests_count, 1, "the unit was handed back");
  assert.match(sharedQuotaMessage(res.reason, 100, 100), /token allowance is used up/);
});

test("recordSharedTokenUsage accumulates and ignores junk", async () => {
  const env = fakeEnv({});
  await recordSharedTokenUsage(env, 13, 40);
  await recordSharedTokenUsage(env, 13, 60);
  await recordSharedTokenUsage(env, 13, 0);
  await recordSharedTokenUsage(env, 13, "nope");
  await recordSharedTokenUsage(env, 13, -5);
  assert.equal((await getSharedUsage(env, 13)).tokens, 100);
});

test("a broken quota table fails closed, not open", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "5" } });
  env.setFailUpdate(true);
  const res = await reserveSharedRequest(env, 14, GLOBAL);
  assert.equal(res.allowed, false, "operator credit is never handed out on error");
  assert.equal(res.reason, "shared_quota_unavailable");
  assert.match(sharedQuotaMessage(res.reason, 0, 0), /Could not verify/);
});

test("usage is isolated per user and per day", async () => {
  const env = fakeEnv({ settings: { shared_service_enabled: "1", shared_daily_request_limit: "1" } });
  assert.equal((await reserveSharedRequest(env, 20, GLOBAL)).allowed, true);
  assert.equal((await reserveSharedRequest(env, 20, GLOBAL)).allowed, false);
  assert.equal((await reserveSharedRequest(env, 21, GLOBAL)).allowed, true, "a different user has their own quota");
});
