# TypeScript Cutover Notes

## What changed

Nyra migrated from a JavaScript Worker to a TypeScript Worker in ten sequential
tasks (see `TASK-0N-*.md`). Runtime behavior was preserved; the primary outcome
is typed boundaries for env, DB, Telegram, AI streams, and reminders.

## Operator impact

- Deploy path unchanged: `wrangler deploy` (main = `src/index.ts`).
- Secrets and bindings unchanged.
- Tests: `npm test` (tsx).

## Rollback

If a deploy must revert to the pre-migration JS tree, use the annotated baseline
tag documented in `BASELINE.md` and redeploy that commit. Prefer forward fixes
on `main` when possible.

## Follow-ups (non-blocking)

1. Remove `// @ts-nocheck` from domain modules one PR at a time.
2. Optional port of `public/app.js` into `web-src` with a small build step.
3. Restore `noImplicitAny: true` on hardened packages once call sites are annotated.
