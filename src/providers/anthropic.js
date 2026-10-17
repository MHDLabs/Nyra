// Anthropic Messages API. System prompts are lifted out of the message list
// into the top-level `system` field, and the SSE event names differ from the
// OpenAI dialect, so this is a genuinely separate adapter rather than a
// configuration of openai.js.
import { AI_TEST_TIMEOUT_MS, ANTHROPIC_DEFAULT_URL } from "../config.js";
import { fetchWithTimeout } from "../utils.js";
import { parseProviderError, normalizeError } from "./errors.js";
import { toAnthropicContent } from "./content.js";

export async function generateAnthropic(connection, apiKey, messages, options, timeoutMs) {
  const baseUrl = (connection.base_url || ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const allowImages = connection.supports_vision === 1;
  let systemText = "";
  const convo = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") systemText += (systemText ? "\n\n" : "") + (typeof m.content === "string" ? m.content : "");
    else convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: toAnthropicContent(m.content, allowImages) });
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

export async function* streamAnthropic(connection, apiKey, messages, options, signal) {
  const baseUrl = (connection.base_url || ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const allowImages = connection.supports_vision === 1;
  let systemText = "";
  const convo = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") systemText += (systemText ? "\n\n" : "") + (typeof m.content === "string" ? m.content : "");
    else convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: toAnthropicContent(m.content, allowImages) });
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

export async function fetchAnthropicModels(base, headers) {
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
