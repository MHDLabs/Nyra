# Task 11 — Toolchain Stabilization

## Goals

Reproducible installs and verification using repository-declared dependencies only.

## Findings

1. **`npm ci`** succeeds with `registry.npmjs.org` and lockfile v3 when `node_modules` is absent.
2. **Audit dry-run failure** was caused by invoking Wrangler **4.16.0** via `npx`, not the lockfile pin **4.42.0**. Array form of `assets.run_worker_first` is valid under 4.42.0; no `wrangler.toml` change required.
3. **`tsconfig.worker.json`** had an absolute `typeRoots` entry (`/tmp/nyra-tools/...`) — removed. Worker uses `"types": []` plus included `worker-configuration.d.ts`.
4. **Web TS2688** came from automatic `@types/node` resolution in a DOM-only project. Fixed with `"types": []` on `tsconfig.web.json` while keeping DOM libs.
5. **Test counts:** `npm test` → 332 cases from `test/*.test.js`. `npm run test:ts` → 2 cases from `test/ts-smoke.test.ts` only. `npm run test:all` → 345 = all `*.test.js` plus all `*.test.ts` (includes `core-types.test.ts`, 13 TS cases total).

## CI

`.github/workflows/ci.yml` and the deploy pre-test job now run `npm ci`, worker/web typecheck, full tests, and `wrangler deploy --dry-run` with project-local binaries.

## Verification (project-local)

Recorded against clean install of lockfile pins:

| Command | Result |
|---------|--------|
| `npm ci` | exit 0 |
| `npm run typecheck:worker` | exit 0 |
| `npm run typecheck:web` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | 332 pass |
| `npm run test:ts` | 2 pass |
| `npm run test:all` | 345 pass |
| `wrangler deploy --dry-run` | exit 0 (4.42.0) |

Pinned tools: typescript@5.7.3, tsx@4.19.2, wrangler@4.42.0, @types/node@22.10.5.
