# Feature Audit (JavaScript Baseline)

Baseline: `a86b96e` / tag `nyra-js-baseline-a86b96e`  
Legend: **Full** | **Partial** | **Disabled** | **Broken** | **Unverified**

| Domain | Status | Implementation | Tests | Notes |
|--------|--------|----------------|-------|-------|
| Telegram webhook + queue | Full | `index.js`, queue consumer | Yes (ordering, TG retry) | max_concurrency=1 |
| Commands private | Full | `commands.js`, parse | Yes | All commands answer in private |
| Commands groups | Full | Group allowlist silence | Yes | Unknown cmds silent in groups |
| Callbacks | Full | `handlers/callback.js` | Partial | Large surface; some paths lightly tested |
| AI providers + stream | Full | `providers/*` | Yes | Single 120s attempt policy |
| Tools (search/fetch/memory/react) | Full | `tools.js` | Yes | Built-in web search, no API key |
| Memory consolidate | Full | `memory.js` | Yes | Every N messages |
| Clock Jalali/Hijri | Full | `memory.js` buildClockPrompt | Yes | Multi-calendar |
| Group triggers | Full | settings + isGroupTrigger | Yes | Configurable words |
| Guest prefix | Partial | `detectGuestContext` | Unit-level | Depends on getChatMember; rare in practice |
| Reactions | Full | `reactions.js` | Partial | Mention/reply trigger |
| Onboarding v2 | Full | onboarding handlers | Partial | Personality + custom intro |
| Admin Telegram panel | Full | `/admin` menus | Partial | Users list fixed with send fallback |
| Admin web panel | Full | `/admin-panel` | Partial | Password + chat_logs |
| Mini App | Disabled | `MINIAPP_DISABLED` | N/A | Intentional maintenance |
| Reminders parse/deliver | Full | `reminders/*` | Yes | Complex parser |
| Schedules / proactive | Full | schedules + proactive | Partial | Cron */5 |
| Voice STT/TTS | Partial | `voice/*` | Yes (mocked) | Depends on bindings/config |
| Broadcast | Full | `broadcast.js` | Yes | |
| Security (SSRF, secrets) | Full | `security.js`, `crypto.js` | Yes | |
| Localization fa/en | Partial | i18n + menus | Partial | Some admin submenus still mixed EN |
| Deploy / OTA CI | Partial | Actions + wrangler | CI history flaky | npm/workerd optional deps historically |

## Incomplete / weak areas (actionable)

1. **Admin UI i18n gaps** — Reactions fixed at baseline; other submenus may still show English for `fa` users.
2. **Guest mode effectiveness** — Auto membership check; full members never get prefix; true non-member updates are rare on Telegram.
3. **CI deploy reliability** — Historically failed on `npm ci` / optional `workerd` resolution; local `wrangler deploy` works.
4. **Mini App** — Disabled on purpose; do not treat as regression.

## Intentionally disabled

- Mini App menu button and UI (`MINIAPP_DISABLED`).
- Multi-retry AI loops (replaced by single long timeout).


## GitHub Issues opened from this audit

| Issue | Topic |
|-------|--------|
| #75 | CI Deploy wrangler/workerd fragility |
| #76 | Admin Telegram UI remaining English for fa-IR |
| #77 | Guest mode auto-detect limited to non-full members |
