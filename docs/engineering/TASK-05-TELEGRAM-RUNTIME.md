# Task 5 — Telegram Runtime & Worker Entry

## Converted to TypeScript

| Module | Status |
|--------|--------|
| `src/index.ts` | Worker entry (`fetch` / `queue` / `scheduled`) typed |
| `src/telegram.ts` | Bot API adapter; `tg()` returns `TelegramApiResponse` |
| `types/telegram.ts` | Update, Message, CallbackQuery, API envelope |

## Intentionally still JavaScript

Handler modules under `src/handlers/*.js` remain JS for this task. They are
imported by the typed entry and will be migrated in Task 7 (domain refactor)
with full callback/message typing. Wrangler bundles them alongside TS sources.

## Configuration

- `wrangler.toml` `main = "src/index.ts"`
- `tsconfig.worker.json` includes entry, telegram, db, core, types
- `useUnknownInCatchVariables: false` and `noImplicitAny: false` retained as progressive settings from Task 4–5

## Queue semantics (unchanged)

- Dedup by `update_id` at webhook
- Conversation key grouping in queue consumer
- `safeAck` / `safeRetry` with same-chat chain ordering

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean
npx tsx --test test/*.test.js     # suite green
```
