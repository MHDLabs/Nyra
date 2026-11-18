# Nyra Constitution

**MHDLabs principle: Keep it simple.**

This constitution defines the target architecture for Nyra after the approved simplification. It supersedes previous principles that required Mini App, BYOK, Anthropic, multiple AI connections, or route management.

**Status:** Approved by project maintainer  
**Version:** 2.0.0  
**Ratified:** 2026-11-18  
**Last Amended:** 2026-11-18

## Core Principles

### I. Simplicity Over Feature Count

Nyra must remain a small, understandable Telegram assistant. Prefer the smallest design that fully solves the problem. Avoid speculative abstractions, duplicate systems, unnecessary dependencies, and features without a clear user need. YAGNI is a requirement, not a suggestion.

### II. Telegram-First Product

Telegram is the primary user interface. Do not add or restore a Telegram Mini App. Keep the existing bot commands, inline interactions, and Persian/English user experience where useful.

The separate web admin panel at /admin-panel is a required product surface and must remain. It is not the Mini App. Preserve src/admin-panel/, public/admin-panel/, /admin-api/*, and the Cloudflare Assets binding required by the panel.

### III. One Shared OpenAI-Compatible Model

All users use one centrally configured OpenAI-compatible API endpoint and one model:

- AI_BASE_URL — endpoint base URL
- AI_MODEL — model identifier
- AI_API_KEY — Cloudflare Worker secret

The central credentials belong to the operator, not individual users. Never expose the API key to users or client-side code. Do not implement user-owned API keys, multiple provider connections, Anthropic Messages API, model discovery, model switching, route management, token rotation, or cross-model fallback.

Use a simple provider adapter. Retry the same endpoint only when a bounded retry is safe for a transient failure. Normal per-user rate limits remain necessary because all users share the operator's API account and costs.

### IV. Preserve User Data

Product simplification is not permission to erase unrelated data. Preserve conversations, chat archives, user memories, profiles, group settings, admin records, and useful usage data.

Use forward-only, versioned migrations. Remove only state that belongs to explicitly retired features. Never reset a production database or perform destructive production operations during implementation. Test migration safety with representative fixtures.

### V. Secure by Default

Keep secrets in Cloudflare Worker secrets or private environment configuration. Never store the central API key in D1, expose it through the web admin panel, return it from an API, or write it to logs.

Validate Telegram and HTTP input at boundaries. Retain webhook authentication, admin authorization, secret redaction, and appropriate rate limits. Remove an encryption secret only after all retained encryption use has been audited.

### VI. Keep the Runtime Lean

Keep Cloudflare Workers, D1, KV, and Queues where they provide real value. Keep the webhook and queue processing model, status endpoint, operational recovery, and DLQ where still required.

Remove reminder delivery, voice transcription, speech generation, Mini App APIs/assets, schedules, proactive check-ins, and their orphaned cron jobs and settings. Do not replace them with new UI or framework layers.

### VII. Test Before Merge

Every behavior change requires focused regression tests. Migrations require tests proving that retained user data survives. Never delete or weaken tests merely to get a green CI run.

Before merge, run the relevant checks, including:

- npm run typecheck
- npm run typecheck:worker
- npm run typecheck:web
- npm run test:all
- ./node_modules/.bin/wrangler deploy --dry-run

Use the repository-local toolchain and verify the actual scripts in package.json.

## Development Workflow

- Read docs/PRODUCT-SCOPE.md before implementation.
- One coherent change per branch and pull request.
- Branch from the latest main; do not push directly to main.
- Never force-push or rewrite published history.
- Do not deploy to production unless explicitly authorized.
- Keep technical documentation, code comments, issues, PRs, and commits in English; keep the Persian README in Persian.
- Prefer existing utilities and patterns. Add dependencies only when a clear need is demonstrated.

## Governance

The maintainer may amend this constitution. Amendments must update the version, rationale, and amendment date. The product scope in docs/PRODUCT-SCOPE.md must remain consistent with this constitution.

---

**MHDLabs — Keep it simple.**
