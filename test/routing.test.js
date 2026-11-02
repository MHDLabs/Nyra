// Routing and fallback logic tests (offline, mocked providers).
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock environment
function mockEnv(overrides = {}) {
  const store = new Map();
  const connStore = new Map();
  
  return {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          async first() {
            if (sql.includes("SELECT * FROM ai_connections WHERE connection_id")) {
              return connStore.get(args[0]) || null;
            }
            if (sql.includes("SELECT * FROM routing_profiles WHERE profile_id")) {
              return store.get("profile:" + args[0]) || null;
            }
            if (sql.includes("SELECT COUNT(*) AS c")) return { c: 0 };
            return null;
          },
          async all() {
            if (sql.includes("FROM ai_connections")) {
              return { results: Array.from(connStore.values()) };
            }
            if (sql.includes("FROM routing_profile_entries")) {
              const profileId = args[0];
              const entries = store.get("entries:" + profileId) || [];
              return { results: entries };
            }
            return { results: [] };
          },
          async run() { return { success: true }; }
        })
      })
    },
    KV: { async get() { return null; }, async put() {} },
    AI: { async run() { return "mocked response"; } },
    _store: store,
    _connStore: connStore,
    ...overrides
  };
}

test("error classification: retryable categories", async () => {
  const { normalizeError, isRetryableCategory } = await import("../src/providers/errors.js");
  
  // Retryable errors
  assert.ok(isRetryableCategory("timeout"));
  assert.ok(isRetryableCategory("network_error"));
  assert.ok(isRetryableCategory("server_error"));
  assert.ok(isRetryableCategory("provider_overloaded"));
  assert.ok(isRetryableCategory("rate_limited"));
  assert.ok(isRetryableCategory("unexpected_format"));
  assert.ok(isRetryableCategory("empty_response"));
  
  // Non-retryable
  assert.ok(!isRetryableCategory("invalid_key"));
  assert.ok(!isRetryableCategory("forbidden"));
  assert.ok(!isRetryableCategory("model_not_found"));
  assert.ok(!isRetryableCategory("quota_exceeded"));
  assert.ok(!isRetryableCategory("invalid_configuration"));
});

test("error classification: 529 provider overload", async () => {
  const { normalizeError } = await import("../src/providers/errors.js");
  const err = new Error("Service unavailable");
  const category = normalizeError(err, 529);
  assert.strictEqual(category, "provider_overloaded");
});

test("error classification: 429 rate limit", async () => {
  const { normalizeError } = await import("../src/providers/errors.js");
  const err = new Error("Rate limit exceeded");
  const category = normalizeError(err, 429);
  assert.strictEqual(category, "rate_limited");
});

test("Retry-After header extraction", async () => {
  const { parseProviderError } = await import("../src/providers/errors.js");
  
  // Mock Response with Retry-After header
  const mockResp = {
    status: 429,
    headers: new Map([["retry-after", "60"], ["Retry-After", "60"]]),
    async text() { return '{"error":"rate limit"}'; }
  };
  
  const err = await parseProviderError(mockResp);
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.retryAfterSeconds, 60);
});

test("Retry-After capped at 300 seconds", async () => {
  const { parseProviderError } = await import("../src/providers/errors.js");
  
  const mockResp = {
    status: 429,
    headers: new Map([["Retry-After", "600"]]),
    async text() { return '{"error":"rate limit"}'; }
  };
  
  const err = await parseProviderError(mockResp);
  assert.strictEqual(err.retryAfterSeconds, 300);
});

test("connection models: add model idempotent", async () => {
  const { addConnectionModel } = await import("../src/db/connection-models.js");
  const env = mockEnv();
  
  let modelStore = new Map();
  env.DB.prepare = (sql) => ({
    bind: (...args) => ({
      async first() {
        if (sql.includes("SELECT * FROM connection_models WHERE connection_id")) {
          return modelStore.get(args[0] + ":" + args[1]) || null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO connection_models")) {
          const [modelId, connId, model, label] = args;
          modelStore.set(connId + ":" + model, { model_id: modelId, connection_id: connId, model, label, enabled: 1 });
        }
        return { success: true };
      }
    })
  });
  
  const result1 = await addConnectionModel(env, "conn-1", { model: "gpt-4", label: "GPT-4" });
  assert.ok(result1.ok);
  assert.strictEqual(result1.model.model, "gpt-4");
  
  // Add same model again - should be idempotent
  const result2 = await addConnectionModel(env, "conn-1", { model: "gpt-4", label: "GPT-4 Updated" });
  assert.ok(result2.ok);
  assert.ok(result2.existed);
  assert.strictEqual(result2.model.model, "gpt-4");
});

test("routing profile: create and add entries", async () => {
  const { createRoutingProfile, addRoutingProfileEntry } = await import("../src/db/routing-profiles.js");
  const env = mockEnv();
  
  const profileResult = await createRoutingProfile(env, 12345, { label: "Main Profile" });
  assert.ok(profileResult.ok);
  assert.ok(profileResult.profileId);
  
  env._store.set("profile:" + profileResult.profileId, {
    profile_id: profileResult.profileId,
    telegram_id: 12345,
    label: "Main Profile",
    enabled: 1
  });
  
  const entryResult = await addRoutingProfileEntry(env, 12345, profileResult.profileId, {
    connection_id: "conn-1",
    model: "gpt-4",
    priority: 100
  });
  assert.ok(entryResult.ok);
});

test("model verification states normalized", async () => {
  const { normalizeVerifyStatus } = await import("../src/db/connection-models.js");
  
  assert.strictEqual(normalizeVerifyStatus("verified"), "verified");
  assert.strictEqual(normalizeVerifyStatus("unavailable"), "unavailable");
  assert.strictEqual(normalizeVerifyStatus("unverified"), "unverified");
  assert.strictEqual(normalizeVerifyStatus(""), "unverified");
  assert.strictEqual(normalizeVerifyStatus("invalid"), "unverified");
  assert.strictEqual(normalizeVerifyStatus(null), "unverified");
});

test("error message redaction removes credentials", async () => {
  const { redactErrorMessage } = await import("../src/db/connection-models.js");
  
  const msg1 = "Bearer sk-proj-abc123xyz failed";
  assert.ok(redactErrorMessage(msg1).includes("[redacted"));
  assert.ok(!redactErrorMessage(msg1).includes("sk-proj"));
  
  const msg2 = "Authorization: Bearer token123 invalid";
  assert.ok(redactErrorMessage(msg2).includes("[redacted"));
  assert.ok(!redactErrorMessage(msg2).includes("token123"));
  
  const msg3 = "api_key=secret_value_here failed";
  assert.ok(!redactErrorMessage(msg3).includes("secret_value"));
});

console.log("✓ All routing tests passed");