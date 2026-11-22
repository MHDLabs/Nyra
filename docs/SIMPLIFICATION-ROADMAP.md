# Nyra Simplification Roadmap

**Status:** In progress  
**Working branch:** `refactor/full-product-simplification`  
**Base:** `main` at `2b12ab4cd7308b2c7209eb1e43e63899c2a47408`  
**Principle:** Keep it simple :)

This roadmap tracks the approved runtime simplification. A checkbox is completed only after code changes are reviewed and the corresponding validation evidence exists. Documentation-only changes do not count as runtime implementation.

## Phase 0 — Baseline and guardrails

- [x] Read the product scope, constitution, agent guide, workflow, package scripts, and current repository tree.
- [x] Confirm `main` is the default branch and create one focused working branch.
- [x] Identify the exact validation commands and the retained Web Admin Panel boundary.
- [ ] Capture a passing baseline test/typecheck/dry-run result.

**Exit:** Baseline is understood, no production change has been made, and the working branch is isolated.

## Phase 1 — Remove Telegram Mini App, preserve Web Admin

- [ ] Remove Mini App routing, APIs, authentication, UI, assets, menu-button setup, and Mini App-only settings/types/tests.
- [ ] Remove Mini App-only environment variables and build/deployment remnants.
- [ ] Keep `/admin-panel`, `/admin-api/*`, `src/admin-panel/`, `public/admin-panel/**`, and the Cloudflare Assets binding.
- [ ] Make the non-admin root path behavior explicit (no orphaned Mini App shell).
- [ ] Verify admin panel serving, authentication, and authorization paths remain wired.

**Exit:** No Mini App runtime path remains; the standalone Web Admin Panel and its assets remain intact.

## Phase 2 — One central OpenAI-compatible AI client

- [ ] Configure one server-side `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY`.
- [ ] Route every AI request through one OpenAI-compatible client.
- [ ] Preserve streaming, tool calling, web search, and model-supported vision.
- [ ] Remove Anthropic and Cloudflare Workers AI provider/model fallbacks.
- [ ] Remove per-user/per-group model selection and connection setup flows.
- [ ] Remove multi-model, multi-provider, route, token-rotation, and cross-model fallback logic.
- [ ] Remove the Shared Service mode and its separate quotas/settings surface.
- [ ] Preserve ordinary per-user/per-chat rate limits and useful usage accounting.
- [ ] Ensure API credentials are never exposed to users, browser code, logs, or responses.

**Exit:** All users use exactly one centrally configured OpenAI-compatible endpoint and model; no provider/model management surface remains.

## Phase 3 — Safe database and configuration cleanup

- [ ] Inventory all schema, migration, foreign-key, and runtime references before changing persistence.
- [ ] Add forward-only, versioned, idempotent migrations for retired feature state.
- [ ] Remove obsolete runtime database repositories, types, and settings.
- [ ] Preserve conversations, messages, memories, profiles, groups, admin records, broadcasts, and meaningful usage data.
- [ ] Preserve historical migrations and never reset or mutate production data.
- [ ] Remove `ENCRYPTION_KEY` only after proving retained runtime data no longer requires it.
- [ ] Remove obsolete secrets and bindings only after all references are gone.

**Exit:** Runtime no longer depends on retired tables/columns; preserved data is protected by migration regression tests.

## Phase 4 — Remove reminders, voice, schedules, and proactive automations

- [ ] Remove reminder parsing, commands, delivery, persistence, and cron work.
- [ ] Remove STT, TTS, voice adapters, transcript storage, and voice-only dependencies/configuration.
- [ ] Reply clearly that voice notes are unsupported instead of silently treating them as text.
- [ ] Remove schedules, proactive check-ins, their APIs/settings/state, and scheduled delivery.
- [ ] Preserve webhook self-healing, schema maintenance, bot commands, queue retries, DLQ, and failed-update cleanup.
- [ ] Remove obsolete cron configuration without removing required maintenance behavior.

**Exit:** No retired automation or voice feature is active or reachable; operational maintenance still works.

## Phase 5 — Dependency, command, UI, and documentation cleanup

- [ ] Remove dead commands, callbacks, menus, imports, modules, tests, fixtures, and dependencies.
- [ ] Remove obsolete environment variables and update example configuration.
- [ ] Update English and Persian READMEs and all relevant technical documentation.
- [ ] Align `AGENTS.md`, product scope, constitution, and Spec Kit workflow with the implemented system.
- [ ] Keep docs short and avoid reintroducing archived audit collections.

**Exit:** No stale product claims, dead runtime modules, or unused feature dependencies remain.

## Phase 6 — Validation and review

- [ ] Run `npm ci`.
- [ ] Run `npm run typecheck` (worker and web).
- [ ] Run `npm run test:all`.
- [ ] Run `./node_modules/.bin/wrangler deploy --dry-run`.
- [ ] Add/verify focused regression tests for central AI configuration, retained Telegram behavior, admin panel, and migration safety.
- [ ] Review the complete diff and search for retired feature references.
- [ ] Verify GitHub Actions remains one combined CI/deploy workflow plus the two CodeQL checks.
- [ ] Open a reviewable PR; do not merge or deploy to production without explicit authorization.

**Exit:** All available checks pass, the PR documents evidence and known limitations, and no production deployment/data mutation occurred.

## Scope decisions

### Remove
Reminders; STT; TTS; Telegram Mini App; BYOK; Anthropic Messages API; multi-model/multi-provider management; model routing and Route Management; model/token rotation; Shared Service mode and its quota/settings surface; schedules; proactive check-ins.

### Preserve
Telegram text chat and group support; context and memory; personalities; custom instructions; web search/fetch; vision when supported by the configured model; admin commands; broadcasts; standalone Web Admin Panel; authentication/authorization; rate limiting; D1/KV/Queues; retries; DLQ; webhook self-healing; status endpoint; usage and operational data.

### Safety boundaries
- Never push directly to `main`, force-push, or rewrite history.
- Never deploy to production or mutate production secrets.
- Never reset D1 or destroy unrelated user data.
- Never edit historical migrations.
- Never mark a task complete without implementation and verification evidence.
