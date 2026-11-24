import { test } from "node:test";
import assert from "node:assert/strict";
import { validateModelBaseUrl } from "../src/providers/registry.js";

test("model registry accepts HTTPS OpenAI-compatible endpoints", () => {
  assert.equal(validateModelBaseUrl("https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1");
});

test("model registry allows HTTP only for localhost development", () => {
  assert.equal(validateModelBaseUrl("http://localhost:8787/v1"), "http://localhost:8787/v1");
  assert.throws(() => validateModelBaseUrl("http://gateway.example/v1"), /HTTPS/);
});

test("model registry rejects embedded credentials and unconfigured Cloudflare account placeholders", () => {
  assert.throws(() => validateModelBaseUrl("https://user:pass@example.com/v1"), /credentials/);
  assert.throws(() => validateModelBaseUrl("https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1"), /ACCOUNT_ID/);
  assert.throws(() => validateModelBaseUrl("ftp://example.com/v1"), /HTTPS/);
});
