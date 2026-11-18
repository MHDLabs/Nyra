# Nyra

**A lightweight AI assistant for Telegram, running on Cloudflare Workers.**

Maintained by **MHDLabs**.  
**Keep it simple.**

[English](README.md) · [فارسی](README.fa.md)

## Project status

Nyra is being simplified around a Telegram-first experience and one centrally configured AI model. The current main branch still contains the legacy implementation; this documentation change defines the target and does not remove runtime features by itself.

The target product contract is documented in [Product Scope](docs/PRODUCT-SCOPE.md). Treat it as the source of truth for the next implementation phase.

## Target product

- One shared, administrator-configured OpenAI-compatible API endpoint and model.
- No user-owned API keys, provider connections, multi-model setup, or route management.
- Telegram chat, memory, personalities, custom instructions, web search, supported image input, and group support.
- A separate **web admin panel** remains available at /admin-panel.
- No Mini App, reminders, voice transcription, or speech generation.

The old Mini App and the web admin panel are different products. Removing the Mini App must **not** remove the web admin panel or its static assets.

## Runtime

Nyra runs as a TypeScript Cloudflare Worker. Telegram updates flow through the webhook and Cloudflare Queues. D1 stores persistent application data; KV handles short-lived state and caches. Cloudflare static assets serve the web admin panel.

Main code areas:

| Path | Purpose |
| --- | --- |
| src/ | Worker, Telegram handlers, AI pipeline, admin interfaces, and persistence |
| src/admin-panel/ | Web admin API and routes |
| public/admin-panel/ | Web admin panel assets; preserve these |
| types/ | Shared TypeScript contracts |
| test/ | Automated tests |
| .specify/ | GitHub Spec Kit configuration and project constitution |
| .pi/prompts/ | Pi commands for the Spec Kit workflow |
| docs/PRODUCT-SCOPE.md | Target product requirements and acceptance criteria |

## Development

Use Node.js 22 and the repository lockfile:

~~~bash
npm ci
npm run typecheck
npm run typecheck:worker
npm run typecheck:web
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

Run the checks relevant to your change. Do not deploy to a production Worker unless explicitly asked.

## Configuration

The current branch still uses the legacy provider-connection setup. Its deployment inputs and local examples are documented in .dev.vars.example and wrangler.toml. The target single-model configuration is specified in [Product Scope](docs/PRODUCT-SCOPE.md); do not assume it is already implemented.

## Contributing

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) before changing runtime or deployment behavior.

---

© MHDLabs · Keep it simple.
