# Implementation Checklist

Tracking file for the Nyra product simplification. See [SIMPLIFICATION-ROADMAP.md](SIMPLIFICATION-ROADMAP.md) for phase gates and detailed scope.

## Phase 0 — Baseline

- [x] Read product scope, constitution, agent guide, workflow, package scripts, and repository tree.
- [x] Create isolated working branch from current `main`.
- [x] Identify retained Web Admin Panel paths and required validation commands.
- [ ] Run and record baseline typechecks, tests, and Wrangler dry-run.

## Phase 1 — Mini App removal

- [ ] Remove Mini App routes, APIs, auth, UI, assets, settings, types, and tests.
- [ ] Remove Mini App menu-button setup while retaining Telegram bot commands.
- [ ] Preserve `/admin-panel`, `/admin-api/*`, `src/admin-panel/`, `public/admin-panel/**`, and Assets binding.
- [ ] Verify admin panel routing and authorization.

## Phase 2 — Central AI architecture

- [ ] Implement one central OpenAI-compatible client.
- [ ] Use server-side `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY`.
- [ ] Preserve streaming, tools, web search/fetch, and compatible vision behavior.
- [ ] Remove Anthropic, Workers AI, provider selection, and provider fallbacks.
- [ ] Remove BYOK, connection management, per-user/per-group model selection, and model discovery.
- [ ] Remove routes, multi-model/token rotation, and cross-model fallback.
- [ ] Remove Shared Service mode and separate quotas/settings.
- [ ] Preserve normal user/chat rate limits and meaningful usage accounting.
- [ ] Verify central credentials never reach client code, logs, or responses.

## Phase 3 — Data and configuration

- [ ] Add safe forward-only migrations for retired state.
- [ ] Preserve conversations, messages, memories, profiles, groups, admin data, broadcasts, and useful usage history.
- [ ] Remove obsolete database repositories, columns, types, and settings only after dependency review.
- [ ] Preserve historical migration files.
- [ ] Remove encryption/provider secrets only after auditing all retained use.
- [ ] Add migration safety regression tests.

## Phase 4 — Reminders, voice, and automations

- [ ] Remove reminder commands, parser, delivery, tables, and cron work.
- [ ] Remove STT/TTS, transcript storage, voice modules, and related config/dependencies.
- [ ] Return a clear unsupported-feature reply for incoming voice notes.
- [ ] Remove schedules and proactive check-ins completely.
- [ ] Preserve webhook maintenance, queues, retries, DLQ, and failed-update cleanup.

## Phase 5 — Cleanup and documentation

- [ ] Remove dead routes, callbacks, menus, imports, modules, tests, fixtures, and dependencies.
- [ ] Update Wrangler configuration and environment examples.
- [ ] Update README.md and README.fa.md.
- [ ] Update PRODUCT-SCOPE.md, constitution, AGENTS.md, workflow, and relevant docs.
- [ ] Keep Web Admin Panel documentation and behavior accurate.
- [ ] Ensure no stale feature claims remain.

## Phase 6 — Final verification

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run test:all`
- [ ] `./node_modules/.bin/wrangler deploy --dry-run`
- [ ] Focused regression tests pass.
- [ ] Full diff and removed-feature searches reviewed.
- [ ] CI remains two CodeQL checks plus one combined verification/deploy workflow.
- [ ] PR opened with test evidence; no production deploy or production data mutation.

> A task remains unchecked until the actual implementation and its verification evidence are available. Documentation updates alone do not complete runtime tasks.
