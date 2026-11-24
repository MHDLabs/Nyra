import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateModelBaseUrl, getAIConfigForUser, getSelectableModels,
  setUserSelectedModel, setModelApiKey, getAdminModelList, updateModelAdmin, deleteCustomModel
} from "../src/providers/registry.js";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

test("model registry accepts secure OpenAI-compatible endpoints", () => {
  assert.equal(validateModelBaseUrl("https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1");
  assert.equal(validateModelBaseUrl("http://localhost:8787/v1"), "http://localhost:8787/v1");
});

test("model registry rejects insecure endpoints and Cloudflare placeholders", () => {
  assert.throws(() => validateModelBaseUrl("http://gateway.example/v1"), /HTTPS/);
  assert.throws(() => validateModelBaseUrl("ftp://example.com/v1"), /HTTPS/);
  assert.throws(() => validateModelBaseUrl("https://user:pass@example.com/v1"), /credentials/);
  assert.throws(() => validateModelBaseUrl("https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1"), /ACCOUNT_ID/);
});

test("a forced Cloudflare retry never silently runs the default Groq model", async () => {
  const rows = [{
    id: "groq_qwen38", label: "Groq Qwen", provider: "groq", model: "qwen/qwen3.8-27b",
    base_url: "https://api.groq.com/openai/v1", encrypted_api_key: "ciphertext", key_iv: "iv",
    enabled: 1, user_selectable: 1, fallback_only: 0, is_default: 1, supports_vision: 1
  }];
  const env = {
    ADMIN_IDS: "123",
    DB: { prepare(sql) {
      return {
        async all() { return { results: rows }; },
        async first() { return null; }
      };
    } }
  };
  await assert.rejects(getAIConfigForUser(env, 123, "cloudflare_qwen38"), /retry model is not configured/);
});


function registryEnv(rows, adminIds = "123") {
  const writes = [];
  return {
    ADMIN_IDS: adminIds,
    NYRA_MODEL_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-characters-long",
    writes,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...values) { args = values; return this; },
          async all() {
            if (sql.includes("FROM ai_models WHERE enabled=1")) {
              return { results: rows.filter(row => row.enabled === 1) };
            }
            return { results: rows };
          },
          async first() {
            if (sql.includes("SELECT selected_model_id FROM users")) return { selected_model_id: null };
            if (sql.includes("SELECT * FROM ai_models WHERE id=?") || sql.includes("SELECT provider FROM ai_models WHERE id=?") || sql.includes("SELECT builtin,is_default FROM ai_models WHERE id=?")) return rows.find(row => row.id === args[0]) || null;
            if (sql.includes("SELECT id FROM ai_models")) {
              const row = rows.find(item => item.id === args[0] && item.enabled === 1
                && item.encrypted_api_key && item.key_iv && item.base_url
                && !item.fallback_only && (args[1] === 1 || item.user_selectable === 1));
              return row ? { id: row.id } : null;
            }
            return null;
          },
          async run() {
            writes.push({ sql, args });
            if (sql.includes("UPDATE ai_models SET encrypted_api_key")) {
              const row = rows.find(item => item.id === args[3]);
              if (row) {
                row.encrypted_api_key = args[0];
                row.key_iv = args[1];
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            return { meta: { changes: 1 } };
          }
        };
      }
    }
  };
}

const configuredModel = (overrides = {}) => ({
  id: "groq_qwen38", label: "Groq Qwen", provider: "groq",
  model: "qwen/qwen3.8-27b", base_url: "https://api.groq.com/openai/v1",
  encrypted_api_key: "ciphertext", key_iv: "iv", enabled: 1,
  user_selectable: 1, fallback_only: 0, is_default: 1,
  supports_vision: 1, builtin: 1, ...overrides
});

test("model picker exposes only configured, enabled and permitted models", async () => {
  const rows = [
    configuredModel(),
    configuredModel({ id: "admin_only", label: "Admin only", user_selectable: 0, is_default: 0 }),
    configuredModel({ id: "fallback", fallback_only: 1, user_selectable: 0, is_default: 0 }),
    configuredModel({ id: "no_key", encrypted_api_key: null, key_iv: null, is_default: 0 }),
    configuredModel({ id: "disabled", enabled: 0, is_default: 0 })
  ];
  const env = registryEnv(rows);
  const userModels = await getSelectableModels(env, 456);
  const adminModels = await getSelectableModels(env, 123);
  assert.deepEqual(userModels.map(model => model.id), ["groq_qwen38"]);
  assert.deepEqual(adminModels.map(model => model.id), ["groq_qwen38", "admin_only"]);
});

test("users cannot select admin-only models, but administrators can", async () => {
  const rows = [
    configuredModel(),
    configuredModel({ id: "admin_only", user_selectable: 0, is_default: 0 })
  ];
  const env = registryEnv(rows);
  assert.equal(await setUserSelectedModel(env, 456, "admin_only"), false);
  assert.equal(env.writes.length, 0);
  assert.equal(await setUserSelectedModel(env, 123, "admin_only"), true);
  assert.equal(env.writes.length, 1);
  assert.match(env.writes[0].sql, /UPDATE users SET selected_model_id/);
});

test("provider API keys are encrypted at rest and never appear in admin model output", async () => {
  const rows = [configuredModel({ encrypted_api_key: null, key_iv: null })];
  const env = registryEnv(rows);
  const apiKey = "groq-secret-api-key-value";
  await setModelApiKey(env, "groq_qwen38", apiKey);
  assert.notEqual(rows[0].encrypted_api_key, apiKey);
  assert.ok(rows[0].key_iv);
  const publicRows = await getAdminModelList(env);
  assert.equal(publicRows[0].has_api_key, true);
  assert.equal("encrypted_api_key" in publicRows[0], false);
  assert.equal("key_iv" in publicRows[0], false);
  const resolved = await getAIConfigForUser(env, 456);
  assert.equal(resolved.config.api_key, apiKey);
});

test("the global default cannot be disabled or hidden from users", async () => {
  const rows = [configuredModel()];
  const env = registryEnv(rows);
  await assert.rejects(updateModelAdmin(env, "groq_qwen38", { enabled: false }), /different default model/);
  await assert.rejects(updateModelAdmin(env, "groq_qwen38", { user_selectable: false }), /different default model/);
});

test("Cloudflare built-ins need only the native AI binding and can be selected", async () => {
  const cloudflare = configuredModel({
    id: "cloudflare_glm47", label: "Cloudflare GLM", provider: "cloudflare",
    model: "@cf/zai-org/glm-4.7-flash", base_url: "", encrypted_api_key: null,
    key_iv: null, enabled: 1, fallback_only: 0, is_default: 0, supports_vision: 0
  });
  const env = registryEnv([configuredModel(), cloudflare]);
  env.AI = { run: async () => null };
  const selectable = await getSelectableModels(env, 456);
  assert.ok(selectable.some(model => model.id === "cloudflare_glm47"));
  assert.equal(await setUserSelectedModel(env, 456, "cloudflare_glm47"), true);
  const glm = (await getAdminModelList(env)).find(model => model.id === "cloudflare_glm47");
  assert.equal(glm.binding_available, true);
  assert.equal(glm.requires_api_key, false);
  assert.equal(glm.ready, true);
  await assert.rejects(setModelApiKey(env, "cloudflare_glm47", "not-needed-token"), /no API key is needed/i);
  await assert.rejects(updateModelAdmin(env, "cloudflare_glm47", { base_url: "https://example.com/v1" }), /only enabled\/disabled state/i);
});

test("Cloudflare Qwen is the automatic fallback only while enabled and bound", async () => {
  const cloudflare = configuredModel({
    id: "cloudflare_qwen38", label: "Cloudflare Qwen", provider: "cloudflare",
    model: "@cf/qwen/qwen3.8-27b", base_url: "", encrypted_api_key: null,
    key_iv: null, enabled: 1, user_selectable: 0, fallback_only: 1, is_default: 0
  });
  const env = registryEnv([configuredModel(), cloudflare]);
  env.AI = { run: async () => null };
  await setModelApiKey(env, "groq_qwen38", "groq-secret-api-key-value");
  const resolved = await getAIConfigForUser(env, 456);
  assert.equal(resolved.config.id, "groq_qwen38");
  assert.equal(resolved.fallbackConfig.id, "cloudflare_qwen38");
  cloudflare.enabled = 0;
  const disabled = await getAIConfigForUser(env, 456);
  assert.equal(disabled.fallbackConfig, null);
});

test("the current global default cannot be deleted while it is active", async () => {
  const rows = [configuredModel({ builtin: 0 })];
  const env = registryEnv(rows);
  await assert.rejects(deleteCustomModel(env, "groq_qwen38"), /different default model/);
  assert.equal(rows.length, 1);
});
