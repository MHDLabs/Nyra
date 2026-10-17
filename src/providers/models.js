// Model listing and connection testing. `testConnectionRaw` deliberately
// races the provider call against a hard timeout: a provider that accepts the
// TCP connection and then never answers would otherwise hang the admin UI.
import { AI_TEST_TIMEOUT_MS, AI_TEST_HARD_TIMEOUT_MS, AI_TEST_MAX_TOKENS } from "../config.js";
import { truncate } from "../utils.js";
import { decryptCredential } from "../crypto.js";
import { getUserConnectionById } from "../db.js";
import { normalizeError } from "./errors.js";
import { buildProviderHeaders, generateOpenAICompatible, fetchOpenAICompatibleModels } from "./openai.js";
import { generateAnthropic, fetchAnthropicModels } from "./anthropic.js";

export async function fetchAvailableModels(provider, baseUrl, apiKey) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  if (!base) return { models: [], error: "invalid_base_url" };
  const headers = buildProviderHeaders(provider, apiKey, base);
  if (provider === "anthropic") return await fetchAnthropicModels(base, headers);
  return await fetchOpenAICompatibleModels(base, headers);
}

export async function testConnectionRaw(provider, baseUrl, apiKey, model) {
  const start = Date.now();
  const messages = [{ role: "user", content: "Reply with the single word OK." }];
  let hardTimer = null;
  const timeoutPromise = new Promise(function (_, reject) {
    hardTimer = setTimeout(function () {
      const err = new Error("test_hard_timeout");
      err.name = "TimeoutError";
      reject(err);
    }, AI_TEST_HARD_TIMEOUT_MS);
  });
  const testPromise = (async function () {
    if (provider === "anthropic") return await generateAnthropic({ provider: provider, base_url: baseUrl, model: model, telegram_id: 0 }, apiKey, messages, { max_tokens: AI_TEST_MAX_TOKENS }, AI_TEST_TIMEOUT_MS);
    return await generateOpenAICompatible({ provider: provider, base_url: baseUrl, model: model, telegram_id: 0 }, apiKey, messages, { max_tokens: AI_TEST_MAX_TOKENS }, AI_TEST_TIMEOUT_MS);
  })();
  try {
    const result = await Promise.race([testPromise, timeoutPromise]);
    const latency = Date.now() - start;
    if (!result || !result.text || result.text.trim().length === 0) {
      return { status: "empty_response", error: "empty response", latency: latency, diagnostic: null };
    }
    return { status: "success", error: null, latency: latency, diagnostic: null };
  } catch (err) {
    const category = normalizeError(err, err.status);
    const diagParts = [];
    if (err.status) diagParts.push("HTTP " + err.status);
    if (err.providerType) diagParts.push("type=" + err.providerType);
    if (err.providerCode) diagParts.push("code=" + err.providerCode);
    if (err.providerName) diagParts.push("provider=" + err.providerName);
    if (err.providerMessage) diagParts.push("msg=" + truncate(String(err.providerMessage), 200));
    return { status: category, error: err.message, latency: Date.now() - start, diagnostic: diagParts.join(" | ") };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

export async function testUserConnectionById(env, userId, connectionId) {
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return { status: "unknown", error: "connection not found", latency: 0, diagnostic: null };
  let apiKey;
  try { apiKey = await decryptCredential(env, conn.telegram_id, conn.encrypted_key, conn.key_iv); }
  catch (err) { return { status: "unknown", error: "decrypt failed", latency: 0, diagnostic: null }; }
  return await testConnectionRaw(conn.provider, conn.base_url, apiKey, conn.model);
}
