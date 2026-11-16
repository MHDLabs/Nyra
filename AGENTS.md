# Agent guide for Nyra

Instructions for automated coding agents working in this repository.

## Purpose

Nyra is a Cloudflare Worker Telegram assistant with Mini App, admin panel, D1, Queues, and AI provider integrations.

## Important directories

| Path | Role |
|------|------|
| `src/` | Application source |
| `src/utils/` | Shared utilities (import via `src/utils.ts` facade) |
| `src/miniapp/` | Mini App API handlers |
| `src/admin-panel/` | External admin panel routes |
| `types/` | Shared TypeScript contracts |
| `test/` | `node:test` suites |
| `docs/engineering/` | Engineering task records |
| `public/` | Static assets |

## Canonical commands

```bash
npm ci
npm run typecheck
npm run typecheck:worker
npm run typecheck:web
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
```

Use repository-local binaries after `npm ci`. Node.js 22 matches CI.

## Workflow rules

1. Sync to latest `origin/main` before new work.
2. One independent Issue → one branch → one PR per root cause.
3. All GitHub content in **English**.
4. Prefer the smallest complete fix (`/simple-code` principles).
5. Never force-push, never rewrite published history, never push to `main` directly.
6. Never commit secrets or real tokens.
7. Do not deploy to production unless explicitly instructed.
8. Do not remove `@ts-nocheck` from large modules without scoped tests.
9. Preserve Telegram, queue, and crypto compatibility unless the Issue requires a change.

## Testing

Add regression tests next to the change. Do not weaken tests to hide product failures.

## Security

Use `redactSecrets` / `safeErrorDetail` for logs. Prefer `jsonErrorFromException` in Mini App handlers. Report sensitive findings privately when possible.
