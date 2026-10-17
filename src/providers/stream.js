// Streaming dispatch. Credentials are decrypted once here, and a stall
// watchdog aborts the request if the provider stops emitting for too long —
// a hung SSE connection would otherwise burn the entire fallback budget.
import { decryptCredential } from "../crypto.js";
import { streamOpenAICompatible } from "./openai.js";
import { streamAnthropic } from "./anthropic.js";

export async function* streamProviderResponse(env, connection, messages, options, stallTimeoutMs) {
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
