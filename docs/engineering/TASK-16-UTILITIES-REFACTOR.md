# Task 16 — Core Utilities Decomposition & TypeScript Hardening

## Architecture

`src/utils.ts` is now a **compatibility facade** re-exporting focused modules:

| Module | Exports |
|--------|---------|
| `utils/runtime.ts` | `now`, `okResponse`, `jsonResponse`, `sleep`, `fetchWithTimeout` |
| `utils/text.ts` | `truncate`, `escapeHtml`, `escapeRegex`, `containsPhrase`, `stripTelegramHtml`, `containsNyraWord` |
| `utils/encoding.ts` | `constantTimeEqual`, `generateShortId`, `bytesToBase64`, `base64ToBytes` |
| `utils/provider-url.ts` | `isOpenRouterUrl`, `normalizeBaseUrl` |
| `utils/telegram.ts` | `safeCallbackId`, `buildUserContent`, `splitForTelegram` |
| `utils/memory.ts` | `sanitizeMemoryString`, `sanitizeMemoryFact`, `dedupeArray`, `filterSubstrings` |
| `utils/admin.ts` | `parseAdminIds`, `isAdmin`, `getAdminIds` |
| `utils/rate-limit.ts` | `checkMemoryRate`, `checkRateLimit` (shared Map) |

Call sites continue to import from `./utils.js` / `../utils.js`.

## TypeScript

- Removed `@ts-nocheck` from the utility layer.
- Explicit parameter/return types on all public helpers.
- Types: `AdminIdResult`, `AdminEnv`, `UserContentMessage`.

## Coverage

`@ts-nocheck` under `src/`: 56 → 55 (utils facade + new modules have no nocheck).

## Tests

`test/utils.test.js` expanded for runtime, admin, memory, telegram split, encoding, provider URL, rate limits.

## Compatibility

No intentional runtime behavior changes. No call-site import path migrations.
