import { test } from "node:test";
import assert from "node:assert/strict";
import { getCentralAIConfig } from "../src/providers/config.js";

test("central AI config requires one operator-owned model and key", () => {
  assert.throws(() => getCentralAIConfig({ AI_MODEL: "demo" }), /AI_API_KEY is not configured/);
  assert.throws(() => getCentralAIConfig({ AI_API_KEY: "secret" }), /AI_MODEL is not configured/);
});

test("central AI config applies the OpenAI-compatible default endpoint", () => {
  const config = getCentralAIConfig({ AI_API_KEY: "server-secret", AI_MODEL: "gpt-test" });
  assert.equal(config.connection_id, "central");
  assert.equal(config.provider, "openai-compatible");
  assert.equal(config.base_url, "https://api.openai.com/v1");
  assert.equal(config.model, "gpt-test");
  assert.equal(config.api_key, "server-secret");
  assert.equal(config.supports_vision, 0);
});

test("operator can configure a compatible endpoint and explicitly enable vision", () => {
  const config = getCentralAIConfig({
    AI_BASE_URL: "https://gateway.example/v1/",
    AI_MODEL: "vision-model",
    AI_API_KEY: "server-secret",
    AI_SUPPORTS_VISION: "true"
  });
  assert.equal(config.base_url, "https://gateway.example/v1");
  assert.equal(config.supports_vision, 1);
});

test("central endpoint rejects insecure remote URLs and embedded credentials", () => {
  assert.throws(() => getCentralAIConfig({
    AI_BASE_URL: "http://gateway.example/v1",
    AI_MODEL: "model",
    AI_API_KEY: "secret"
  }), /must use HTTPS/);
  assert.throws(() => getCentralAIConfig({
    AI_BASE_URL: "https://user:pass@gateway.example/v1",
    AI_MODEL: "model",
    AI_API_KEY: "secret"
  }), /must not contain credentials/);
});

test("central endpoint allows HTTP only for localhost development", () => {
  const config = getCentralAIConfig({
    AI_BASE_URL: "http://localhost:8787/v1",
    AI_MODEL: "local-model",
    AI_API_KEY: "local-test-key"
  });
  assert.equal(config.base_url, "http://localhost:8787/v1");
  assert.throws(() => getCentralAIConfig({
    AI_BASE_URL: "ftp://localhost/v1",
    AI_MODEL: "local-model",
    AI_API_KEY: "local-test-key"
  }), /must use HTTPS/);
});
