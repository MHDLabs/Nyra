# Task 4 — Database TypeScript Migration

## Scope

All modules under `src/db/` are TypeScript (`.ts`). The facade `src/db.js` continues to re-export `./db/index.js` (resolved to `index.ts` by Wrangler/tsx).

## Added / converted

| Path | Notes |
|------|--------|
| `types/database.ts` | Row shapes (UserRow, ConnectionRow, …) |
| `types/env.ts` | Concrete `NyraEnv` with D1/KV/Queue/AI |
| `src/db/helpers.ts` | `firstRow` / `allRows` / `runSql` |
| `src/db/*.ts` | Converted from `.js` with `env: NyraEnv` |

## Tooling notes

- `package.json` `test` script uses `tsx --test` so Node can load `.ts` modules.
- `tsconfig.worker.json` keeps `strict` / `strictNullChecks`; `noImplicitAny` is **false** for this progressive migration (document for Task 7/10 to restore full implicit-any coverage on refined signatures).
- Dynamic D1 `.bind(...array)` sites use narrow casts where Cloudflare's tuple overloads reject runtime-valid spreads.

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean
npx tsx --test test/*.test.js     # existing suite
```

## Non-goals

- No schema/data migrations that alter production tables beyond existing `schema.ts` logic.
- No rewrite of reminder algorithm or connection crypto.
