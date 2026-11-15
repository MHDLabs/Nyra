# TypeScript Migration Plan

Baseline tag: `nyra-js-baseline-a86b96e`  
Strategy: **ten sequential tasks**, one branch/PR each, full tests before advancing.

## Principles

- Strict TypeScript; no `any` / `@ts-ignore` shortcuts.
- Validate untrusted input at boundaries (Telegram, JSON columns, tool args).
- Preserve runtime behavior and Cloudflare bindings.
- Split large modules only when responsibilities diverge.
- Keep Worker bundle lightweight (no new heavy frameworks).

## Task sequence

| # | Branch | Focus |
|---|--------|--------|
| 1 | `migration/task-01-baseline` | Audit, docs, baseline tag, issues |
| 2 | `migration/task-02-tooling` | tsconfig, wrangler types, scripts |
| 3 | `migration/task-03-core-types` | Errors, env, shared contracts |
| 4 | `migration/task-04-database` | `src/db/*` typed rows |
| 5 | `migration/task-05-telegram-runtime` | Worker entry, telegram, queue |
| 6 | `migration/task-06-ai-providers` | Providers, stream, fallback |
| 7 | `migration/task-07-domain-refactor` | Commands, memory, tools, menus |
| 8 | `migration/task-08-reminders` | Parser + scheduling |
| 9 | `migration/task-09-web-frontend` | Mini App + admin panel TS sources |
| 10 | `migration/task-10-final-hardening` | Remove legacy JS, CI, docs, final tag |

## High-risk modules

- `reminders/parse.js` — golden behavior tests before structural change.
- `providers/fallback.js` — stream event discriminated unions.
- `handlers/callback.js` — callback payload unions.
- `db/schema.js` — migrations must stay additive.

## Tooling intent (Task 2)

- `tsconfig.worker.json` / `tsconfig.web.json`
- `wrangler types` → `worker-configuration.d.ts`
- `tsx` for TS tests when ready
- Prefer keeping `.js` import specifiers if resolution allows

## Issue policy

Pre-existing product defects → GitHub Issues + `fix/issue-N-*` branches.  
Pure migration compiler work → stay on the migration task branch.

## Success milestone

Tag `nyra-typescript-migration-<short-sha>` only after Task 10 merges and CI is green.  
Never delete `nyra-js-baseline-a86b96e`.
