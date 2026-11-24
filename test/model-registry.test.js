import { test } from "node:test";
import assert from "node:assert/strict";
import { validateModelBaseUrl, getAIConfigForUser } from "../src/providers/registry.js";

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
