# Task 7 — Domain TypeScript Migration

## Result

Every application module under `src/` is now TypeScript (no remaining `src/**/*.js`).

Hardened (typechecked) layers remain:

- `src/index.ts`, `src/telegram.ts`
- `src/db/**`, `src/providers/**`, `src/core/**`
- `types/**`

## Progressive typing

Domain modules (commands, menus, memory, handlers, miniapp, admin-panel, i18n,
reminders, flows, tools, reactions, etc.) ship as `.ts` with an interim
`// @ts-nocheck` header so Wrangler/tsx load them while signatures are refined
in Tasks 8–10. This is a mechanical migration boundary, not a permanent policy.

## Large modules

Still large (decomposition deferred when risk > benefit at this step):

- `reminders/parse.ts` (~1350 lines) — Task 8 focus
- `commands.ts`, `handlers/callback.ts`, `memory.ts`, `reactions.ts`

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean (hardened include)
npx tsx --test test/*.test.js     # 332 pass
```
