import type { NyraEnv } from "../../types/env.js";
// OpenAI-compatible provider: /chat/completions (buffered and streamed) and
// the paginated /models listing. Covers OpenAI itself, OpenRouter, Groq,
// Together, Fireworks, DeepSeek, Ollama and anything else speaking the same
// dialect.
import { OPENAI_DEFAULT_URL, APP_TITLE } from "../config.js";
import { isOpenRouterUrl } from "../utils.js";
import { parseProviderError } from "./errors.js";
import { toOpenAIContent } from "./content.js";

export function buildProviderHeaders(provider, apiKey, baseUrl) {
  const headers: any = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey
  };
  if (isOpenRouterUrl(baseUrl)) {
    headers["HTTP-Referer"] = "https://t.me";
    headers["X-Title"] = APP_TITLE;
  }
  return headers;
}

export async function generateOpenAICompatible(connection, apiKey, messages, options, timeoutMs) {
  const baseUrl = (connection.base_url || OPENAI_DEFAULT_URL).replace(/\/+$/, "");
  const model = connection.model;
  const isReasoning = /(^|[-/])(o[1-9]|gpt-5)/i.test(model);
  const allowImages = connection.supports_vision === 1;
  const finalMessages = messages.map(function (m: any) {
    const role = isReasoning && m.role === "system" ? "developer" : m.role;
    const mapped: any = { role: role, content: toOpenAIContent(m.content, allowImages) };
    if (Array.isArray(m.tool_calls)) mapped.tool_calls = m.tool_calls;
    if (m.tool_call_id) mapped.tool_call_id = m.tool_call_id;
    return mapped;
  });
  const body: any = { model: model, messages: finalMessages };
  if (options && options.max_tokens) {
    if (isReasoning) body.max_completion_tokens = options.max_tokens;
    else body.max_tokens = options.max_tokens;
  }
  if (options && options.temperature !== undefined && !isReasoning) body.temperature = options.temperature;
  if (options && Array.isArray(options.tools) && options.tools.length && !isReasoning) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
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
    const err: any = new Error("Unexpected response format: invalid JSON");
    err.category = "unexpected_format";
    throw err;
  }
  if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
    const err: any = new Error("Unexpected response format");
    err.category = "unexpected_format";
    throw err;
  }
  const assistant = data.choices[0].message;
  const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  const text = assistant.content;
  if (toolCalls.length) {
    const usage: any = { in: 0, out: 0, source: "unavailable" };
    if (data.usage) {
      usage.in = data.usage.prompt_tokens || 0;
      usage.out = data.usage.completion_tokens || 0;
      usage.source = "provider_reported";
    }
    return { text: typeof text === "string" ? text : "", toolCalls, assistantMessage: assistant, usage };
  }
  if (!text || (typeof text === "string" && text.trim().length === 0)) {
    const err: any = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  const usage: any = { in: 0, out: 0, source: "unavailable" };
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
  const finalMessages = messages.map(function (m: any) {
    const role = isReasoning && m.role === "system" ? "developer" : m.role;
    const mapped: any = { role: role, content: toOpenAIContent(m.content, allowImages) };
    if (Array.isArray(m.tool_calls)) mapped.tool_calls = m.tool_calls;
    if (m.tool_call_id) mapped.tool_call_id = m.tool_call_id;
    return mapped;
  });
  const body: any = { model: model, messages: finalMessages, stream: true };
  if (options && options.max_tokens) {
    if (isReasoning) body.max_completion_tokens = options.max_tokens;
    else body.max_tokens = options.max_tokens;
  }
  if (options && options.temperature !== undefined && !isReasoning) body.temperature = options.temperature;
  if (options && Array.isArray(options.tools) && options.tools.length && !isReasoning) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  const resp = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: buildProviderHeaders("openai-compatible", apiKey, baseUrl),
    body: JSON.stringify(body),
    signal: signal,
    cache: "no-store"
  });
  if (!resp.ok) throw await parseProviderError(resp);
  if (!resp.body) {
    const err: any = new Error("No response body");
    err.category = "unexpected_format";
    throw err;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage: any = { in: 0, out: 0, source: "unavailable" };
  let hasContent = false;
  const streamedToolCalls = new Map<number, any>();
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
        const deltaCalls = choice && choice.delta && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : [];
        for (const deltaCall of deltaCalls) {
          const index = Number.isInteger(deltaCall.index) ? deltaCall.index : streamedToolCalls.size;
          const current = streamedToolCalls.get(index) || {
            id: "",
            type: "function",
            function: { name: "", arguments: "" }
          };
          if (typeof deltaCall.id === "string") current.id = deltaCall.id;
          if (deltaCall.type) current.type = deltaCall.type;
          if (deltaCall.function && typeof deltaCall.function.name === "string") current.function.name += deltaCall.function.name;
          if (deltaCall.function && typeof deltaCall.function.arguments === "string") current.function.arguments += deltaCall.function.arguments;
          streamedToolCalls.set(index, current);
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
  const toolCalls = Array.from(streamedToolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(entry => entry[1]);
  if (toolCalls.length) {
    for (const call of toolCalls) {
      if (!call.id || !call.function.name) {
        const err: any = new Error("Malformed streamed tool call");
        err.category = "unexpected_format";
        throw err;
      }
    }
    yield { type: "tool_calls", toolCalls: toolCalls };
  }
  if (!hasContent && toolCalls.length === 0) {
    const err: any = new Error("Empty response from provider");
    err.category = "empty_response";
    throw err;
  }
  yield { type: "usage", usage: usage };
}

