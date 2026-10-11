// Nyra — AI layer: error taxonomy, providers, streaming, model listing, tests, fallback.
import { AI_PRIMARY_ATTEMPT_TIMEOUT_MS, AI_MAX_PRIMARY_ATTEMPTS, AI_RETRY_DELAYS_MS, AI_STREAM_STALL_TIMEOUT_MS, AI_STREAM_TOTAL_BUDGET_MS, AI_TEST_TIMEOUT_MS, AI_TEST_HARD_TIMEOUT_MS, AI_TEST_MAX_TOKENS, UNHEALTHY_FAILURE_THRESHOLD, ADMIN_NOTIFY_THROTTLE_TTL, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL, ANTHROPIC_VERSION, APP_TITLE } from "./config.js";
import { truncate, escapeHtml, sleep, isOpenRouterUrl, fetchWithTimeout, getAdminIds } from "./utils.js";
import { decryptCredential } from "./crypto.js";
import { sendMessage } from "./telegram.js";
import { getEnabledUserConnections, getUserConnectionById, recordConnectionFailure, recordConnectionSuccess } from "./db.js";

export function normalizeError(err, httpStatus) {
  const status = httpStatus || (err && err.status);
  const providerType = (err && err.providerType ? String(err.providerType) : "").toLowerCase();
  const providerCode = (err && err.providerCode ? String(err.providerCode) : "").toLowerCase();
  const providerMessage = (err && err.providerMessage ? String(err.providerMessage) : "").toLowerCase();
  const providerRaw = (err && err.providerRaw ? String(err.providerRaw) : "").toLowerCase();
  const providerName = (err && err.providerName ? String(err.providerName) : "").toLowerCase();
  const baseMessage = err ? String(err.message || err).toLowerCase() : "";
  const combined = baseMessage + " " + providerMessage + " " + providerRaw + " " + providerType + " " + providerCode;

  if (err && err.category === "empty_response") return "empty_response";
  if (err && err.category === "unexpected_format") return "unexpected_format";

  if (providerCode === "insufficient_quota" || providerType === "insufficient_quota" || combined.indexOf("insufficient_quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("exceeded your current quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("billing") !== -1 && combined.indexOf("quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("payment required") !== -1) return "quota_exceeded";
  if (combined.indexOf("free-models-per-day") !== -1 || combined.indexOf("free_models_per_day") !== -1) return "daily_quota_exceeded";
  if (combined.indexOf("daily limit") !== -1 && combined.indexOf("free") !== -1) return "daily_quota_exceeded";
  if (combined.indexOf("provider returned error") !== -1 && status === 429) return "provider_overloaded";
  if (combined.indexOf("resource exhausted") !== -1) return "provider_overloaded";
  if (combined.indexOf("upstream") !== -1 && status === 429) return "provider_overloaded";
  if (providerName && status === 429 && combined.indexOf("rate limit") === -1) return "provider_overloaded";
  if (status === 529) return "provider_overloaded";
  if (status) {
    if (status === 401) return "invalid_key";
    if (status === 402) return "quota_exceeded";
    if (status === 403) return "forbidden";
    if (status === 404) return "model_not_found";
    if (status === 429) return "rate_limited";
    if (status === 400) {
      if (providerCode === "model_not_found") return "model_not_found";
      if (providerType === "invalid_request_error" && combined.indexOf("model") !== -1) return "model_not_found";
      return "invalid_configuration";
    }
    if (status >= 500 && status < 600) return "server_error";
  }
  if (!err) return "unknown";
  if (providerType === "authentication_error" || providerType === "invalid_api_key" || providerType === "unauthorized") return "invalid_key";
  if (providerType === "permission_error" || providerType === "permission_denied" || providerType === "forbidden") return "forbidden";
  if (providerType === "not_found_error" || providerCode === "model_not_found" || providerType === "model_not_found") return "model_not_found";
  if (providerType === "rate_limit_error" || providerType === "rate_limit_exceeded" || providerCode === "rate_limit_exceeded") return "rate_limited";
  if (providerType === "overloaded_error" || providerType === "api_error") return "server_error";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  if (combined.indexOf("timeout") !== -1 || combined.indexOf("timed out") !== -1 || combined.indexOf("aborted") !== -1 || combined.indexOf("abort") !== -1) return "timeout";
  if (combined.indexOf("empty response") !== -1) return "empty_response";
  if (combined.indexOf("unexpected response format") !== -1) return "unexpected_format";
  if (combined.indexOf("invalid api key") !== -1 || combined.indexOf("incorrect api key") !== -1 || combined.indexOf("invalid x-api-key") !== -1) return "invalid_key";
  if (combined.indexOf("invalid_api_key") !== -1 || combined.indexOf("authentication") !== -1 || combined.indexOf("unauthorized") !== -1) return "invalid_key";
  if (combined.indexOf("permission") !== -1 || combined.indexOf("forbidden") !== -1) return "forbidden";
  if (combined.indexOf("model not found") !== -1 || combined.indexOf("does not exist") !== -1 || combined.indexOf("unknown model") !== -1) return "model_not_found";
  if (combined.indexOf("rate limit") !== -1 || combined.indexOf("too many requests") !== -1) return "rate_limited";
  if (combined.indexOf("unsupported") !== -1 && combined.indexOf("parameter") !== -1) return "invalid_configuration";
  if (combined.indexOf("network") !== -1 || combined.indexOf("fetch failed") !== -1 || combined.indexOf("econnrefused") !== -1 || combined.indexOf("enotfound") !== -1) return "network_error";
  if (combined.indexOf("json") !== -1 || combined.indexOf("parse") !== -1 || combined.indexOf("format") !== -1) return "unexpected_format";
  if (combined.indexOf("url") !== -1 || combined.indexOf("endpoint") !== -1) return "invalid_base_url";
  return "unknown";
}

export function humanizeError(category) {
  const map = {
    invalid_key: "Invalid API key. Contact the administrator.",
    forbidden: "The provider denied access.",
    model_not_found: "The configured model was not found.",
    rate_limited: "Provider rate limit reached. Wait a moment and try again.",
    quota_exceeded: "The provider account has a billing issue.",
    daily_quota_exceeded: "The daily free-tier quota for this model is exhausted. Try again tomorrow.",
    provider_overloaded: "The provider is temporarily overloaded. Try again in a few minutes.",
    timeout: "The model did not respond in time after multiple attempts. Please try again.",
    network_error: "Could not reach the provider after multiple attempts. Please try again.",
    server_error: "The provider returned a server error. Try again later.",
    unexpected_format: "The model returned an unexpected response after multiple attempts. Please try again.",
    empty_response: "The model returned an empty response after multiple attempts. Please try again.",
    invalid_base_url: "The Base URL is invalid.",
    invalid_configuration: "The connection configuration is invalid.",
    no_connection: "No AI model is available yet. Please ask an administrator to configure one.",
    unknown: "The request failed after multiple attempts. Please try again."
  };
  return map[category] || map.unknown;
}

function isRetryableCategory(category) {
  return category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "unexpected_format" ||
    category === "empty_response";
}

export function shouldNotifyAdmin(category) {
  return category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "unexpected_format" ||
    category === "empty_response" ||
    category === "unknown";
}

async function parseProviderError(resp) {
  let errText = "";
  try { errText = await resp.text(); } catch (e) {}
  let parsed = null;
  try { parsed = JSON.parse(errText); } catch (e) {}
  const err = new Error("HTTP " + resp.status + ": " + truncate(errText, 200));
  err.status = resp.status;
  if (parsed) {
    if (parsed.error) {
      if (typeof parsed.error === "string") err.providerMessage = parsed.error;
      else if (typeof parsed.error === "object") {
        err.providerMessage = parsed.error.message || null;
        err.providerType = parsed.error.type || null;
        err.providerCode = parsed.error.code || null;
        if (parsed.error.metadata && typeof parsed.error.metadata === "object") {
          err.providerName = parsed.error.metadata.provider_name || null;
          if (parsed.error.metadata.raw) {
            err.providerRaw = typeof parsed.error.metadata.raw === "string" ? parsed.error.metadata.raw : JSON.stringify(parsed.error.metadata.raw);
          }
        }
      }
    }
    if (parsed.type && typeof parsed.type === "string" && !err.providerType) err.providerType = parsed.type;
    if (parsed.code && typeof parsed.code === "string" && !err.providerCode) err.providerCode = parsed.code;
    if (parsed.message && !err.providerMessage) err.providerMessage = String(parsed.message);
  }
  return err;
}

function buildProviderHeaders(provider, apiKey, baseUrl) {
  const headers = { "Content-Type": "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    headers["Authorization"] = "Bearer " + apiKey;
    if (isOpenRouterUrl(baseUrl)) {
      headers["HTTP-Referer"] = "https://t.me";
      headers["X-Title"] = APP_TITLE;
    }
  }
  return headers;
}

async function generateOpenAICompatible(connection, apiKey, messages, options, timeoutMs) {
  const baseUrl = (connection.base_url || OPENAI_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const isReasoning = /(^|[-/])(o[1-9]|gpt-5)/i.test(model);
  const finalMessages = isReasoning
    ? messages.map(function (m) { return m.role === "system" ? { role: "developer", content: m.content } : m; })
    : messages;
  const body = { model: model, messages: finalMessages };
  if (options && options.max_tokens) {
    if (isReasoning) body.max_completion_tokens = options.max_tokens;
    else body.max_tokens = options.max_tokens;
  }
  if (options && options.temperature !== undefined && !isReasoning) body.temperature = options.temperature;
  const resp = await fetchWithTimeout(baseUrl + "/chat/completions", {
    method: "POST",
    headers: buildProviderHeaders("openai-compatible", apiKey, baseUrl),
    body: JSON.stringify(body),
    cache: "no-store"
  }, timeoutMs);
  if (!resp.ok) throw await parseProviderError(resp);
  let data;
  try { data = await resp.json(); }
  catch (e) {
    const err = new Error("Unexpected response format: invalid JSON");
    err.category = "unexpected_format";
    throw err;
  }
  if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
    const err = new Error("Unexpected response format");
    err.category = "unexpected_format";
    throw err;
  }
  const text = data.choices[0].message.content;
  if (!text || (typeof text === "string" && text.trim().length === 0)) {
    const err = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  const usage = { in: 0, out: 0, source: "unavailable" };
  if (data.usage) {
    if (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined) {
      usage.in = data.usage.prompt_tokens || 0;
      usage.out = data.usage.completion_tokens || 0;
      usage.source = "provider_reported";
    }
    if (typeof data.usage.cost === "number") usage.cost = data.usage.cost;
    else if (typeof data.usage.total_cost === "number") usage.cost = data.usage.total_cost;
  }
  return { text: text, usage: usage };
}

async function generateAnthropic(connection, apiKey, messages, options, timeoutMs) {
  const baseUrl = (connection.base_url || ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  let systemText = "";
  const convo = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") systemText += (systemText ? "\n\n" : "") + m.content;
    else convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  const body = { model: model, max_tokens: (options && options.max_tokens) || 2048, messages: convo };
  if (systemText) body.system = systemText;
  if (options && options.temperature !== undefined) body.temperature = Math.max(0, Math.min(1, options.temperature));
  const resp = await fetchWithTimeout(baseUrl + "/messages", {
    method: "POST",
    headers: buildProviderHeaders("anthropic", apiKey, baseUrl),
    body: JSON.stringify(body),
    cache: "no-store"
  }, timeoutMs);
  if (!resp.ok) throw await parseProviderError(resp);
  let data;
  try { data = await resp.json(); }
  catch (e) {
    const err = new Error("Unexpected response format: invalid JSON");
    err.category = "unexpected_format";
    throw err;
  }
  if (!data || !Array.isArray(data.content)) {
    const err = new Error("Unexpected response format");
    err.category = "unexpected_format";
    throw err;
  }
  let text = "";
  for (let i = 0; i < data.content.length; i++) {
    const block = data.content[i];
    if (block.type === "text" && block.text) text += block.text;
  }
  if (!text || text.trim().length === 0) {
    const err = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  const usage = (data.usage && (data.usage.input_tokens !== undefined || data.usage.output_tokens !== undefined))
    ? { in: data.usage.input_tokens || 0, out: data.usage.output_tokens || 0, source: "provider_reported" }
    : { in: 0, out: 0, source: "unavailable" };
  return { text: text, usage: usage };
}

async function* streamOpenAICompatible(connection, apiKey, messages, options, signal) {
  const baseUrl = (connection.base_url || OPENAI_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const isReasoning = /(^|[-/])(o[1-9]|gpt-5)/i.test(model);
  const finalMessages = isReasoning
    ? messages.map(function (m) { return m.role === "system" ? { role: "developer", content: m.content } : m; })
    : messages;
  const body = { model: model, messages: finalMessages, stream: true };
  if (options && options.max_tokens) {
    if (isReasoning) body.max_completion_tokens = options.max_tokens;
    else body.max_tokens = options.max_tokens;
  }
  if (options && options.temperature !== undefined && !isReasoning) body.temperature = options.temperature;
  const resp = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: buildProviderHeaders("openai-compatible", apiKey, baseUrl),
    body: JSON.stringify(body),
    signal: signal,
    cache: "no-store"
  });
  if (!resp.ok) throw await parseProviderError(resp);
  if (!resp.body) {
    const err = new Error("No response body");
    err.category = "unexpected_format";
    throw err;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage = { in: 0, out: 0, source: "unavailable" };
  let hasContent = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.indexOf("data:") !== 0) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { continue; }
        const choice = parsed.choices && parsed.choices[0];
        if (choice && choice.delta && typeof choice.delta.content === "string" && choice.delta.content.length > 0) {
          hasContent = true;
          yield { type: "text", text: choice.delta.content };
        }
        if (parsed.usage) {
          usage.in = parsed.usage.prompt_tokens || usage.in || 0;
          usage.out = parsed.usage.completion_tokens || usage.out || 0;
          usage.source = "provider_reported";
          if (typeof parsed.usage.cost === "number") usage.cost = parsed.usage.cost;
          else if (typeof parsed.usage.total_cost === "number") usage.cost = parsed.usage.total_cost;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  if (!hasContent) {
    const err = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  yield { type: "usage", usage: usage };
}

async function* streamAnthropic(connection, apiKey, messages, options, signal) {
  const baseUrl = (connection.base_url || ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  let systemText = "";
  const convo = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") systemText += (systemText ? "\n\n" : "") + m.content;
    else convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  const body = { model: model, max_tokens: (options && options.max_tokens) || 2048, messages: convo, stream: true };
  if (systemText) body.system = systemText;
  if (options && options.temperature !== undefined) body.temperature = Math.max(0, Math.min(1, options.temperature));
  const resp = await fetch(baseUrl + "/messages", {
    method: "POST",
    headers: buildProviderHeaders("anthropic", apiKey, baseUrl),
    body: JSON.stringify(body),
    signal: signal,
    cache: "no-store"
  });
  if (!resp.ok) throw await parseProviderError(resp);
  if (!resp.body) {
    const err = new Error("No response body");
    err.category = "unexpected_format";
    throw err;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage = { in: 0, out: 0, source: "unavailable" };
  let hasContent = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.indexOf("data:") !== 0) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { continue; }
        if (parsed.type === "content_block_delta" && parsed.delta && parsed.delta.type === "text_delta" && typeof parsed.delta.text === "string") {
          hasContent = true;
          yield { type: "text", text: parsed.delta.text };
        }
        if (parsed.type === "message_start" && parsed.message && parsed.message.usage) {
          usage.in = parsed.message.usage.input_tokens || 0;
          usage.source = "provider_reported";
        }
        if (parsed.type === "message_delta" && parsed.usage) {
          usage.out = parsed.usage.output_tokens || usage.out || 0;
          usage.source = "provider_reported";
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  if (!hasContent) {
    const err = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  yield { type: "usage", usage: usage };
}

async function* streamProviderResponse(env, connection, messages, options, stallTimeoutMs) {
  const ownerId = connection.telegram_id !== undefined && connection.telegram_id !== null ? connection.telegram_id : 0;
  const apiKey = await decryptCredential(env, ownerId, connection.encrypted_key, connection.key_iv);
  const controller = new AbortController();
  let stallTimer = null;
  const resetStall = function () {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(function () { controller.abort(); }, stallTimeoutMs);
  };
  resetStall();
  try {
    const inner = connection.provider === "anthropic"
      ? streamAnthropic(connection, apiKey, messages, options, controller.signal)
      : streamOpenAICompatible(connection, apiKey, messages, options, controller.signal);
    for await (const event of inner) {
      resetStall();
      yield event;
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

export async function generateWithConnection(env, connection, messages, options, timeoutMs) {
  const ownerId = connection.telegram_id !== undefined && connection.telegram_id !== null ? connection.telegram_id : 0;
  const apiKey = await decryptCredential(env, ownerId, connection.encrypted_key, connection.key_iv);
  const timeout = timeoutMs || AI_PRIMARY_ATTEMPT_TIMEOUT_MS;
  if (connection.provider === "anthropic") return await generateAnthropic(connection, apiKey, messages, options, timeout);
  return await generateOpenAICompatible(connection, apiKey, messages, options, timeout);
}

export async function fetchAvailableModels(provider, baseUrl, apiKey) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  if (!base) return { models: [], error: "invalid_base_url" };
  const headers = buildProviderHeaders(provider, apiKey, base);
  if (provider === "anthropic") return await fetchAnthropicModels(base, headers);
  return await fetchOpenAICompatibleModels(base, headers);
}

async function fetchOpenAICompatibleModels(base, headers) {
  const all = [];
  let afterId = null;
  let pageCount = 0;
  const maxPages = 5;
  try {
    while (pageCount < maxPages) {
      let url = base + "/models";
      if (afterId) url += "?after=" + encodeURIComponent(afterId);
      const resp = await fetchWithTimeout(url, { method: "GET", headers: headers, cache: "no-store" }, AI_TEST_TIMEOUT_MS);
      if (!resp.ok) {
        if (pageCount === 0) {
          const err = await parseProviderError(resp);
          return { models: [], error: normalizeError(err, err.status), diagnostic: err.message };
        }
        break;
      }
      let data;
      try { data = await resp.json(); }
      catch (e) { break; }
      let raw = [];
      if (Array.isArray(data)) raw = data;
      else if (data && Array.isArray(data.data)) raw = data.data;
      else if (data && Array.isArray(data.models)) raw = data.models;
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (typeof item === "string") all.push({ id: item });
        else if (item && typeof item.id === "string") all.push({ id: item.id, name: item.name || item.id });
      }
      if (data && data.has_more === true && data.last_id) {
        afterId = data.last_id;
        pageCount++;
      } else {
        break;
      }
    }
    all.sort(function (a, b) { return a.id.localeCompare(b.id); });
    return { models: all, error: null };
  } catch (err) {
    return { models: [], error: normalizeError(err, err.status), diagnostic: err.message };
  }
}

async function fetchAnthropicModels(base, headers) {
  const all = [];
  let afterId = null;
  let pageCount = 0;
  const maxPages = 5;
  try {
    while (pageCount < maxPages) {
      let url = base + "/models?limit=100";
      if (afterId) url += "&after_id=" + encodeURIComponent(afterId);
      const resp = await fetchWithTimeout(url, { method: "GET", headers: headers, cache: "no-store" }, AI_TEST_TIMEOUT_MS);
      if (!resp.ok) {
        if (pageCount === 0) {
          const err = await parseProviderError(resp);
          return { models: [], error: normalizeError(err, err.status), diagnostic: err.message };
        }
        break;
      }
      let data;
      try { data = await resp.json(); }
      catch (e) { break; }
      const list = (data && Array.isArray(data.data)) ? data.data : [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (item && typeof item.id === "string") {
          all.push({ id: item.id, name: item.display_name || item.id });
        }
      }
      if (data && data.has_more === true && data.last_id) {
        afterId = data.last_id;
        pageCount++;
      } else {
        break;
      }
    }
    all.sort(function (a, b) { return a.id.localeCompare(b.id); });
    return { models: all, error: null };
  } catch (err) {
    return { models: [], error: normalizeError(err, err.status), diagnostic: err.message };
  }
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

export async function* tryStreamWithFallback(env, user, messages, options) {
  const conns = await getEnabledUserConnections(env, user.telegram_id);
  if (conns.length === 0) {
    yield { type: "error", category: "no_connection", error: null, connection: null, attempts: 0, fallbackUsed: false, partial: false };
    return;
  }
  const fallbackEnabled = !user || user.fallback_enabled !== 0;
  const budgetStart = Date.now();

  let primaryConn = null;
  if (user && user.active_connection_id) {
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].connection_id === user.active_connection_id) { primaryConn = conns[i]; break; }
    }
  }
  if (!primaryConn) {
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].is_global === 1 && conns[i].is_default === 1) { primaryConn = conns[i]; break; }
    }
  }
  const ordered = [];
  if (primaryConn) ordered.push(primaryConn);
  for (let i = 0; i < conns.length; i++) {
    if (ordered.indexOf(conns[i]) === -1) ordered.push(conns[i]);
  }

  let lastError = null;
  let lastCategory = "unknown";
  let lastConn = null;
  let totalAttempts = 0;

  for (let i = 0; i < ordered.length; i++) {
    const conn = ordered[i];
    const isPrimary = i === 0;
    if (!isPrimary) {
      if (!fallbackEnabled && !isRetryableCategory(lastCategory)) break;
      if ((conn.consecutive_failures || 0) >= UNHEALTHY_FAILURE_THRESHOLD) continue;
    }
    const budgetRemaining = AI_STREAM_TOTAL_BUDGET_MS - (Date.now() - budgetStart);
    if (budgetRemaining < 3000) break;

    const maxAttemptsForConn = isPrimary ? AI_MAX_PRIMARY_ATTEMPTS : 1;

    for (let attempt = 0; attempt < maxAttemptsForConn; attempt++) {
      const remaining = AI_STREAM_TOTAL_BUDGET_MS - (Date.now() - budgetStart);
      if (remaining < 3000) break;
      if (attempt > 0) {
        const delay = AI_RETRY_DELAYS_MS[attempt - 1] || 1000;
        await sleep(delay);
      }
      totalAttempts++;
      const stallTimeout = Math.min(AI_STREAM_STALL_TIMEOUT_MS, AI_STREAM_TOTAL_BUDGET_MS - (Date.now() - budgetStart));
      let currentUsage = null;
      let attemptYielded = false;

      try {
        for await (const event of streamProviderResponse(env, conn, messages, options, stallTimeout)) {
          if (event.type === "text") {
            attemptYielded = true;
            yield { type: "text", text: event.text };
          } else if (event.type === "usage") {
            currentUsage = event.usage;
          }
        }
        await recordConnectionSuccess(env, conn.connection_id);
        yield { type: "done", connection: conn, usage: currentUsage, attempts: totalAttempts, fallbackUsed: !isPrimary };
        return;
      } catch (err) {
        lastError = err;
        lastCategory = normalizeError(err, err.status);
        lastConn = conn;
        await recordConnectionFailure(env, conn.connection_id);
      }

      if (attemptYielded) {
        yield { type: "error", category: lastCategory, error: lastError, connection: lastConn, attempts: totalAttempts, fallbackUsed: !isPrimary, partial: true };
        return;
      }
      if (!isRetryableCategory(lastCategory)) break;
    }

    if (!isRetryableCategory(lastCategory) && !fallbackEnabled) break;
  }

  yield { type: "error", category: lastCategory, error: lastError, connection: lastConn || primaryConn, attempts: totalAttempts, fallbackUsed: false, partial: false };
}

export async function notifyAdminOnError(env, opts) {
  try {
    const admins = getAdminIds(env);
    if (admins.length === 0) return;
    const connectionId = opts.connection_id || "none";
    const category = opts.category || "unknown";
    const throttleKey = "anotify:" + category + ":" + connectionId;
    try {
      const existing = await env.KV.get(throttleKey);
      if (existing === "1") return;
      await env.KV.put(throttleKey, "1", { expirationTtl: ADMIN_NOTIFY_THROTTLE_TTL });
    } catch (err) {}
    const lines = [];
    lines.push("🚨 <b>Nyra Error Alert</b>");
    lines.push("");
    if (opts.connection_label) lines.push("<b>Connection:</b> " + escapeHtml(opts.connection_label));
    if (opts.provider) lines.push("<b>Provider:</b> " + escapeHtml(opts.provider));
    if (opts.model) lines.push("<b>Model:</b> <code>" + escapeHtml(opts.model) + "</code>");
    lines.push("<b>Category:</b> <code>" + escapeHtml(category) + "</code>");
    lines.push("<b>Message:</b> " + escapeHtml(humanizeError(category)));
    lines.push("<b>Attempts:</b> " + (opts.attempts || 0));
    if (opts.raw_error) lines.push("<b>Last error:</b> <code>" + escapeHtml(truncate(String(opts.raw_error), 300)) + "</code>");
    if (opts.user_id) lines.push("<b>User:</b> <code>" + opts.user_id + "</code>");
    if (opts.chat_id) lines.push("<b>Chat:</b> <code>" + opts.chat_id + "</code>");
    if (opts.fallback_used) lines.push("<b>Fallback:</b> used");
    lines.push("<b>Time:</b> " + new Date().toISOString());
    const text = lines.join("\n");
    for (let i = 0; i < admins.length; i++) {
      await sendMessage(env, admins[i], text, { parse_mode: "HTML" });
    }
  } catch (err) { console.error("notifyAdminOnError failed:", err.message); }
}
