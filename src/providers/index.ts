import type { NyraEnv } from "../../types/env.js";
// Nyra — provider layer barrel.
//
// `src/ai.js` re-exports this file, so importing "./ai.js" still yields the
// same public surface. Only `public` symbols cross this boundary:
//   errors.js    error classification + user-facing text
//   content.js   message content -> provider wire shapes
//   config.js    one operator-owned OpenAI-compatible model configuration
//   openai.js    OpenAI-compatible chat completions
//   fallback.js  central model execution, tools, and admin error notifications
export {
  normalizeError, humanizeError, shouldNotifyAdmin
} from "./errors.js";

export {
  generateWithConnection, generateAgentWithConnection, tryAgentWithFallback, notifyAdminOnError
} from "./fallback.js";
