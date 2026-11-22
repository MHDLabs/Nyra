# Implementation Checklist

Tracking file for the Nyra product simplification. See [SIMPLIFICATION-ROADMAP.md](SIMPLIFICATION-ROADMAP.md) for phase gates and detailed scope.

## Phase 0 — Baseline

- [x] Read product scope, constitution, agent guide, workflow, package scripts, and repository tree.
- [x] Create isolated working branch from current `main`.
- [x] Identify retained Web Admin Panel paths and required validation commands.
- [ ] Run and record baseline typechecks, tests, and Wrangler dry-run.

## Phase 1 — Mini App removal

- [x] Remove Mini App routes, APIs, auth, UI, assets, settings, types, and tests.
- [x] Remove Mini App menu-button setup while retaining Telegram bot commands.
- [x] Preserve `/admin-panel`, `/admin-api/*`, `src/admin-panel/`, `public/admin-panel/**`, and Assets binding.
- [x] Verify admin panel routing and authorization (admin-panel auth tests and Wrangler dry-run pass in CI run [#45035340497](https://github.com/MHDLabs/Nyra/actions/runs/45035340497)).

## Phase 2 — Central AI architecture

- [x] Implement one central OpenAI-compatible client.
- [x] Use server-side `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY`.
- [x] Preserve streaming, tool calling, and model-gated vision; existing web search/fetch tools remain wired through the same central client.
- [x] Remove Anthropic, Workers AI model use, provider selection, and provider/model fallbacks.
- [x] Remove BYOK, connection management, per-user/per-group model selection, and model discovery.
- [x] Remove routes, multi-model/token rotation, and cross-model fallback.
- [x] Remove Shared Service mode and separate quotas/settings.
- [x] Preserve normal user/chat rate limits and usage accounting paths.
- [ ] Verify central credentials never reach client code, logs, or responses.

## Phase 3 — Data and configuration

- [ ] Add and test a forward-only migration to physically remove retired-only database state; runtime repositories are already removed, but historical migrations remain untouched.
- [ ] Preserve conversations, messages, memories, profiles, groups, admin data, broadcasts, and useful usage history.
- [x] Remove obsolete runtime database repositories, types, settings, and provider credential encryption; physical column/table cleanup is deferred to a reviewed migration.
- [x] Preserve historical migration files.
- [x] Remove the obsolete ENCRYPTION_KEY requirement after removing retained runtime use; AI_API_KEY remains a server-side Worker secret.
- [ ] Add migration safety regression tests.

## Phase 4 — Reminders, voice, and automations

- [x] Remove reminder commands, parser, delivery modules, and reminder cron work; historical schema migrations remain.
- [x] Remove STT/TTS, transcript storage, voice modules, and voice-only config.
- [x] Return a clear Persian/English unsupported-feature reply for incoming voice notes.
- [x] Remove schedules and proactive check-ins from runtime modules and scheduled delivery.
- [x] Preserve webhook maintenance, queues, retries, DLQ, and failed-update cleanup.

## Phase 5 — Cleanup and documentation

- [x] Remove retired routes, callbacks, menus, imports, modules, and feature-only tests.
- [x] Update Wrangler variables and add `docs/CONFIGURATION.md`.
- [x] Update English and Persian READMEs.
- [x] Update PRODUCT-SCOPE.md and configuration docs; AGENTS.md and the constitution already reflected the approved target. Workflow did not require a product-specific change.
- [x] Keep Web Admin Panel routes/assets/auth and remove the obsolete model-management screen.
- [ ] Complete a repository-wide stale-reference audit; historical migration references are intentionally retained.

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
