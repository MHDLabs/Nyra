# Agent Guide

Instructions for Pi and other automated coding agents working in Nyra.

## Product direction

Nyra is a Telegram-first AI assistant on Cloudflare Workers, maintained by MHDLabs.

**Keep it simple.** Prefer the smallest complete change. Avoid speculative abstractions, unnecessary dependencies, duplicate configuration, and unrelated refactors.

Read [docs/PRODUCT-SCOPE.md](docs/PRODUCT-SCOPE.md) before product work. It defines the target architecture and the approved removal scope.

## Non-negotiable product boundaries

- Use one centrally configured OpenAI-compatible API endpoint, API key, and model for all users.
- Do not reintroduce per-user API keys, provider connections, Anthropic Messages API, multiple models, or route management.
- The Telegram bot is the primary user interface. Do not add a Mini App.
- The separate web admin panel at /admin-panel **must remain**.
- Removing the Mini App must not remove src/admin-panel/, public/admin-panel/, /admin-panel, /admin-api/*, or the Cloudflare Assets binding needed by the web panel.
- Do not reintroduce reminders, voice transcription, or text-to-speech.
- Preserve user conversations, memory, profiles, groups, and admin data when removing legacy feature tables.

## Important paths

| Path | Role |
| --- | --- |
| src/ | Cloudflare Worker application |
| src/admin-panel/ | Separate web admin panel |
| public/admin-panel/ | Web admin static assets |
| types/ | Shared TypeScript contracts |
| test/ | Node test suites |
| .specify/memory/constitution.md | Project architecture principles |
| .pi/prompts/ | Pi Spec Kit commands |
| docs/PRODUCT-SCOPE.md | Product scope and acceptance criteria |

The Mini App and the web admin panel are not interchangeable. Keep the latter.

## Development commands

Node.js 22; use repository-local tools:

~~~bash
npm ci
npm run typecheck
npm run typecheck:worker
npm run typecheck:web
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

Do not invent npm scripts. Check package.json before using an unfamiliar command.

## Working rules

1. Sync with the latest origin/main before starting new work.
2. Use one focused branch and PR for a coherent change.
3. Never push directly to main, force-push, or rewrite published history.
4. Do not deploy to production unless explicitly instructed.
5. Keep technical documentation, issues, PRs, and commits in English. Keep README.fa.md in Persian.
6. Do not add dependencies without a demonstrated need.
7. Do not weaken or delete tests just to make CI pass.
8. Update both English and Persian user-facing docs when product behavior changes.

## Data and migrations

- Preserve chats, message history, user profiles, memory, groups, and admin records.
- Remove only data belonging to explicitly retired features, using a versioned and tested migration.
- Never reset D1, wipe production data, or change production secrets as a shortcut.
- Audit every use of a secret before removing its binding or configuration.
- Never log, return, or commit API keys or other secrets.

## Security and testing

- Validate untrusted Telegram updates and API input at boundaries.
- Use existing redaction helpers for logs and errors.
- Add focused regression tests for changed behavior.
- Run typechecks, relevant tests, the full test suite, and Wrangler dry-run before proposing a merge.
