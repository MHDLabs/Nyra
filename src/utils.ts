// Nyra — utilities facade. Implementation lives under src/utils/*.
// Call sites keep importing from "./utils.js".

export { now, okResponse, jsonResponse, sleep, fetchWithTimeout } from "./utils/runtime.js";

export {
  truncate,
  escapeHtml,
  escapeRegex,
  containsPhrase,
  stripTelegramHtml,
  containsNyraWord
} from "./utils/text.js";

export {
  constantTimeEqual,
  generateShortId,
  bytesToBase64,
  base64ToBytes
} from "./utils/encoding.js";

export { isOpenRouterUrl } from "./utils/provider-url.js";

export { safeCallbackId, buildUserContent, splitForTelegram } from "./utils/telegram.js";
export type { UserContentMessage } from "./utils/telegram.js";

export {
  sanitizeMemoryString,
  sanitizeMemoryFact,
  dedupeArray,
  filterSubstrings
} from "./utils/memory.js";

export { parseAdminIds, isAdmin, getAdminIds } from "./utils/admin.js";
export type { AdminIdResult, AdminEnv } from "./utils/admin.js";

export { checkMemoryRate, checkRateLimit } from "./utils/rate-limit.js";
