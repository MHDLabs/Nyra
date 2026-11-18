# Nyra Simplification — Product Scope

**Owner:** MHDLabs  
**Status:** Approved direction; implementation pending  
**Principle:** Keep it simple.

This document is the source of truth for the next Nyra implementation phase. The documentation-preparation change does not itself remove runtime code. The coding agent must inspect the current TypeScript implementation and deliver the target behavior below without deploying to production.

## 1. Product shape

Nyra is a Telegram-first AI assistant running as a Cloudflare Worker. Telegram is the user interface. A separate password-protected web admin panel remains for operators.

The target AI architecture has exactly one centrally configured OpenAI-compatible endpoint, one API key, and one model. Every permitted user uses that same connection.

### Central AI configuration

Use Worker configuration, not per-user D1 records:

- AI_BASE_URL — OpenAI-compatible API base URL. Use the official OpenAI endpoint as the default when omitted.
- AI_MODEL — the single model identifier.
- AI_API_KEY — Cloudflare Worker secret; never expose it to Telegram users, web UI, logs, or API responses.

All users share the operator's provider account and its costs. Keep normal per-user and per-chat rate limits and existing usage accounting where practical. Do not build another quota product to compensate for deleting BYOK.

Only the OpenAI-compatible chat API is supported. One configured model is used for all requests. A bounded retry to that same endpoint for transient transport errors is acceptable; do not switch to another model, connection, provider, or route.

## 2. Remove completely

Remove implementation, user flows, configuration, tests, documentation, and obsolete database state for the following:

1. **Reminder system** — natural-language parser, delivery scheduler, reminder commands, reminder tables, and reminder-specific cron work.
2. **Voice features** — incoming voice transcription (STT), outgoing speech (TTS), voice adapters, Groq voice secrets/configuration, transcript storage, and related commands or UI. Voice notes should receive a short, clear unsupported-feature reply rather than being silently misinterpreted as text.
3. **Telegram Mini App** — Mini App frontend, Mini App router/API, Mini App-only types, build/configuration remnants, Telegram web-app menu button, and Mini App-only settings and tests.
4. **Per-user API keys / BYOK** — user connection setup, editing and deletion flows, encrypted user provider credentials, user defaults for provider connections, and associated UI/commands.
5. **Anthropic Messages API** — Anthropic adapter, provider selection, Anthropic-specific request/response types, tests, settings, and documentation.
6. **Multiple models and Route Management** — connection collections, model discovery/listing, route builder, route model/token tables, model rotation, token rotation, per-chat model selection, fast-model selection, and cross-model fallback.
7. **Shared Service mode** — opt-in shared-model provisioning and its separate quota/settings surface. The central model is the default architecture, not an optional shared mode.
8. **Orphaned automations** — schedules and proactive check-ins, including their Mini App-only settings, database state, scheduled delivery code, and tests. These are retired with the Mini App; do not replace them with a second automation UI.

Do not retain disabled/dead adapters merely for hypothetical future use.

## 3. Preserve

### Telegram experience

Keep the core Telegram bot and its existing useful commands, onboarding, bilingual Persian/English messaging, inline keyboards, and private/group conversation behavior.

Keep, where already implemented and tested:

- AI chat and streaming Telegram replies
- Persistent per-user conversation context and memory controls
- Personalities and custom instructions
- Built-in web search and web fetch tools
- Image input and vision, provided the one configured model supports it; otherwise reply clearly that image understanding is unavailable
- Group activation through mentions/replies/triggers and existing guest-mode behavior
- Message formatting, chunking, and Telegram-safe rendering
- User usage statistics and existing rate limits

Do not introduce replacement UI for removed features unless explicitly requested.

### Web admin panel — must remain

The web admin panel is separate from the Mini App and is a required retained product surface.

Preserve:

- /admin-panel and /admin-api/*
- src/admin-panel/
- public/admin-panel/**
- The authentication/session mechanism and its secret configuration
- User and group administration, block/unblock, relevant usage/system statistics, chat inspection, and broadcast capabilities that currently work
- The Cloudflare Assets binding and routing required to serve the panel

Remove Mini App routes and files without removing the web admin panel. Do not delete the public/ asset layer if the admin panel still depends on it. Remove only the Mini App-specific assets under public/.

The old model-management screen must not continue to expose multiple providers or routes. Keep only a minimal, sanitized display of the configured model if the panel already needs to show AI status; never display the API key. AI credentials are configured through Worker environment variables/secrets, not stored or edited in the web panel.

### Platform and operations

Keep the Cloudflare Worker runtime, Telegram webhook, D1, KV, Queues, status endpoint, webhook self-healing, DLQ inspection/replay, secret redaction, rate limiting, admin authorization, and deploy/CI workflow unless a specific dependency becomes unnecessary.

Keep the Telegram admin commands and operational tools that do not exist solely for removed features.

## 4. Data and migration rules

Preserve all unrelated user and operational data, especially:

- User and chat identities/profiles
- Conversation history and chat archives
- User memories and personalization that remain supported
- Group settings, triggers, and guest-mode state
- Admin allowlists, blocklists, and broadcast history where still used
- Usage and rate-limit data where still meaningful

Only retire data belonging to removed features: per-user provider credentials and connection metadata, routes, reminders, voice transcripts, Mini App-only settings, schedules, and proactive-check-in state.

Use forward-only, versioned D1 migrations. Inspect foreign keys and every read/write path before dropping tables or columns. Do not reset D1, wipe unrelated records, or mutate production data as part of implementation. Add migration tests that prove preserved records remain intact.

Remove ENCRYPTION_KEY only after proving that no retained data or runtime feature still depends on it. Remove Groq voice secrets and obsolete provider settings after their references are gone. Never log or print secret values.

## 5. Keep the implementation small

- Prefer one small OpenAI-compatible provider path over a generic provider framework.
- Prefer environment configuration over a new settings database or provider-management UI.
- Do not add dependencies or frameworks for the removed surfaces.
- Avoid compatibility shims for features that are explicitly retired, except where a safe one-time data migration requires them.
- Keep existing D1, Queue, and Telegram boundaries unless the code audit proves a component is no longer needed.
- Keep the web admin panel isolated from Telegram chat logic and Mini App code.

## 6. Acceptance criteria

The implementation is ready for review when all of the following are true:

- Every user uses exactly one centrally configured OpenAI-compatible endpoint and model.
- No user can add, store, select, or route their own API key or model.
- No Anthropic adapter or Messages API path remains.
- No multi-model, route, model-discovery, token-rotation, or cross-model fallback code remains.
- Reminder, voice STT/TTS, Mini App, schedules, and proactive-check-in surfaces are removed, including orphaned tests and configuration.
- /admin-panel and /admin-api/* still work; public/admin-panel/** and the required Assets binding remain.
- Existing chat history, memory, user/group profiles, and unrelated admin data survive migrations.
- No secret is exposed in logs, HTML, JSON responses, or client-side assets.
- Documentation in README.md, README.fa.md, AGENTS.md, and Spec Kit matches the shipped implementation.
- Relevant tests, full test suite, all typechecks, and Wrangler dry-run pass.
- No production deployment or destructive live-data operation is performed.

## 7. Explicitly out of scope

Do not redesign the visual style of the web admin panel, rewrite the bot personality system, introduce a new frontend framework, replace Cloudflare services, add new providers, or build new automation features as part of this simplification.
