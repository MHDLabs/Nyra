# Contributing to Nyra

Thank you for contributing. This document describes the practical workflow used by this repository.

## Project overview

Nyra is a Cloudflare Workers Telegram bot with Mini App and admin surfaces, D1 storage, Queues, and optional Workers AI bindings.

## Development setup

Requirements:

- Node.js 22 (matches CI)
- npm (lockfile is authoritative)

```bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
```

Do not invent scripts. Canonical npm scripts live in `package.json`:

| Script | Purpose |
|--------|---------|
| `typecheck` / `typecheck:worker` / `typecheck:web` | TypeScript checks |
| `test` / `test:ts` / `test:all` | Test suites |
| `deploy` / `deploy:worker` | Deployment (maintainers) |

## Architecture (practical)

- `src/` — Worker application code
- `types/` — shared TypeScript contracts
- `public/` — static Mini App / admin assets
- `test/` — `node:test` suites
- `docs/engineering/` — task and design notes

## Branch and issue workflow

1. Open or update a focused GitHub Issue (English).
2. Branch from latest `main`: `fix/issue-N-short-description` or `security/...` / `docs/...`.
3. Implement the smallest complete fix with regression tests.
4. Run typecheck and `npm run test:all`.
5. Open a PR against `main`. Do not push directly to `main`.
6. Merge only when required checks pass. Prefer squash merge when available.
7. Delete the temporary branch after merge.

## Coding standards

- Prefer the smallest correct change; avoid unrelated refactors.
- Reuse existing utilities (`src/utils/`, `src/redact.ts`, `src/miniapp/respond.ts`).
- Do not add dependencies without a demonstrated need.
- Do not introduce `@ts-nocheck`, `@ts-ignore`, or broad `any` in new code.
- Keep runtime behavior stable unless the issue requires a change.

## Security

- Never commit real tokens, API keys, or encryption keys.
- Use synthetic fixtures in tests only.
- See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Documentation

- GitHub Issues, PRs, commits, and technical docs are written in **English**.
- Localized user docs such as `README.fa.md` may remain bilingual where they already exist.
