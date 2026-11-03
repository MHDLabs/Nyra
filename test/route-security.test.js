import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBaseUrl, validateBaseUrlDetailed } from "../src/security.js";

test("rejects localhost and loopback addresses", () => {
  assert.equal(validateBaseUrl("https://127.0.0.1/api"), null);
  assert.equal(validateBaseUrl("https://localhost/api"), null);
  assert.equal(validateBaseUrl("https://[::1]/api"), null);
});

test("rejects private IPv4 ranges", () => {
  assert.equal(validateBaseUrl("https://10.0.0.1/api"), null);
  assert.equal(validateBaseUrl("https://192.168.1.1/api"), null);
  assert.equal(validateBaseUrl("https://172.16.0.1/api"), null);
});

test("rejects cloud metadata hosts", () => {
  assert.equal(validateBaseUrl("https://metadata.google.internal/api"), null);
  assert.equal(validateBaseUrl("https://169.254.169.254/api"), null);
});

test("rejects private domain suffixes", () => {
  assert.equal(validateBaseUrl("https://api.local/v1"), null);
  assert.equal(validateBaseUrl("https://api.internal/v1"), null);
});

test("requires https by default", () => {
  assert.equal(validateBaseUrl("http://api.openai.com/v1"), null);
});

test("accepts valid public endpoints", () => {
  assert.ok(validateBaseUrl("https://api.openai.com/v1"));
  assert.ok(validateBaseUrl("https://api.anthropic.com/v1"));
});

test("validateBaseUrlDetailed returns reason", () => {
  const result = validateBaseUrlDetailed("https://127.0.0.1/api");
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});
