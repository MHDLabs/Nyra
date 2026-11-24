import type { NyraEnv } from "../../types/env.js";
import { toOpenAIContent } from "./content.js";

function providerError(message: string, status?: number): Error {
  const error: any = new Error(message);
  error.category = "provider_error";
  if (status) error.status = status;
  return error;
}
function addToolDelta(map: Map<number, any>, delta: any) {
  const index = Number.isInteger(delta.index) ? delta.index : map.size;
  const current = map.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
  if (typeof delta.id === "string") current.id = delta.id;
  if (delta.type) current.type = delta.type;
  if (delta.function && typeof delta.function.name === "string") current.function.name += delta.function.name;
  if (delta.function && typeof delta.function.arguments === "string") current.function.arguments += delta.function.arguments;
  map.set(index, current);
}
/** Stream text/function-call deltas from Cloudflare's native Workers AI binding. */
export async function* streamCloudflareAI(env: NyraEnv, config: any, messages: any[], options: any, signal?: AbortSignal) {
  if (!env.AI || typeof env.AI.run !== "function") throw providerError("Cloudflare Workers AI binding is not configured.");
  if (signal?.aborted) throw providerError("Workers AI request was aborted.");
  const finalMessages = messages.map((message: any) => ({
    role: message.role === "developer" ? "system" : message.role,
    content: toOpenAIContent(message.content, config.supports_vision === 1),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
  }));
  const input: any = { messages: finalMessages, stream: true };
  if (options?.max_tokens) input.max_tokens = options.max_tokens;
  if (options?.temperature !== undefined) input.temperature = options.temperature;
  if (Array.isArray(options?.tools) && options.tools.length) {
    input.tools = options.tools;
    input.tool_choice = "auto";
  }
  let output: any;
  try { output = await env.AI.run(config.model, input); }
  catch (cause: any) {
    const status = Number(cause?.status || cause?.statusCode);
    if (status && !cause.status) cause.status = status;
    throw cause;
  }
  const stream: any = output && output.body ? output.body : output;
  if (!stream || typeof stream.getReader !== "function") throw providerError("Workers AI returned a non-streaming response.", 502);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasContent = false;
  const toolCalls = new Map<number, any>();
  const usage: any = { in: 0, out: 0, source: "unavailable" };
  let sawUsage = false;
  const parseLine = (line: string): any[] => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return [];
    const raw = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!raw || raw === "[DONE]") return [];
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (parsed?.error) {
      const details = typeof parsed.error === "string" ? parsed.error : parsed.error.message || "Workers AI request failed";
      const status = Number(parsed.status || parsed.error.status || parsed.error.statusCode);
      throw providerError(String(details), status || undefined);
    }
    const events: any[] = [];
    if (typeof parsed.response === "string" && parsed.response.length) {
      hasContent = true;
      events.push({ type: "text", text: parsed.response });
    }
    if (parsed.choices?.[0]) {
      const delta = parsed.choices[0].delta || parsed.choices[0].message || {};
      if (typeof delta.content === "string" && delta.content.length) {
        hasContent = true;
        events.push({ type: "text", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) addToolDelta(toolCalls, call);
    }
    if (Array.isArray(parsed.tool_calls)) parsed.tool_calls.forEach((call: any, index: number) => toolCalls.set(index, call));
    if (parsed.usage && typeof parsed.usage === "object") {
      usage.in = parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0;
      usage.out = parsed.usage.completion_tokens || parsed.usage.output_tokens || 0;
      usage.source = "provider_reported";
      sawUsage = true;
      events.push({ type: "usage", usage: { ...usage } });
    }
    return events;
  };
  const abortReader = () => { try { reader.cancel(); } catch {} };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw providerError("Workers AI request was aborted.");
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) for (const event of parseLine(line)) yield event;
    }
    buffer += decoder.decode();
    if (buffer.trim()) for (const event of parseLine(buffer)) yield event;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    try { reader.releaseLock(); } catch {}
  }
  const calls = Array.from(toolCalls.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
  if (calls.length) {
    for (const call of calls) if (!call?.id || !call?.function?.name) throw providerError("Malformed Workers AI tool call.", 502);
    yield { type: "tool_calls", toolCalls: calls };
  }
  if (!hasContent && calls.length === 0) throw providerError("Workers AI returned an empty response.", 502);
  if (!sawUsage) yield { type: "usage", usage };
}
