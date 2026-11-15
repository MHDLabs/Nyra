# Task 10 — Final Hardening and Cutover

## Migration status

The Nyra Worker codebase is TypeScript-first:

| Layer | State |
|-------|--------|
| Entry (`src/index.ts`) | Typed |
| Telegram adapter | Typed |
| DB (`src/db/**`) | Typed |
| Providers (`src/providers/**`) | Typed |
| Core validators / errors | Typed |
| Reminders (tz/schedule contracts) | Typed |
| Domain / UI routers | TS sources, progressive typing |
| Browser shell (`public/`) | Static JS assets + `web-src` ambient types |

No application `src/**/*.js` remains.

## Tooling

```bash
npm run typecheck          # worker + web
npm run test               # 332 tests via tsx
npm run test:all           # includes TS smoke tests
```

`wrangler.toml` main: `src/index.ts`.

## Progressive typing policy

Modules still carrying `// @ts-nocheck` are intentional interim boundaries
(large command/callback/parser/UI routers). Contracts live under `types/`.
Future PRs should remove nocheck file-by-file while keeping tests green.

## Baseline

JS baseline tag from Task 1 remains for rollback reference:
`nyra-js-baseline-*` (see BASELINE.md).

## Cutover checklist

- [x] Default branch builds with `tsc -p tsconfig.worker.json`
- [x] Full test suite green under `tsx`
- [x] Worker entry is TypeScript
- [x] Engineering task docs Tasks 2–10 present
- [x] No force-push / history rewrite required for cutover
