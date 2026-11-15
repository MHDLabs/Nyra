# Task 12 — TypeScript Coverage Expansion & Phase-1 Hardening

## Inventory (recalculated)

| Metric | Count |
|--------|------:|
| `src/**/*.ts` | 101 |
| `types/**/*.ts` | 10 |
| Files with `@ts-nocheck` (before) | 64 |
| Files with `@ts-nocheck` (after) | 60 |
| Worker `include` | `src/**/*.ts`, `types/**/*.ts`, `worker-configuration.d.ts` |

### Program membership vs meaningful checking

- **In program:** all application TS under `src/` and `types/` (expanded from the prior partial include list).
- **Meaningfully checked:** modules without `@ts-nocheck` that participate in `tsc -p tsconfig.worker.json`.
- **Suppressed:** the remaining 60 progressive modules still carry `@ts-nocheck` headers from the migration.

## Compiler coverage change

`tsconfig.worker.json` `include` is now:

```json
["src/**/*.ts", "types/**/*.ts", "worker-configuration.d.ts"]
```

Excluded: `node_modules`, `public`, `web-src`, `test`, `scripts`.

Compiler options were **not** weakened (`strict` remains true; `noImplicitAny` still false until a later phase).

## Modules hardened (phase 1)

| Module | Notes |
|--------|--------|
| `src/version.ts` | `BuildInfo`, `UpstreamCheckResult`; typed `getBuildInfo` / `checkUpstreamUpdate`; JSON narrowed from `unknown` |
| `src/handlers/fast-path.ts` | `NyraEnv` + `TelegramFrom`; boolean return; soft-fail preserved |
| `src/handlers/command-parse.ts` | `ParsedCommand`, entity/source unions; identity filter unchanged |
| `src/i18n/index.ts` | `SupportedLocale`, dict types; `normalizeLocale` / `t` / `messagesForLocale` |

No new `any`, `@ts-ignore`, or `@ts-nocheck` were introduced in these files.

## Tests

Existing suites exercise command parsing and build identity (`test/command-parse.test.js`, `test/version.test.js`, smoke tests). Full suite expected green under `tsx`.

## Remaining debt (suggested Task 13 order)

1. `src/redact.ts`, `src/formatter.ts`, `src/websearch.ts` (pure-ish helpers)
2. `src/config.ts` constants surface
3. `src/utils.ts` (high fan-in — annotate carefully)
4. Small handler modules (`setup`, `status`, `fast-path` done)
5. Defer: `crypto`, `db` entry, queue/webhook, `reminders/parse`, large menus/commands

## Runtime

No intentional behavior changes. Deploy/secrets/queue/providers untouched.
