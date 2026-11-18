# Contributing to Nyra

Thanks for helping improve Nyra.

## Project principles

Nyra is a Telegram-first AI assistant running on Cloudflare Workers.

**Keep it simple.** Prefer small, understandable changes over new layers, frameworks, or dependencies.

The target product behavior is defined in [docs/PRODUCT-SCOPE.md](docs/PRODUCT-SCOPE.md). Read it before implementing features or removing legacy code.

## Development setup

- Node.js 22
- npm (the repository lockfile is authoritative)

~~~bash
npm ci
npm run typecheck
npm run typecheck:worker
npm run typecheck:web
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

Check package.json for the authoritative list of scripts.

## Architecture boundaries

- src/ — Cloudflare Worker application and Telegram bot
- src/admin-panel/ — separate web admin API and routes
- public/admin-panel/ — static web admin assets
- types/ — shared TypeScript contracts
- test/ — automated tests
- .specify/ — Spec Kit configuration and constitution
- .pi/prompts/ — Pi Spec Kit commands

The web admin panel at /admin-panel is retained. It is **not** the Telegram Mini App. Do not delete the web panel or its asset binding while removing Mini App code.

## Branch and review workflow

1. Start from the latest main.
2. Make one focused change on a descriptive branch.
3. Add or update regression tests.
4. Run the relevant typechecks and tests.
5. Open a pull request against main.
6. Merge only after required checks pass.

Do not push directly to main, force-push, or deploy to production without explicit authorization.

## Coding standards

- Prefer the smallest correct implementation.
- Reuse existing utilities and patterns where they are appropriate.
- Avoid unrelated refactors and speculative abstractions.
- Do not add dependencies without a clear need.
- Do not introduce new @ts-nocheck, @ts-ignore, or broad any shortcuts.
- Keep runtime and data compatibility unless a planned change explicitly requires otherwise.

## Data safety

Preserve user conversations, memory, profiles, groups, and administrative data. Retired feature data may be removed only through a versioned, tested migration. Never reset a production database to simplify a migration.

## Security

- Never commit real tokens, API keys, passwords, or encryption keys.
- Use synthetic credentials in tests.
- Redact secrets from logs and error responses.
- Follow [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Documentation

Technical documentation, issues, pull requests, and commits are written in English. The Persian user guide remains in README.fa.md.
