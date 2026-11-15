# Architecture Audit (JavaScript Baseline)

Baseline: `a86b96e` / tag `nyra-js-baseline-a86b96e`

## Composition root

- `src/index.js` — Worker fetch / queue / scheduled entry; routes HTTP (`/webhook`, `/status`, `/setup`, `/api/*`, `/admin-panel`, `/admin-api/*`).

## Layering (observed)

| Layer | Modules | Notes |
|-------|---------|--------|
| HTTP / Telegram transport | `telegram.js`, `handlers/*` | Webhook ack + queue handoff |
| Queue / ordering | `handlers/queue.js` (and related) | Same-chat serialization; `max_concurrency=1` |
| Commands / UI menus | `commands.js`, `menus.js`, `handlers/callback.js` | Large, multi-responsibility |
| AI orchestration | `providers/fallback.js`, `providers/openai.js`, `anthropic.js`, `stream.js` | Single long attempt policy |
| Tools | `tools.js` | web_search, web_fetch, memory, react_to_message |
| Persistence | `src/db/*`, `schema.js` | D1 + migrations; JSON columns |
| Memory / prompts | `memory.js` | Clock (Gregorian/Jalali/Hijri), consolidation |
| Reminders / schedules | `reminders/*`, `schedules/*`, `db/reminders.js` | Parser is largest module |
| Mini App | `miniapp/*`, `public/app.js` | Disabled by config |
| Admin web | `admin-panel/*`, `public/admin-panel/*` | Separate from Mini App |
| i18n | `i18n/*` | fa / en |

## Oversized modules (review candidates for Task 7+)

Threshold guidance: review > ~400 lines; attention > ~600 lines.

| File | Approx size | Responsibilities |
|------|-------------|------------------|
| `reminders/parse.js` | ~57 KB | NL date/time parsing |
| `i18n/messages-miniapp.js` | ~45 KB | Translation dictionary (OK to stay large) |
| `commands.js` | ~31 KB | Admin + user commands, menus |
| `db/schema.js` | ~31 KB | DDL + migrations + seeds |
| `memory.js` | ~30 KB | Prompt build, consolidate, personalities |
| `handlers/callback.js` | ~28 KB | All inline callback namespaces |
| `reminders/commands.js` | ~27 KB | Reminder UX commands |
| `providers/fallback.js` | ~25 KB | Route/stream/fallback/agent |
| `menus.js` | ~24 KB | Settings UI screens |
| `reactions.js` | ~24 KB | Classify + set reactions |
| `telegram.js` | ~23 KB | Bot API client |
| `handlers/ai-message.js` | ~21 KB | AI turn + streaming UI |

## Coupling observations

- `db.js` facade re-exports many `db/*` helpers — convenient but widens import surface.
- Callback namespace handling is centralized in one large switch-style module.
- AI streaming, tools, and guest prefix logic live in the hot path (`ai-message` + `fallback`).
- Reminder parser is self-contained but hard to type without behavioral golden tests.

## Strengths

- Queue-first webhook design avoids Telegram 30s webhook limits.
- Explicit encryption for stored API keys.
- Broad automated test coverage for a Worker-sized project (332 tests).
- Clear product switches (Mini App off, single AI attempt).

## Risks for TypeScript migration

1. Implicit shapes from D1 `first()` / `all()` without row types.
2. Untrusted Telegram update fields used without narrow parsers.
3. Provider stream events as ad-hoc objects.
4. Flow state in KV as free-form JSON.
5. Large files increasing merge conflict cost during migration.

## Target direction (non-binding)

Preserve domain folders; introduce shared contracts gradually (Task 3+); split only where responsibilities diverge; keep Worker lightweight (no new heavy frameworks).
