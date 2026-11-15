# Task 13 — TypeScript Phase-2 Hardening

## Scope

Removed `@ts-nocheck` from:

- `src/formatter.ts`
- `src/config.ts`

No other modules were hardened. `redact.ts` and `websearch.ts` remain deferred (security boundaries).

## Coverage counts

| Metric | Before | After |
|--------|-------:|------:|
| `@ts-nocheck` under `src/` | 60 | 58 |

All `src/**/*.ts` remain in the worker compiler program (Task 12). The 58 residual files still suppress diagnostics via `@ts-nocheck`.

## Type decisions

### formatter.ts

- `TelegramParseMode`, `FormattedChunk`, `SafeFormatResult` document the Telegram-facing contract.
- Table/list/code/quote inputs accept `unknown` / readonly arrays and coerce with `String(...)` as before.
- Chunking helpers return `FormattedChunk[]` with `parseMode: null` for plain splits.
- Casts from `splitMarkdownV2` results are limited to the shared `FormattedChunk` shape (markdown module still progressive).

### config.ts

- Removed the migration `@ts-nocheck` header.
- `AI_RETRY_DELAYS_MS: number[]`.
- `PersonalityDefinition` and typed `DEFAULT_PERSONALITIES`.
- Explicit `string[]` / `number[]` / `Record<string, string>` on reminder timezone helpers and retired personality ids.
- **No value changes** — only annotations.

## Runtime invariants preserved

- `MAX_TELEGRAM_LENGTH` (4096) and all numeric constants unchanged.
- MarkdownV2 escaping and chunk ordering unchanged.
- `MINIAPP_DISABLED` and personality prompts unchanged.

## Tests

Boundary cases added in `test/markdown.test.js`:

- Empty/null table, list, code, plainText, escape, safeFormat
- Plain chunk length guarantee
- Non-MarkdownV2 parse mode fallback

## Recommended Task 14

1. `src/utils.ts` (high fan-in — annotate carefully in isolation)
2. Small pure helpers still under nocheck (e.g. `dlq` display helpers if low risk)
3. Dedicated security tasks for `redact.ts` and `websearch.ts` with expanded suites
4. Do not enable `noImplicitAny: true` until more modules are annotated
