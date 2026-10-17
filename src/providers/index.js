// Nyra — provider layer barrel.
//
// `src/ai.js` re-exports this file, so importing "./ai.js" still yields the
// same public surface. Only `public` symbols cross this boundary:
//   errors.js    error classification + user-facing text
//   content.js   message content -> provider wire shapes
//   openai.js    OpenAI-compatible chat (non-streaming + streaming) + /models
//   anthropic.js Anthropic messages (non-streaming + streaming) + /models
//   stream.js    stream dispatch + stall watchdog
export {
  normalizeError, humanizeError, shouldNotifyAdmin
} from "./errors.js";

export {
  fetchAvailableModels, testConnectionRaw, testUserConnectionById
} from "./models.js";

export {
  generateWithConnection, tryStreamWithFallback, notifyAdminOnError
} from "./fallback.js";
