<div dir="ltr">

# ⚡ Nyra

**A self-hosted AI assistant for Telegram, running entirely on Cloudflare Workers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![Runtime](https://img.shields.io/badge/runtime-Nodeless%20JS-33cc33.svg)](src/index.js)

English · [فارسی](README.fa.md)

---

Nyra connects your Telegram bot to any AI provider you choose — OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, …). It runs as a single Cloudflare Worker with no build step, no server to maintain, and no framework to learn. Your API keys are encrypted at rest, and everything else lives in Cloudflare D1 and KV.

## 🚀 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

One click, then **exactly two inputs** — nothing else needs configuration:

1. **`TELEGRAM_BOT_TOKEN`** — your bot token from [@BotFather](https://t.me/BotFather).
2. **`ADMIN_IDS`** — numeric Telegram user ID(s) of the administrator(s), comma-separated (send any message to [@userinfobot](https://t.me/userinfobot) to learn yours).

Everything else is automatic: Cloudflare provisions D1, KV and the queue from `wrangler.toml`, the `workers.dev` domain is enabled, the webhook secret and encryption key are derived from your bot token, and the Worker registers the Telegram webhook itself on first contact — no curl, no manual webhook step. The flow surfaces both inputs as required (with descriptions of where to find them); the status page (`GET /`) additionally warns at runtime if `ADMIN_IDS` is missing or malformed.

Prefer the CLI? The full manual flow is in [Setup](#-setup) → *Option B*.

## ✨ Features

- **🚀 Zero infrastructure** — a single Worker, Cloudflare D1, and a KV namespace. No servers, no builds.
- **🔀 Any provider** — OpenAI-compatible APIs (custom base URL) and Anthropic, with streaming responses edited live in the chat.
- **👥 Multiple connections** — admins define shared global models; users can add their own, switch per chat, and set a personal default.
- **🔐 Encrypted keys** — provider API keys are sealed with AES-256-GCM (HKDF-derived per owner) and never leave the database in plaintext.
- **🛟 Automatic fallback** — if a connection fails or times out, Nyra retries and falls back to other enabled connections within a time budget.
- **🧠 Memory** — persistent per-user memory with three modes (normal, minimal, none), explicit `/remember` and `/forget`, and periodic consolidation.
- **🎭 Personalities** — built-in Default, Friendly, and Funny personas, plus up to 10 custom personalities per user.
- **👥 Group support** — in groups, Nyra replies only when mentioned by name (`Nyra` / `نیرا` / `نيرا`) or when you reply to one of her messages; context is tracked per thread.
- **🛡️ Rate limiting & blocking** — per-user, per-chat, and per-admin limits, plus an admin block list.
- **🛠️ Admin panel** — manage users, chats, group modes, connections, and block list, and view stats and system status — all inline in Telegram.

## � Project structure

The Worker is split into small, focused ES modules under `src/` — Wrangler bundles them automatically, so there is still no build step:

```
src/
├── index.js     entry point: AI message pipeline, update routing, webhook & setup endpoints
├── config.js    shared constants, prompt rules, default personalities
├── utils.js     pure helpers, sanitizers, rate limiting
├── crypto.js    AES-256-GCM credential encryption
├── telegram.js  Telegram Bot API layer
├── db.js        D1 schema, users/chats/threads, flow state, connections, usage
├── ai.js        providers, streaming, model listing, connection tests, fallback
├── memory.js    memory data, system prompts, personalities, consolidation
├── menus.js     settings screens and inline views
├── flows.js     add/edit connection wizard
└── commands.js  user commands and the admin panel
```

## �📋 Requirements

- A [Cloudflare account](https://dash.cloudflare.com) (free plan is enough — Workers, D1, KV and Queues all work on Free; Queues Free includes 10,000 operations/day, which suits personal/small-group use)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An API key from an AI provider (OpenAI-compatible or Anthropic)
- One-click button: nothing beyond the three items above
- Manual setup only: [Node.js](https://nodejs.org) and the [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

## 🚀 Setup

### Option A — one-click (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

1. Press the button and sign in to Cloudflare.
2. The flow asks for exactly two inputs — every other value is provisioned or derived automatically:
   - `TELEGRAM_BOT_TOKEN` — the token from @BotFather.
   - `ADMIN_IDS` — numeric Telegram user ID(s) of the admin(s), comma-separated.
3. Click **Deploy**. Cloudflare provisions D1, KV and the queue from `wrangler.toml`, enables the `nyra.<subdomain>.workers.dev` domain, and runs the deploy script, which ends with a status-page probe.
4. The Worker bootstraps itself: first contact initialises the schema and **registers the Telegram webhook automatically** — no curl, no manual step. Open `https://nyra.<your-subdomain>.workers.dev/` once to confirm; you should see `Webhook: registered → …` and `Admin IDs: 1 configured`.
5. Open a private chat with your bot, send `/start`, then connect a model (*Option B, step 6*).

Notes:
- The built-in cron trigger re-verifies the webhook registration every few minutes, so it self-heals if Telegram-side registration is ever lost.
- Upgrading an existing deployment? Keep any real `database_id` / KV `id` in `wrangler.toml`, and keep your existing `TELEGRAM_SECRET` / `ENCRYPTION_KEY` secrets — explicit secrets always win over derived values.

### Option B — manual CLI setup

#### 1. Create the bot

Message [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the token it gives you.

#### 2. Storage (automatic)

Nothing to create by hand: `wrangler.toml` declares the D1 database, the KV namespace, and the `nyra-updates` queue **without resource IDs**, so Wrangler's automatic provisioning creates all three on your first `wrangler deploy` and writes their IDs back into `wrangler.toml`.

> **Upgrading an existing deployment?** If your `wrangler.toml` already contains a real `database_id` or KV `id`, keep those values — do not delete them (deleting them would provision *new*, empty resources).

Manual creation (`wrangler d1 create nyra`, `wrangler kv namespace create KV`) still works: copy the IDs from the output into `wrangler.toml`.

#### 3. Set the secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN   # paste the @BotFather token — the only required secret
# Optional overrides (auto-derived from the token when omitted):
# wrangler secret put TELEGRAM_SECRET     # openssl rand -hex 32
# wrangler secret put ENCRYPTION_KEY      # openssl rand -base64 32
```

Set your admin Telegram user ID(s) in `wrangler.toml` under `[vars] → ADMIN_IDS` (comma-separated for multiple admins).

#### 4. Deploy

```bash
wrangler deploy
```

#### 5. Register the webhook (automatic; `/setup` for manual overrides)

No manual step: the deploy probe or the first visit to `GET /` registers the webhook using the runtime secret, and the cron re-verifies it. To register by hand (only meaningful when `TELEGRAM_SECRET` is explicitly set — a derived secret cannot be quoted), run once (the secret travels **only in a header**, never in the URL):

```bash
curl -H "X-Setup-Secret: <TELEGRAM_SECRET>" \
  "https://<your-worker>.workers.dev/setup?url=https://<your-worker>.workers.dev/webhook"
```

A JSON response with `"ok": true` means Nyra is live. Open your bot in Telegram and send `/start`.

Notes:
- Query-string secrets (`?secret=…`) are rejected — secrets in URLs leak into logs and history.
- The manual `/setup` path uses `drop_pending_updates: true`, so queued updates are discarded on (re-)registration; the automatic path does not drop them.

#### 6. Connect a model

In a private chat with the bot, open `/admin` → **Connections** and add a provider (OpenAI-compatible with a base URL, or Anthropic), API key, and model. Test it inline, then set it as the global default.

## ⚙️ Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather — the only required secret (prompted by the deploy button) |
| `ADMIN_IDS` | ✅ | Numeric Telegram admin ID(s), comma-separated (prompted by the deploy button) |
| `TELEGRAM_SECRET` | optional | Secret token Telegram sends with every webhook call; also gates `/setup`. **Auto-derived from the bot token** when unset — set explicitly only to override |
| `ENCRYPTION_KEY` | optional | Base64-encoded 32-byte key for AES-256-GCM encryption of stored API keys. **Auto-derived from the bot token** when unset |
| `TELEGRAM_BOT_ID` / `TELEGRAM_BOT_USERNAME` | optional | Cached bot identity; fetched automatically when omitted |

D1 is bound as `DB`, KV as `KV`, and the update queue as `NYRA_QUEUE` (see `wrangler.toml`). Update flow: Telegram → webhook (acks immediately, after `update_id` dedup) → queue → consumer, which runs the full AI pipeline — so long streaming replies are not cut off by the 30-second post-response limit that applies to webhook requests.

The schema is created on first use — triggered by the status page, the first webhook, or the cron probe (all KV-gated so D1 stays quiet once initialised); one-time migrations are versioned and tracked in the `schema_migrations` table. The Telegram webhook URL is learned from the first request to `GET /` and re-verified automatically by the `*/5` cron trigger (`ensureWebhook` in `src/telegram.js`).

## 💬 Commands

| Command | Description |
| --- | --- |
| `/start` | Greeting and active model |
| `/help` | Command list |
| `/settings` | Preferences (private chat) |
| `/personality` | Choose a personality (private chat) |
| `/memory` | View your memory (private chat) |
| `/remember <fact>` | Explicitly remember something |
| `/forget [topic]` | Clear memory or forget one topic |
| `/setname <name>` | Set your preferred name |
| `/usage` | Your usage statistics (private chat) |
| `/newpersonality` | Create a custom personality (private chat) |
| `/admin` | Admin panel (admins, private chat) |
| `/stats` | Statistics (admins, private chat) |

## 🔐 Security notes

- Webhook updates are rejected unless they carry the effective webhook secret (your explicit `TELEGRAM_SECRET`, or the value derived from your bot token); the comparison is constant-time. Duplicates are dropped by `update_id` before processing.
- Provider API keys are encrypted with AES-256-GCM using keys derived per owner from your `ENCRYPTION_KEY` — or from the bot-token-derived master key when `ENCRYPTION_KEY` is unset.
- **Derived-secret trade-off:** with auto-derived secrets, anyone who obtains your bot token can also derive the master key, so treat the token itself as a secret. Set an explicit `ENCRYPTION_KEY` for defense in depth, and note that rotating the bot token *without* an explicit `ENCRYPTION_KEY` makes previously stored keys unreadable (existing installations that already have both secrets set are unaffected).
- `/setup` is rate-limited, requires the secret in the `X-Setup-Secret` header (query-string secrets are rejected), and only accepts a URL on the worker's own host with the exact `/webhook` path.
- Rate limits are best-effort: they are KV-backed (eventually consistent across edge locations) and fail open if KV is unavailable — an availability-over-strictness trade-off.
- **Data storage:** memory and conversation history are stored in Cloudflare D1. Credentials are encrypted; memory/conversations are not encrypted at rest and are readable by whoever has access to your Cloudflare account's D1. The app itself never exposes one user's memory or chats to other users — including admins.
- Local secrets belong in `.dev.vars` (gitignored) — see `.dev.vars.example` (only the bot token is required there).
- The worker refuses to process requests when no usable encryption key exists — neither a valid explicit `ENCRYPTION_KEY` nor a bot token to derive one from.

## 🧪 Tests

Pure helpers (message splitting, memory serialization, crypto — including token-derived secrets — sanitizers, admin-ID validation, deploy-URL extraction) are covered by Node's built-in test runner — no dependencies to install:

```bash
npm test
```

## 📄 License

[MIT](LICENSE) © MHDLabs

</div>
