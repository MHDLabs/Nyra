// Shared ("operator-owned") models: the admin Mini App surface, and the fact
// that a keyless user actually gets routed to one.
//
// MOCKED: the provider HTTP calls (global fetch is stubbed with a
// chat-completions response). Everything else is the real code — real AES-GCM
// encryption, real router, real connection helpers, real quota engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { routeMiniAppAPI } from "../src/miniapp/router.js";
import {
  handleAdminCreateSharedModel, handleAdminSharedModels, handleAdminSharedModelAction,
  handleAdminSharedServiceSettings, handleAdminUpdateSharedModel, handleAdminDeleteSharedModel,
  handleAdminTestSharedModel
} from "../src/miniapp/shared-models.js";
import { resolveUserActiveConnection, reserveSharedRequest, isSharedConnection } from "../src/db.js";

const BOT_TOKEN = "123456:TEST-bot-token-for-unit-tests";
const ADMIN_ID = 7141112393;
const USER_ID = 111222333;
const SHARED_KEY = "sk-operator-secret-key-do-not-leak";

/** 32 zero bytes, base64 — a valid master key for the test only. */
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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
 * In-memory D1 that understands the exact statements the connection and
 * settings layers issue. Rows are plain objects, so assertions can inspect the
 * stored ciphertext directly.
 */
function makeDB(opts) {
  const o = opts || {};
  const rows = new Map(); // connection_id -> row
  const settings = new Map(Object.entries(o.settings || {}));
  const usage = new Map(); // `${id}|${date}` -> { requests_count, tokens_used }
  let seq = 0;

  function usageRow(id, date) {
    const k = id + "|" + date;
    if (!usage.has(k)) usage.set(k, { telegram_id: id, date: date, requests_count: 0, tokens_used: 0 });
    return usage.get(k);
  }

  function upsertRow(a) {
    // INSERT column order from saveGlobalConnection: connection_id, telegram_id,
    // label, provider, base_url, model, encrypted_key, key_iv, is_global,
    // description, display_order, supports_vision, created_at, updated_at.
    const id = a[0];
    rows.set(id, {
      connection_id: id, telegram_id: a[1], label: a[2], provider: a[3],
      base_url: a[4], model: a[5], encrypted_key: a[6], key_iv: a[7],
      encryption_version: 2, enabled: 1, is_global: a[8], is_default: 0,
      description: a[9], display_order: a[10], supports_vision: a[11],
      consecutive_failures: 0, created_at: a[12], updated_at: a[13]
    });
    return id;
  }

  const db = {
    rows,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          const a = stmt._args;
          if (sql.indexOf("COUNT(*) AS c FROM ai_connections") !== -1) {
            return { c: Array.from(rows.values()).filter(r => r.is_global === 1 && r.enabled === 1).length };
          }
          if (sql.indexOf("FROM app_settings") !== -1) {
            return settings.has(a[0]) ? { value: settings.get(a[0]) } : null;
          }
          if (sql.indexOf("FROM shared_service_usage") !== -1) {
            const row = usageRow(a[0], a[1]);
            return { requests_count: row.requests_count, tokens_used: row.tokens_used };
          }
          if (sql.indexOf("MAX(display_order)") !== -1) {
            const globals = Array.from(rows.values()).filter(r => r.is_global === 1);
            return { m: globals.length ? Math.max.apply(null, globals.map(r => r.display_order)) : null };
          }
          if (sql.indexOf("FROM ai_connections WHERE connection_id = ?") !== -1) {
            // `(telegram_id = ? AND is_global = 0) OR is_global = 1`
            const row = rows.get(a[0]);
            if (!row) return null;
            if (row.is_global === 1) return { ...row };
            return row.telegram_id === a[1] ? { ...row } : null;
          }
          return null;
        },
        async all() {
          if (sql.indexOf("FROM ai_connections") !== -1) {
            const userArg = stmt._args[0];
            let list = Array.from(rows.values());
            if (sql.indexOf("is_global = 1 AND enabled = 1") !== -1) {
              list = list.filter(r => r.is_global === 1 && r.enabled === 1);
            } else if (sql.indexOf("WHERE is_global = 1 ORDER BY") !== -1) {
              list = list.filter(r => r.is_global === 1);
            } else {
              list = list.filter(r => (r.telegram_id === userArg && r.is_global === 0) || r.is_global === 1);
            }
            list.sort((x, y) => (y.is_global - x.is_global) || (y.is_default - x.is_default) || (x.display_order - y.display_order));
            // Honour the derived `has_key` projection. Returning raw rows here
            // is how the admin panel shipped `has_key: false` for a model that
            // DID have a key: the stub answered with a field the real SELECT
            // never produced.
            // `listGlobalConnections` never selects the ciphertext: the real
            // query either projects a derived `has_key` boolean or nothing at
            // all. Mirror both shapes exactly, so a query that forgets the
            // projection can no longer be rescued by the stub handing back an
            // encrypted_key the endpoint never received.
            const wantsHasKey = sql.indexOf("AS has_key") !== -1;
            const isGlobalList = sql.indexOf("FROM ai_connections WHERE is_global = 1 ORDER BY") !== -1;
            if (!isGlobalList) {
              return { results: list.map(r => ({ ...r })) };
            }
            return { results: list.map(r => {
              const copy = { ...r };
              delete copy.encrypted_key;
              delete copy.key_iv;
              if (wantsHasKey) copy.has_key = !!(r.encrypted_key && r.encrypted_key.length > 0);
              return copy;
            }) };
          }
          return { results: [] };
        },
        async run() {
          const a = stmt._args;
          if (sql.indexOf("INSERT INTO ai_connections") !== -1) { upsertRow(a); return { meta: { changes: 1 } }; }
          if (sql.indexOf("INSERT INTO shared_service_usage") !== -1) {
            const row = usageRow(a[0], a[1]);
            if (sql.indexOf("tokens_used = excluded.tokens_used") !== -1) row.tokens_used += a[2] || 0;
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("UPDATE shared_service_usage SET requests_count = requests_count + 1") !== -1) {
            // (?, ?, limit, limit) — limit 0 means unlimited.
            const row = usageRow(a[0], a[1]);
            if (a[2] !== 0 && row.requests_count >= a[3]) return { meta: { changes: 0 } };
            row.requests_count += 1;
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("UPDATE shared_service_usage SET requests_count = MAX") !== -1) {
            const row = usageRow(a[0], a[1]);
            row.requests_count = Math.max(row.requests_count - 1, 0);
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("INSERT INTO app_settings") !== -1) { settings.set(a[0], String(a[1])); return { meta: { changes: 1 } }; }
          if (sql.indexOf("UPDATE ai_connections SET is_default = 0 WHERE is_global = 1") !== -1) {
            for (const r of rows.values()) if (r.is_global === 1) r.is_default = 0;
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("UPDATE ai_connections SET is_default = 1") !== -1) {
            const r = rows.get(a[1]);
            if (r && r.is_global === 1) r.is_default = 1;
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("UPDATE ai_connections SET enabled = ?") !== -1) {
            const r = rows.get(a[2]);
            if (r && r.is_global === 1) r.enabled = a[0];
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("UPDATE ai_connections SET") !== -1) {
            // updateUserConnection's dynamic SET list, followed by updated_at, then the id.
            const id = a[a.length - 1];
            const r = rows.get(id);
            if (!r) return { meta: { changes: 0 } };
            const sets = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).split(",").map(s => s.trim());
            sets.forEach((set, i) => {
              const col = set.split("=")[0].trim();
              if (col === "updated_at") return;
              r[col] = a[i];
            });
            return { meta: { changes: 1 } };
          }
          if (sql.indexOf("DELETE FROM ai_connections") !== -1) { rows.delete(a[0]); return { meta: { changes: 1 } }; }
          if (sql.indexOf("UPDATE users SET active_connection_id = NULL") !== -1) return { meta: { changes: 0 } };
          return { meta: { changes: 0 } };
        }
      };
      return stmt;
    }
  };
  return db;
}

function makeKV() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); } };
}

function makeEnv(opts) {
  const o = opts || {};
  return {
    DB: o.DB || makeDB(o),
    KV: o.KV || makeKV(),
    ADMIN_IDS: String(ADMIN_ID),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ENCRYPTION_KEY
  };
}

/** Stub the provider: succeed or fail on demand, and record the requests made. */
function stubProvider(result) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    calls.push({ url: String(url), init: init });
    if (result === "fail") {
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      id: "cmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const MODEL_BODY = {
  label: "Qwen public",
  provider: "openai-compatible",
  base_url: "https://api.example.com/v1",
  model: "qwen/qwen3-32b",
  api_key: SHARED_KEY
};

test("the admin list reports has_key from the stored ciphertext, without it", async () => {
  // Regression: listGlobalConnections did not project `has_key`, so the panel
  // showed every shared model as keyless while routing still worked. The UI
  // must be able to tell "configured" from "not configured".
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    const listed = await (await handleAdminSharedModels(env, ADMIN_ID)).json();
    assert.equal(listed.models[0].has_key, true, "a saved key must be reported");
    assert.equal(JSON.stringify(listed).indexOf("encrypted_key"), -1, "no ciphertext in the payload");
    assert.equal(JSON.stringify(listed).indexOf("key_iv"), -1, "no iv in the payload");

    // A row with no key reports false rather than throwing or lying.
    const id = listed.models[0].connection_id;
    env.DB.rows.get(id).encrypted_key = "";
    const after = await (await handleAdminSharedModels(env, ADMIN_ID)).json();
    assert.equal(after.models[0].has_key, false);
  } finally { provider.restore(); }
});

test("admin creates a shared model; it is stored tested, enabled and default", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    const res = await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].label, "Qwen public");
    assert.equal(body.models[0].enabled, true);
    assert.equal(body.models[0].is_default, true, "the first usable shared model is the default");
    assert.equal(body.models[0].has_key, true);
    assert.equal(body.created, body.models[0].connection_id);
    assert.equal(provider.calls.length, 1, "the model was probed before being stored");
    assert.match(provider.calls[0].url, /\/chat\/completions$/);
  } finally { provider.restore(); }
});

test("the stored API key never leaves the server", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    const res = await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    const raw = await res.text();
    assert.equal(raw.indexOf(SHARED_KEY), -1, "plaintext key must not be returned");
    const row = Array.from(env.DB.rows.values())[0];
    assert.notEqual(row.encrypted_key, SHARED_KEY);
    assert.equal(row.encryption_version, 2);
    assert.equal(raw.indexOf(row.encrypted_key), -1, "ciphertext must not be returned either");
  } finally { provider.restore(); }
});

test("a model that fails its probe is not saved", async () => {
  const env = makeEnv();
  const provider = stubProvider("fail");
  try {
    const res = await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Model test failed/);
    assert.equal(env.DB.rows.size, 0, "an unusable model must not become the default");
  } finally { provider.restore(); }
});

test("missing fields and invalid base URLs are rejected before any network call", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    assert.equal((await handleAdminCreateSharedModel(env, ADMIN_ID, { ...MODEL_BODY, label: "" })).status, 400);
    assert.equal((await handleAdminCreateSharedModel(env, ADMIN_ID, { ...MODEL_BODY, model: "" })).status, 400);
    assert.equal((await handleAdminCreateSharedModel(env, ADMIN_ID, { ...MODEL_BODY, api_key: "" })).status, 400);
    assert.equal((await handleAdminCreateSharedModel(env, ADMIN_ID, { ...MODEL_BODY, base_url: "not-a-url" })).status, 400);
    assert.equal((await handleAdminCreateSharedModel(env, ADMIN_ID, { ...MODEL_BODY, provider: "gemini" })).status, 400);
    assert.equal(provider.calls.length, 0);
  } finally { provider.restore(); }
});

test("a non-admin cannot create, update, delete or toggle a shared model", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    assert.equal((await handleAdminCreateSharedModel(env, USER_ID, MODEL_BODY)).status, 403);
    assert.equal((await handleAdminUpdateSharedModel(env, USER_ID, "anything", { label: "x" })).status, 403);
    assert.equal((await handleAdminDeleteSharedModel(env, USER_ID, "anything")).status, 403);
    assert.equal((await handleAdminSharedModelAction(env, USER_ID, "anything", "enable")).status, 403);
    assert.equal((await handleAdminSharedServiceSettings(env, USER_ID, { enabled: true })).status, 403);
    assert.equal((await handleAdminSharedModels(env, USER_ID)).status, 403);
    assert.equal((await handleAdminTestSharedModel(env, USER_ID, "anything")).status, 403);
    assert.equal(env.DB.rows.size, 0);
    assert.equal(provider.calls.length, 0);
  } finally { provider.restore(); }
});

test("the shared service refuses to switch on with no usable model", async () => {
  const env = makeEnv();
  const res = await handleAdminSharedServiceSettings(env, ADMIN_ID, { enabled: true });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, "no_shared_model");
  assert.equal(body.ready, false);
  assert.equal(body.settings.enabled, false, "the switch must not be persisted");
  const stored = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind("shared_service_enabled").first();
  assert.equal(stored, null, "nothing was written to app_settings");
});

test("with a model present the admin can switch the service on and set quotas", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    const res = await handleAdminSharedServiceSettings(env, ADMIN_ID, {
      enabled: true, daily_request_limit: 25, daily_token_limit: 40000
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(body.reason, null);
    assert.deepEqual(body.settings, { enabled: true, daily_request_limit: 25, daily_token_limit: 40000 });
  } finally { provider.restore(); }
});

test("readiness reports why the service is not serving", async () => {
  const env = makeEnv();
  const off = await (await handleAdminSharedModels(env, ADMIN_ID)).json();
  assert.equal(off.ready, false);
  assert.equal(off.reason, "disabled_by_admin");

  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
  } finally { provider.restore(); }
  const stillOff = await (await handleAdminSharedModels(env, ADMIN_ID)).json();
  assert.equal(stillOff.ready, false);
  assert.equal(stillOff.reason, "disabled_by_admin");

  await handleAdminSharedServiceSettings(env, ADMIN_ID, { enabled: true });
  const id = Array.from(env.DB.rows.keys())[0];
  await handleAdminSharedModelAction(env, ADMIN_ID, id, "disable");
  const noModel = await (await handleAdminSharedModels(env, ADMIN_ID)).json();
  assert.equal(noModel.ready, false);
  assert.equal(noModel.reason, "no_shared_model");
});

test("disabling the only shared model stops keyless users at the quota gate", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    await handleAdminSharedServiceSettings(env, ADMIN_ID, { enabled: true });
    const id = Array.from(env.DB.rows.keys())[0];

    const user = { telegram_id: USER_ID };
    const before = await resolveUserActiveConnection(env, user);
    assert.equal(before.connection.connection_id, id, "a keyless user resolves the shared model");
    assert.equal(isSharedConnection(before.connection, USER_ID), true);

    const allowed = await reserveSharedRequest(env, USER_ID, before.connection);
    assert.equal(allowed.allowed, true, "quota granted");

    await handleAdminSharedModelAction(env, ADMIN_ID, id, "disable");
    const afterDisable = await resolveUserActiveConnection(env, user);
    assert.equal(afterDisable.connection, null, "a disabled model is not offered to users");

    const refused = await reserveSharedRequest(env, USER_ID, before.connection);
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, "shared_model_unavailable");
  } finally { provider.restore(); }
});

test("update without an api_key keeps the stored key; test uses it", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    const id = Array.from(env.DB.rows.keys())[0];
    const originalKey = env.DB.rows.get(id).encrypted_key;

    const upd = await handleAdminUpdateSharedModel(env, ADMIN_ID, id, { label: "Renamed", model: "qwen/qwen3-235b" });
    assert.equal(upd.status, 200);
    assert.equal(env.DB.rows.get(id).encrypted_key, originalKey, "omitted key is preserved");
    assert.equal(env.DB.rows.get(id).label, "Renamed");

    const testRes = await handleAdminTestSharedModel(env, ADMIN_ID, id);
    assert.equal(testRes.status, 200);
    const tested = await testRes.json();
    assert.equal(tested.test.status, "success");
    assert.equal(provider.calls[provider.calls.length - 1].init.headers.Authorization, "Bearer " + SHARED_KEY,
      "the stored key is decrypted for the probe");
  } finally { provider.restore(); }
});

test("delete removes the shared model", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    const id = Array.from(env.DB.rows.keys())[0];
    const res = await handleAdminDeleteSharedModel(env, ADMIN_ID, id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).models.length, 0);
    assert.equal(env.DB.rows.size, 0);
  } finally { provider.restore(); }
});

test("the routes are registered and gated in the real Mini App router", async () => {
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    const nonAdmin = await routeMiniAppAPI(env, { waitUntil() {} },
      new Request("https://nyra.example.com/api/admin/shared-models", {
        method: "GET", headers: { "X-Init-Data": initDataFor(USER_ID) }
      }), "/api/admin/shared-models");
    assert.equal(nonAdmin.status, 403);

    const created = await routeMiniAppAPI(env, { waitUntil() {} },
      new Request("https://nyra.example.com/api/admin/shared-models", {
        method: "POST",
        headers: { "X-Init-Data": initDataFor(ADMIN_ID), "Content-Type": "application/json" },
        body: JSON.stringify(MODEL_BODY)
      }), "/api/admin/shared-models");
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.models.length, 1);

    const listed = await routeMiniAppAPI(env, { waitUntil() {} },
      new Request("https://nyra.example.com/api/admin/shared-models", {
        method: "GET", headers: { "X-Init-Data": initDataFor(ADMIN_ID) }
      }), "/api/admin/shared-models");
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).models.length, 1);

    const id = body.models[0].connection_id;
    const enabled = await routeMiniAppAPI(env, { waitUntil() {} },
      new Request("https://nyra.example.com/api/admin/shared-models/" + id + "/default", {
        method: "POST", headers: { "X-Init-Data": initDataFor(ADMIN_ID) }
      }), "/api/admin/shared-models/" + id + "/default");
    assert.equal(enabled.status, 200);

    const settings = await routeMiniAppAPI(env, { waitUntil() {} },
      new Request("https://nyra.example.com/api/admin/shared-service", {
        method: "POST",
        headers: { "X-Init-Data": initDataFor(ADMIN_ID), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, daily_request_limit: 10, daily_token_limit: 5000 })
      }), "/api/admin/shared-service");
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).ready, true);
  } finally { provider.restore(); }
});

test("a keyless user is served by the configured shared model under quota", async () => {
  // The acceptance criterion, end to end as far as HTTP: the admin adds and
  // enables a model, then a user with no connection of their own resolves it,
  // passes the quota gate, and the provider answers.
  const env = makeEnv();
  const provider = stubProvider("ok");
  try {
    await handleAdminCreateSharedModel(env, ADMIN_ID, MODEL_BODY);
    await handleAdminSharedServiceSettings(env, ADMIN_ID, { enabled: true, daily_request_limit: 1, daily_token_limit: 0 });

    const resolved = await resolveUserActiveConnection(env, { telegram_id: USER_ID });
    assert.ok(resolved.connection, "no personal key, still has a model");
    const reserved = await reserveSharedRequest(env, USER_ID, resolved.connection);
    assert.equal(reserved.allowed, true);
    assert.equal(reserved.shared, true);

    const { generateOpenAICompatible } = await import("../src/providers/openai.js");
    const { decryptCredential } = await import("../src/crypto.js");
    const key = await decryptCredential(env, resolved.connection.telegram_id,
      resolved.connection.encrypted_key, resolved.connection.key_iv);
    const out = await generateOpenAICompatible(resolved.connection, key,
      [{ role: "user", content: "hello" }], { max_tokens: 16 });
    assert.equal(out.text, "OK", "a real provider answer reaches the user");

    const second = await reserveSharedRequest(env, USER_ID, resolved.connection);
    assert.equal(second.allowed, false);
    assert.equal(second.reason, "shared_request_quota_exceeded");
  } finally { provider.restore(); }
});
