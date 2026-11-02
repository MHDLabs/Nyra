# Nyra — Refactor & Debugging Mission TODO

> Live status of the multi-agent refactor. Updated by the Lead after every phase.
> Verification is **offline only**: no provider, Telegram or external network calls.

## Phase A — Repository, capabilities and team

- [x] Inspect repository and working-tree state (Cloudflare Worker + D1 + KV + Queues; Mini App in public/).
- [x] Inspect available DSH capabilities (team agents, shared workspace, task board, messaging, bash, local tests).
- [x] Establish agent ownership and shared interfaces (file-scoped ownership; Lead wires routers/barrels).
- [x] Identify root causes of the reported problems.
- [x] Define integration dependencies and the shared task board (task-1…task-6; task-6 blocked by 2–5).
- [x] Create TODO.md and keep it current.
- [x] Create the real DSH team: lead + routing + miniapp + telegram + security (shared workspace, task board, messaging).
- [x] Add core additive migrations 10–11 (locale/onboarding columns, groups enabled by default, maintenance/default-locale settings).
- [x] Create the centralized i18n framework (src/i18n/) and per-domain dictionary files.

## Phase B — API connections, models and routing ✓ COMPLETE

- [x] Repair the API connection data model (endpoint + credentials + state, no secrets to the frontend).
- [x] Support multiple models per connection (no duplicated Base URL/credentials).
- [x] Model discovery through the provider adapter (mocked/local fixtures only) and manual model entry.
- [x] Discovery failure preserves existing models; distinguish configured / verified / unverified / unavailable.
- [x] Implement routing profiles: primary model, ordered fallbacks, explicit policy.
- [x] Route actual provider selection through the router (no ad-hoc fallback elsewhere).
- [x] Classify provider errors; retry only 429/5xx/timeout, honour Retry-After, bound retries.
- [x] Localized terminal error when every eligible model fails; never leave a request pending.
- [x] Preserve shared (operator) vs personal API isolation; no silent cross-switching.
- [x] Usage recording for routed requests.
- [x] Offline routing / fallback / model tests (9 tests passing).

## Phase C — Telegram Mini App ✓ COMPLETE

- [x] Unify navigation and layout as the single management interface.
- [x] Remove the Mini App chat UI and the /api/chat endpoint (Telegram chat stays).
- [x] Move preferences, language, personality, API connections, models, routing, usage, group management, shared service and maintenance into the Mini App.
- [x] Centralized Mini App localization (en-US / fa-IR) served from the backend dictionary.
- [x] Correct RTL/LTR direction and mixed-direction technical values.
- [x] Consistent loading, error, success and empty states; responsive layout.
- [x] Enforce user/admin access on the backend; no admin UI for regular users.

## Phase D — Onboarding, Telegram workflow and operations ✓ COMPLETE

- [x] Persistent, recoverable onboarding: language → preferred name → personality → free-service disclosure → welcome.
- [x] Localized personality names/descriptions; persisted acceptance; duplicate/stale callback safety.
- [x] Telegram commands limited to /start, /help, /admin; management moved to the Mini App.
- [x] /admin opens the Mini App for authorized administrators only.
- [x] New groups enabled by default; safe migration of existing groups.
- [x] Per-group enable/disable controls in the Mini App; disabled groups get no AI replies.
- [x] Document Telegram group message-delivery limitations (privacy mode).
- [x] Persistent emergency maintenance switch in D1, administrator-only, confirmation, recovery path.
- [x] Maintenance blocks ordinary AI responses in private chats and groups; no repeated notices.
- [x] Remove administrator-ID and secret leaks from all user-facing text and errors.
- [x] Centralized, redacted error handling with diagnostics retained for admins.
- [x] Offline onboarding / commands / groups / maintenance tests (23 tests passing).

## Phase E — Security, data and migrations ✓ COMPLETE

- [x] Audit Mini App initData validation, admin authorization and endpoint gating.
- [x] Audit API credential encryption, Base URL validation and SSRF surface.
- [x] Verify user/group isolation (personal connections, chats, usage).
- [x] Review sensitive logging and redaction.
- [x] Add safe, additive migrations for locale/onboarding/groups/routing; no destructive resets.
- [x] Preserve existing users, conversations, admins, connections, encrypted keys and group settings.
- [x] Independent security review of every agent diff.

## Phase F — Verification and documentation ✓ COMPLETE

- [x] Run the full offline unit-test suite (npm test - 277 tests, 0 failures).
- [x] Run new offline tests for routing, onboarding, maintenance, localization and security.
- [x] Run static checks available offline (node --check, module import smoke tests).
- [x] Offline build check where possible without installing packages.
- [x] Review the complete local diff; fix integration defects.
- [x] Verify acceptance criteria one by one.
- [x] Update README.md, README.fa.md and this checklist.
- [x] Confirm no commits, pushes, deployments, proxies or live integration tests were performed.

---

## FINAL STATUS

**All 6 phases complete.**

**Team agents:**
- routing-engineer: Phase B complete
- miniapp-engineer: Phase C complete
- telegram-engineer: Phase D complete
- security-engineer: Phase E complete
- lead: Integration, testing, Phase F complete

**Test results:** 277 passing, 0 failing (offline only)

**Files changed:** 28 modified, 17 new
**No commits, no pushes, no live tests performed.**

Ready for user review and deployment.