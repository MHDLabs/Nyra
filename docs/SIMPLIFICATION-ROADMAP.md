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

- [x] Remove Mini App routing, APIs, authentication, UI, assets, menu-button setup, and Mini App-only settings/types/tests.
- [x] Remove Mini App-only environment variables and build/deployment remnants.
- [x] Keep `/admin-panel`, `/admin-api/*`, `src/admin-panel/`, `public/admin-panel/**`, and the Cloudflare Assets binding.
- [x] Make the non-admin root path behavior explicit (no orphaned Mini App shell).
- [x] Verify admin panel serving, authentication, and authorization paths remain wired (auth regression test + Wrangler dry-run, CI run [#45035340497](https://github.com/MHDLabs/Nyra/actions/runs/45035340497)).

**Exit:** No Mini App runtime path remains; the standalone Web Admin Panel and its assets remain intact.

## Phase 2 — One central OpenAI-compatible AI client

- [x] Configure one server-side `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY`.
- [x] Route chat and memory requests through one OpenAI-compatible client.
- [x] Preserve streaming and tool calling; web search/fetch remains on the same tool path, and vision is explicitly opt-in for compatible models.
- [x] Remove Anthropic and Workers AI model use, provider selection, and provider/model fallback.
- [x] Remove per-user/per-group model selection and connection setup flows.
- [x] Remove multi-model, multi-provider, route, token-rotation, and cross-model fallback logic.
- [x] Remove the Shared Service mode and its separate quotas/settings surface.
- [x] Preserve ordinary per-user/per-chat rate limits and usage accounting.
- [ ] Add explicit regression coverage for API-key redaction and browser/API non-exposure.

**Exit:** All users use exactly one centrally configured OpenAI-compatible endpoint and model; no provider/model management surface remains.

## Phase 3 — Safe database and configuration cleanup

- [x] Remove runtime references and preserve historical migration files; physical schema cleanup remains gated on a complete inventory.
- [ ] Add and test a forward-only, idempotent migration to remove retired-only credentials and feature state.
- [x] Remove obsolete runtime database repositories, types, and settings.
- [x] Preserve conversations, messages, memories, profiles, groups, admin records, broadcasts, and usage data.
- [x] Preserve historical migrations; no production data has been touched.
- [x] Remove `ENCRYPTION_KEY` from runtime requirements; encrypted legacy BYOK rows remain pending explicit cleanup.
- [x] Remove obsolete Workers AI binding and encryption-key requirement; keep central `AI_API_KEY` server-side.

**Exit:** Runtime no longer depends on retired tables/columns; preserved data is protected by migration regression tests.

## Phase 4 — Remove reminders, voice, schedules, and proactive automations

- [x] Remove reminder parsing, commands, delivery modules, and reminder cron work from runtime.
- [x] Remove STT, TTS, voice adapters, transcript handling, and voice-only configuration.
- [x] Reply clearly in Persian and English that voice notes are unsupported.
- [x] Remove schedules, proactive check-ins, their runtime settings/modules, and scheduled delivery.
- [x] Preserve webhook self-healing, schema maintenance, bot commands, queue retries, DLQ, and failed-update cleanup.
- [x] Retain required maintenance cron and remove feature-specific reminder/proactive/schedule deliveries.

**Exit:** No retired automation or voice feature is active or reachable; operational maintenance still works.

## Phase 5 — Dependency, command, UI, and documentation cleanup

- [x] Remove dead commands, callbacks, menus, imports, modules, and feature-specific tests.
- [x] Remove obsolete environment variables and add `docs/CONFIGURATION.md` plus Worker variables.
- [x] Update English and Persian READMEs, Product Scope, and configuration documentation.
- [x] Product Scope now reflects implementation status; AGENTS.md and constitution already describe the approved target. Spec Kit workflow remains generic.
- [x] Keep docs focused; no historical audit collection was reintroduced.

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
