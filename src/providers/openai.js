// OpenAI-compatible provider: /chat/completions (buffered and streamed) and
// the paginated /models listing. Covers OpenAI itself, OpenRouter, Groq,
// Together, Fireworks, DeepSeek, Ollama and anything else speaking the same
// dialect.
import { AI_TEST_TIMEOUT_MS, OPENAI_DEFAULT_URL, ANTHROPIC_VERSION, APP_TITLE } from "../config.js";
import { isOpenRouterUrl, fetchWithTimeout } from "../utils.js";
import { parseProviderError, normalizeError } from "./errors.js";
import { toOpenAIContent } from "./content.js";

export function buildProviderHeaders(provider, apiKey, baseUrl) {
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

export async function generateOpenAICompatible(connection, apiKey, messages, options, timeoutMs) {
  const baseUrl = (connection.base_url || OPENAI_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const isReasoning = /(^|[-/])(o[1-9]|gpt-5)/i.test(model);
  const allowImages = connection.supports_vision === 1;
  const finalMessages = messages.map(function (m) {
    const role = isReasoning && m.role === "system" ? "developer" : m.role;
    return { role: role, content: toOpenAIContent(m.content, allowImages) };
  });
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

export async function* streamOpenAICompatible(connection, apiKey, messages, options, signal) {
  const baseUrl = (connection.base_url || OPENAI_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const isReasoning = /(^|[-/])(o[1-9]|gpt-5)/i.test(model);
  const allowImages = connection.supports_vision === 1;
  const finalMessages = messages.map(function (m) {
    const role = isReasoning && m.role === "system" ? "developer" : m.role;
    return { role: role, content: toOpenAIContent(m.content, allowImages) };
  });
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

export async function fetchOpenAICompatibleModels(base, headers) {
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
