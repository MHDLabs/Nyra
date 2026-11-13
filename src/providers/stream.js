// Streaming dispatch. Credentials are decrypted once here, and a stall
// watchdog aborts the request if the provider stops emitting for too long —
// a hung SSE connection would otherwise burn the entire fallback budget.
import { decryptCredential } from "../crypto.js";
import { streamOpenAICompatible } from "./openai.js";
import { streamAnthropic } from "./anthropic.js";

export async function* streamProviderResponse(env, connection, messages, options, stallTimeoutMs) {
  if (connection.provider === "workers-ai" || connection.provider === "cloudflare") {
    if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding unavailable");
    const model = connection.model || "@cf/meta/llama-3.1-8b-instruct";
    const promptMessages = messages.map(function (m) {
      return { role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
    });
    const result = await env.AI.run(model, { messages: promptMessages, max_tokens: (options && options.max_tokens) || 2048 });
    const text = (result && (result.response || result.result || result.text)) || (typeof result === "string" ? result : "");
    if (text && String(text).trim()) yield { type: "text", text: String(text) };
    return;
  }
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
