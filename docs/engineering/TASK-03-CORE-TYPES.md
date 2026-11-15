# Task 3 — Core Types, Validation, Errors

## Added

| Path | Role |
|------|------|
| `types/domain.ts` | Locale, memory mode, provider categories, ids |
| `types/errors.ts` | `AppError` union, `Result`, ok/err |
| `types/events.ts` | Stream/queue/callback sketch types |
| `src/core/validate.ts` | Boundary validators |
| `src/core/errors.ts` | AppError helpers, retryability, safe log line |
| `test/core-types.test.ts` | Regression tests |

## Design notes

- Provider categories match `src/providers/errors.js` string set for a clean Task 6 swap-in.
- Runtime JS modules are **not** rewritten in this task; foundation only.
- Validators treat external data as `unknown` and return `Result` or null.

## Commands

```bash
npx tsc -p tsconfig.worker.json
npx tsx --test test/core-types.test.ts test/ts-smoke.test.ts
npm test
```
