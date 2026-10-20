import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { routeMiniAppAPI } from "../src/miniapp/router.js";

const BOT_TOKEN = "123456:TEST-bot-token-for-unit-tests";
const ADMIN_ID = 7141112393;
const USER_ID = 111222333;

/** Sign an initData query string the way Telegram does. */
function initDataFor(userId) {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAF_test");
  params.set("user", JSON.stringify({ id: userId, first_name: "T", username: "t" }));

  const dataCheckString = Array.from(params.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
}

/**
 * KV stub whose `preset` prefix can force `checkRateLimit` over its ceiling,
 * so the 429 path is exercised without issuing 60 real requests.
 */
function fakeKV() {
  const map = new Map();
  return {
    preset: null,
    map,
    async get(key) {
      if (this.preset && key.indexOf(this.preset) === 0) return "999999";
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) { map.set(key, String(value)); }
  };
}

/**
 * D1 stub. `throwOn` is a SQL substring that makes `first()` reject, which
 * stands in for a database outage.
 */
function fakeDB(opts) {
  const o = opts || {};
  return {
    prepare(sql) {
      return {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (o.throwOn && sql.indexOf(o.throwOn) !== -1) throw new Error("D1_ERROR: unavailable");
          if (sql.indexOf("SELECT custom_instructions FROM users") !== -1) {
            return { custom_instructions: o.customInstructions !== undefined ? o.customInstructions : null };
          }
          if (sql.indexOf("FROM users WHERE telegram_id") !== -1) {
            // Mirrors a default-provisioned row: a real user always carries a
            // personality id, which `handleUserProfile` dereferences.
            return {
              telegram_id: this._args[0], first_name: "T", username: null,
              personality_id: "default", memory_mode: "normal",
              coding_mode: 0, active_connection_id: null, usage_stats: "{}"
            };
          }
          return null;
        },
        async all() { return { results: o.results || [] }; },
        async run() { return { success: true }; }
      };
    }
  };
}

function fakeEnv(over) {
  const o = over || {};
  return Object.assign({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ADMIN_IDS: String(ADMIN_ID),
    KV: fakeKV(),
    DB: fakeDB(o),
    NYRA_QUEUE: { async send() {} }
  }, o.env || {});
}

function req(path, opts) {
  const o = opts || {};
  const headers = {};
  if (o.initData !== undefined) headers["X-Init-Data"] = o.initData;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("https://nyra.example.com" + path, {
    method: o.method || "GET",
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined
  });
}

const ctx = { waitUntil() {} };

test("rejects a request with no X-Init-Data header", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx, req("/api/user/profile"), "/api/user/profile");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "Unauthorized");
});

test("rejects a forged initData signature", async () => {
  const forged = initDataFor(USER_ID).replace(/&hash=[0-9a-f]+/, "&hash=" + "a".repeat(64));
  const res = await routeMiniAppAPI(fakeEnv(), ctx, req("/api/user/profile", { initData: forged }), "/api/user/profile");
  assert.equal(res.status, 401);
});

test("rejects an empty X-Init-Data header", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx, req("/api/user/profile", { initData: "" }), "/api/user/profile");
  assert.equal(res.status, 401);
});

test("allows an authenticated, non-admin request through to the handler", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/user/profile", { initData: initDataFor(USER_ID) }), "/api/user/profile");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type").indexOf("application/json"), 0);
  const body = await res.json();
  assert.equal(body.telegram_id, USER_ID);
});

test("non-admins get 403 on every /api/admin/* path", async () => {
  const env = fakeEnv();
  const header = { initData: initDataFor(USER_ID) };
  const paths = [
    "/api/admin/stats", "/api/admin/users", "/api/admin/chats",
    "/api/admin/broadcasts", "/api/admin/failed-updates", "/api/admin/routes",
    "/api/admin/settings", "/api/admin/connection-usage"
  ];
  for (const p of paths) {
    const res = await routeMiniAppAPI(env, ctx, req(p, header), p);
    assert.equal(res.status, 403, p + " must be forbidden for a non-admin");
    assert.equal((await res.json()).error, "Forbidden");
  }
});

test("the admin gate also covers admin POST paths", async () => {
  const env = fakeEnv();
  const header = { initData: initDataFor(USER_ID) };
  const posts = [
    ["/api/admin/settings", { allow_personal_models: true }],
    ["/api/admin/broadcast/create", { message: "hi", targetType: "all_users" }],
    ["/api/admin/broadcast/preview", { targetType: "all_users" }],
    ["/api/admin/failed-updates/replay", { id: 1 }],
    ["/api/admin/connection-toggle", { connection_id: "c1", field: "fast" }]
  ];
  for (const [p, body] of posts) {
    const res = await routeMiniAppAPI(env, ctx, req(p, { initData: header.initData, method: "POST", body }), p);
    assert.equal(res.status, 403, p + " must be forbidden for a non-admin");
  }
});

test("admins pass the admin gate", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/admin/connection-usage", { initData: initDataFor(ADMIN_ID) }), "/api/admin/connection-usage");
  assert.equal(res.status, 200);
});

test("admin can persist Workers AI policy and model via the real settings endpoint", async () => {
  const values = new Map();
  const env = fakeEnv();
  env.DB = {
    prepare(sql) {
      return {
        args: [], bind(...args) { this.args = args; return this; },
        async first() { return sql.includes("FROM app_settings") ? (values.has(this.args[0]) ? { value: values.get(this.args[0]) } : null) : null; },
        async run() { if (sql.includes("INSERT INTO app_settings")) values.set(this.args[0], this.args[1]); return { success: true }; }
      };
    }
  };
  const res = await routeMiniAppAPI(env, ctx,
    req("/api/admin/settings", { initData: initDataFor(ADMIN_ID), method: "POST", body: { workers_ai_policy: "admins", workers_ai_model: "@cf/meta/llama-3.1-8b-instruct" } }),
    "/api/admin/settings");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.workers_ai_policy, "admins");
  assert.equal(body.workers_ai_model, "@cf/meta/llama-3.1-8b-instruct");
  assert.equal(values.get("workers_ai_policy"), "admins");
});

test("returns 404 for an unknown API path", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/does-not-exist", { initData: initDataFor(USER_ID) }), "/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Not found");
});

test("returns 404 when the HTTP method does not match the route", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/chat", { initData: initDataFor(USER_ID) }), "/api/chat");
  assert.equal(res.status, 404, "GET /api/chat is not a route; POST is");
});

test("normalises a trailing slash instead of 404ing", async () => {
  const payload = initDataFor(USER_ID);
  const plain = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/user/custom-instructions", { initData: payload }), "/api/user/custom-instructions");
  const slashed = await routeMiniAppAPI(fakeEnv(), ctx,
    new Request("https://nyra.example.com/api/user/custom-instructions/", {
      headers: { "X-Init-Data": payload }
    }),
    "/api/user/custom-instructions/");

  assert.equal(plain.status, 200);
  assert.equal(slashed.status, 200, "a trailing slash must reach the same handler");
});

test("rate limits authenticated user traffic with a 429", async () => {
  const env = fakeEnv();
  env.KV.preset = "rl:api:";
  const res = await routeMiniAppAPI(env, ctx,
    req("/api/user/profile", { initData: initDataFor(USER_ID) }), "/api/user/profile");
  assert.equal(res.status, 429);
  assert.ok((await res.json()).error.indexOf("slow down") !== -1);
});

test("the user and admin rate-limit buckets are independent", async () => {
  // Exhausting the admin bucket must not block the same user's own chat
  // allowance (a separate `apiadm:` prefix).
  const env = fakeEnv();
  env.KV.preset = "rl:apiadm:";

  const userRes = await routeMiniAppAPI(env, ctx,
    req("/api/user/profile", { initData: initDataFor(ADMIN_ID) }), "/api/user/profile");
  assert.equal(userRes.status, 200, "rl:api: bucket is untouched");

  const adminRes = await routeMiniAppAPI(env, ctx,
    req("/api/admin/stats", { initData: initDataFor(ADMIN_ID) }), "/api/admin/stats");
  assert.equal(adminRes.status, 429, "rl:apiadm: bucket is exhausted");
});

test("rate limits the unauthenticated /api/auth endpoint", async () => {
  const env = fakeEnv();
  env.KV.preset = "rl:auth:";
  const res = await routeMiniAppAPI(env, ctx,
    req("/api/auth", { method: "POST", body: { initData: initDataFor(USER_ID) } }), "/api/auth");
  assert.equal(res.status, 429);
});

test("/api/auth requires no initData header but still validates the signature", async () => {
  const bad = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/auth", { method: "POST", body: { initData: "auth_date=1&hash=deadbeef" } }), "/api/auth");
  assert.equal(bad.status, 401, "a bad signature still fails");

  const empty = await routeMiniAppAPI(fakeEnv(), ctx,
    req("/api/auth", { method: "POST", body: {} }), "/api/auth");
  assert.equal(empty.status, 401, "a missing initData still fails");
});

test("a handler that throws produces a JSON 500, not a bare error", async () => {
  const env = fakeEnv({ throwOn: "SELECT custom_instructions FROM users" });
  const res = await routeMiniAppAPI(env, ctx,
    req("/api/user/custom-instructions", { initData: initDataFor(USER_ID) }), "/api/user/custom-instructions");

  assert.equal(res.status, 500);
  assert.equal(res.headers.get("Content-Type").indexOf("application/json"), 0);
  const body = await res.json();
  assert.ok(body.error, "the response must carry a JSON error field");
});

test("a malformed JSON body does not crash the router", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    new Request("https://nyra.example.com/api/user/custom-instructions", {
      method: "POST",
      headers: { "X-Init-Data": initDataFor(USER_ID), "Content-Type": "application/json" },
      body: "{ this is not json"
    }),
    "/api/user/custom-instructions");

  // readBody must swallow the parse error; the handler decides what an empty
  // body means (clearing the instructions), never a 500 from JSON.parse.
  assert.notEqual(res.status, 500, "malformed JSON must not throw out of readBody");
});

test("an array JSON body is treated as an empty object", async () => {
  const res = await routeMiniAppAPI(fakeEnv(), ctx,
    new Request("https://nyra.example.com/api/user/memory", {
      method: "POST",
      headers: { "X-Init-Data": initDataFor(USER_ID), "Content-Type": "application/json" },
      body: "[1,2,3]"
    }),
    "/api/user/memory");
  assert.notEqual(res.status, 500);
});
