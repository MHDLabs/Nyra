# Nyra Constitution

A Cloudflare Worker Telegram assistant with Mini App, admin panel, D1, Queues, and AI provider integrations.

*This document is pending maintainer approval for ratification.*

## Core Principles

### I. Cloudflare Workers Runtime
Nyra runs as a Cloudflare Worker. D1 (database), KV (key-value storage), and Queues resources and bindings must be provisioned and configured per deployment requirements. Workers AI is an optional binding. All three deployment secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET, ENCRYPTION_KEY) require explicit configuration. No deployment secret is derived from another deployment secret.

### II. Multi-Provider AI Integration
Support OpenAI-compatible APIs and Anthropic Messages API with streaming responses. Users add provider connections via Mini App. Automatic fallback within time budget when primary connection fails. Connections encrypted with AES-256-GCM using HKDF-derived per-owner keys from master ENCRYPTION_KEY.

### III. Test-First Development
Behavioral changes require appropriate regression tests. Run `npm run test:all` before merging. Run `npm run typecheck`, `npm run typecheck:worker`, `npm run typecheck:web`, and `./node_modules/.bin/wrangler deploy --dry-run` as part of verification. Prefer Red-Green-Refactor where practical. Never weaken tests merely to make CI pass.

### IV. Security-First Architecture
Deployment secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET, ENCRYPTION_KEY) must be manually configured; never derive one from another. Use `redactSecrets`/`safeErrorDetail` from `src/redact.ts` to scrub sensitive data from logs and error details. Use authorization headers for provider credentials where supported. Never expose credentials in user-facing output. Fail-closed on missing/invalid secrets (HTTP 500). Constant-time comparison for webhook verification. KV-based rate limits fail-open for availability over strictness.

### V. Backward-Compatible Evolution
Existing user data must not be lost. Database changes must be forward-safe and tested. Prefer additive migrations. Destructive schema changes require explicit compatibility and migration strategy. Preserve Telegram API and existing user-facing behavior unless intentional. The `schema_migrations` table tracks applied migrations. Changes are versioned by build SHA via `src/version.ts`.

### VI. Runtime Boundaries
`ctx.waitUntil` provides up to 30 seconds after response completion/disconnect. Fast-path streaming: 25-second total budget, 15-second stall timeout (see `src/config.ts`). Queue consumers run separately with long wall time for AI pipeline. Streaming responses must respect platform limits; use actual config values for defaults.

## Security Requirements

All API keys encrypted with AES-256-GCM using HKDF-derived per-owner keys from master `ENCRYPTION_KEY`. Secrets in URLs are rejected for `/setup`; webhook verification uses `X-Telegram-Bot-Api-Secret-Token` header. Never log Telegram token-bearing URLs. KV-based rate limits fail-open for availability over strictness.

## Development Workflow

Code review required for all changes. Tests must pass before merge via `npm run test:all`. Complexity must be justified. Simplicity (YAGNI) preferred. One Issue → one branch → one PR per root cause. Never force-push, never rewrite published history, never push to main directly. Sync to `origin/main` before new work.

## Governance

All constitutional amendments require maintainer approval before incorporation. Amendments must document their rationale, version impact, and amendment date. This constitution is pending ratification; it has not yet been approved by maintainers.

**Version**: 1.0.0 | **Ratified**: TBD | **Last Amended**: 2026-11-18