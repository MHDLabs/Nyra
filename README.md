<div dir="ltr">

# ⚡ Nyra

**A self-hosted AI assistant for Telegram, running entirely on Cloudflare Workers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![Runtime](https://img.shields.io/badge/runtime-Nodeless%20JS-33cc33.svg)](src/index.js)

English · [فارسی](README.fa.md)

---

Nyra connects your Telegram bot to any AI provider you choose — OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, …). It runs as a single Cloudflare Worker with no build step, no server to maintain, and no framework to learn. Your API keys are encrypted at rest, and everything else lives in Cloudflare D1 and KV.

## ⚡ Quick start (one-click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

The button above is the **only** place the one-click flow starts. Press it, sign in to Cloudflare, and fill in the four required inputs — Nyra generates nothing for you, so every secret must be supplied:

1. **`TELEGRAM_BOT_TOKEN`** — your bot token from [@BotFather](https://t.me/BotFather) (format `123456789:AA...`).
2. **`TELEGRAM_SECRET`** — random webhook secret token; also the `X-Setup-Secret` header for `/setup`.
3. **`ENCRYPTION_KEY`** — base64-encoded 32-byte master key that encrypts every stored API key.
4. **`ADMIN_IDS`** — numeric Telegram user ID(s) of the administrator(s), comma-separated (send any message to [@userinfobot](https://t.me/userinfobot) to learn yours).
5. **`TAVILY_API_KEY` (optional)** — enables live web search. Without it, public-page reading remains available but live search is not advertised. Obtain a key from Tavily and set it with `npx wrangler secret put TAVILY_API_KEY`.

Generate the two random secrets on your own machine (macOS/Linux; on Windows use WSL or Git Bash) and paste them into the form:

```bash
openssl rand -hex 32      # → TELEGRAM_SECRET   (64 hex chars, accepted by Telegram)
openssl rand -base64 32   # → ENCRYPTION_KEY    (exactly 32 bytes when decoded)
```

No `openssl`? Any cryptographically secure generator works, as long as the output matches the format above — for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for `TELEGRAM_SECRET` and the same with `toString('base64')` for `ENCRYPTION_KEY`. Never use the bot token, a password you typed by hand, or an online "random string" site as either value.

Everything else is automatic: Cloudflare provisions D1, KV and the queue from `wrangler.toml`, the `workers.dev` domain is enabled, and the Worker registers the Telegram webhook itself on first contact — no curl, no manual webhook step. The flow marks all four inputs as required (with descriptions of where to find or how to generate them); the status page (`GET /status`) additionally warns at runtime if `ADMIN_IDS` is missing or malformed, and every request returns HTTP 500 until all three secrets are valid.

Live web search uses Tavily and requires the optional `TAVILY_API_KEY` secret. The admin panel's Workers AI setting controls whether Workers AI is disabled, available only to administrators, or available to all permitted users; it defaults to disabled. When enabled, Workers AI is a last-resort chat provider if configured user/provider connections fail. The selected `@cf/...` model is editable in the admin panel.

Prefer the CLI? The full manual flow is in [Setup](#-setup) → *Option B*.

## ✨ Features

- **🚀 Zero infrastructure** — a single Worker, Cloudflare D1, and a KV namespace. No servers, no builds.
- **🔀 Any provider** — OpenAI-compatible APIs (custom base URL) and Anthropic, with streaming responses edited live in the chat.
- **👥 Multiple connections** — admins define shared global models; users can add their own, switch per chat, and set a personal default.
- **🔐 Encrypted keys** — provider API keys are sealed with AES-256-GCM (HKDF-derived per owner) and never leave the database in plaintext.
- **🛟 Automatic fallback** — if a connection fails or times out, Nyra retries and falls back to other enabled connections within a time budget.
- **🧠 Memory** — persistent per-user memory with three modes (normal, minimal, none), explicit `/remember` and `/forget`, and periodic consolidation.
- **🎭 Personalities** — seven built-ins (Default, Friend, Funny, Romantic Nyra, Professional, Coder, Creative), plus up to 10 custom personalities per user.
- **👥 Group support** — in groups, Nyra replies only when mentioned by name (`Nyra` / `نیرا` / `نيرا`) or when you reply to one of her messages; context is tracked per thread.
- **🛡️ Rate limiting & blocking** — per-user, per-chat, and per-admin limits, plus an admin block list.
- **🛠️ Admin panel** — manage users, chats, group modes, connections, and block list, and view stats and system status — all inline in Telegram.

## 📁 Project structure

The Worker is split into small, focused ES modules under `src/` — Wrangler bundles them automatically, so there is still no build step. Any directory with an `index.js` barrel has a thin same-named module next to it that only re-exports, so import paths never had to change when the code was decomposed:

```
src/
├── index.js        Worker entry point (composition root): fetch / scheduled / queue
├── config.js       shared constants, prompt rules, default personalities
├── utils.js        pure helpers, sanitizers, rate limiting
├── crypto.js       AES-256-GCM credential encryption, mandatory-secret validation
├── telegram.js     Telegram Bot API layer, webhook + menu-button registration
├── brain.js        prompt assembly and model selection
├── memory.js       memory data, system prompts, personalities, consolidation
├── formatter.js    Telegram HTML rendering and message splitting
├── menus.js        settings screens and inline views
├── commands.js     user commands and the admin panel
├── reactions.js    Workers AI sentiment classification
├── broadcast.js    broadcast campaigns
├── dlq.js          dead-letter update log and replay
├── handlers/       update handling (webhook → queue → fast path / callback / AI)
├── flows/          add/edit connection and route wizards
├── miniapp/        Mini App JSON API behind /api/*
├── db/             D1 schema, versioned migrations, and every query
├── providers/      OpenAI-compatible + Anthropic clients, streaming, fallback
├── ai.js           → re-exports providers/
├── db.js           → re-exports db/
├── flows.js        → re-exports flows/
└── miniapp.js      → re-exports miniapp/

public/             the Mini App itself (served directly by Cloudflare, no build)
scripts/            postdeploy probe + the mechanical module splitter
  postdeploy.mjs    post-deploy status probe
  split-module.mjs  the refactoring tool that produced the directories above
test/               Node's built-in test runner, zero dependencies
```

### Static assets

The Mini App in `./public` is **not** inlined into the Worker bundle. `wrangler.toml` declares a native `[assets]` binding, so Cloudflare serves `public/index.html`, `public/app.js` and `public/styles.css` straight from its asset layer. `run_worker_first = ["/webhook", "/setup", "/status", "/api/*"]` keeps the webhook, the setup endpoint, the status page and the JSON API Worker-owned; every other path is served from `public` without waking the Worker at all. The `ASSETS` binding is not read by the code — it exists so Wrangler attaches the asset layer to this Worker.

## 📋 Requirements

- A [Cloudflare account](https://dash.cloudflare.com) (free plan is enough — Workers, D1, KV and Queues all work on Free; Queues Free includes 10,000 operations/day, which suits personal/small-group use)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An API key from an AI provider (OpenAI-compatible or Anthropic)
- **One-click button:** nothing beyond a bot token, two generated secrets, and your admin user ID
- Manual setup only: [Node.js](https://nodejs.org) and the [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

## 🚀 Setup

### Option A — one-click (recommended)

Use the **Deploy to Cloudflare** button in [Quick start](#-quick-start-one-click) — it is the single entry point for the one-click flow.

1. Press the button and sign in to Cloudflare.
2. The flow asks for four required inputs — nothing is generated or derived for you:
   - `TELEGRAM_BOT_TOKEN` — the token from @BotFather.
   - `TELEGRAM_SECRET` — `openssl rand -hex 32`.
   - `ENCRYPTION_KEY` — `openssl rand -base64 32`.
   - `ADMIN_IDS` — numeric Telegram user ID(s) of the admin(s), comma-separated.
3. Click **Deploy**. Cloudflare provisions D1, KV and the queue from `wrangler.toml`, enables the `nyra.<subdomain>.workers.dev` domain, and runs the deploy script, which ends with a status-page probe.
4. The Worker bootstraps itself: first contact initialises the schema and **registers the Telegram webhook automatically** — no curl, no manual step. Open `https://nyra.<your-subdomain>.workers.dev/status` once to confirm; you should see `Webhook: registered → …` and `Admin IDs: 1 configured`. (`/` is the Mini App, not the status page.)
5. Open a private chat with your bot, send `/start`, then connect a model (*Option B, step 6*).

Notes:
- The built-in cron trigger re-verifies the webhook registration every few minutes, so it self-heals if Telegram-side registration is ever lost.
- Upgrading an existing deployment? Keep any real `database_id` / KV `id` in `wrangler.toml`, and keep the exact `TELEGRAM_SECRET` / `ENCRYPTION_KEY` you already use — changing `ENCRYPTION_KEY` makes previously stored API keys unreadable, and changing `TELEGRAM_SECRET` requires re-registering the webhook.

### Option B — manual CLI setup

#### 1. Create the bot

Message [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the token it gives you.

#### 2. Storage (automatic)

Nothing to create by hand: `wrangler.toml` declares the D1 database, the KV namespace, and the `nyra-updates` queue **without resource IDs**, so Wrangler's automatic provisioning creates all three on your first `wrangler deploy` and writes their IDs back into `wrangler.toml`.

> **Upgrading an existing deployment?** If your `wrangler.toml` already contains a real `database_id` or KV `id`, keep those values — do not delete them (deleting them would provision *new*, empty resources).

Manual creation (`wrangler d1 create nyra`, `wrangler kv namespace create KV`) still works: copy the IDs from the output into `wrangler.toml`.

#### 3. Set the secrets

All three are required. Generate the random ones first, then push each value:

```bash
openssl rand -hex 32       # → prints the value to use for TELEGRAM_SECRET
openssl rand -base64 32    # → prints the value to use for ENCRYPTION_KEY

wrangler secret put TELEGRAM_BOT_TOKEN   # paste the @BotFather token
wrangler secret put TELEGRAM_SECRET      # paste the `openssl rand -hex 32` output
wrangler secret put ENCRYPTION_KEY       # paste the `openssl rand -base64 32` output
```

`ENCRYPTION_KEY` must decode to exactly 32 bytes; `TELEGRAM_SECRET` may contain `A-Z a-z 0-9 _ -` (hex satisfies Telegram's charset). Store both somewhere safe — the Worker returns HTTP 500 on every request if either is missing or malformed, and a changed `ENCRYPTION_KEY` makes existing stored API keys undecryptable.

Set your admin Telegram user ID(s) in `wrangler.toml` under `[vars] → ADMIN_IDS` (comma-separated for multiple admins).

#### 4. Deploy

```bash
wrangler deploy
```

#### 5. Register the webhook (automatic; `/setup` for manual overrides)

No manual step: the deploy probe, any request, or the first visit to `GET /status` registers the webhook using the runtime secret, and the cron re-verifies it. To register by hand, run once (the secret travels **only in a header**, never in the URL):

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
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather (prompted by the deploy button) |
| `TELEGRAM_SECRET` | ✅ | Webhook secret token Telegram sends with every call; also gates `/setup`. Generate with `openssl rand -hex 32`. No derivation — the Worker fails with HTTP 500 without it |
| `ENCRYPTION_KEY` | ✅ | Base64-encoded 32-byte key for AES-256-GCM encryption of stored API keys. Generate with `openssl rand -base64 32`. Must decode to exactly 32 bytes |
| `ADMIN_IDS` | ✅ | Numeric Telegram admin ID(s), comma-separated (prompted by the deploy button) |
| `TELEGRAM_BOT_ID` / `TELEGRAM_BOT_USERNAME` | optional | Cached bot identity; fetched automatically when omitted |

D1 is bound as `DB`, KV as `KV`, and the update queue as `NYRA_QUEUE` (see `wrangler.toml`). Update flow: Telegram → webhook (acks immediately, after `update_id` dedup) → queue → consumer, which runs the full AI pipeline — so long streaming replies are not cut off by the 30-second post-response limit that applies to webhook requests.

The schema is created on first use — triggered by the status page, the first webhook, or the cron probe (all KV-gated so D1 stays quiet once initialised); one-time migrations are versioned and tracked in the `schema_migrations` table. The Telegram webhook URL is learned from the first request that reaches the Worker — in practice `GET /status`, since `/` is served by the asset layer and never reaches the code — and re-verified automatically by the `*/5` cron trigger (`ensureWebhook` in `src/telegram.js`).

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

- Webhook updates are rejected unless they carry the webhook secret (`TELEGRAM_SECRET`); the comparison is constant-time. Duplicates are dropped by `update_id` before processing.
- Provider API keys are encrypted with AES-256-GCM using keys derived per owner from `ENCRYPTION_KEY`.
- **All secrets are explicit.** Nothing is derived from the bot token, so obtaining the token does not reveal the webhook secret or the master key. Each secret is independent: rotate `TELEGRAM_SECRET` freely (then re-register the webhook), but treat `ENCRYPTION_KEY` as permanent — changing it makes every previously stored API key undecryptable.
- **The Worker refuses to run misconfigured.** Missing or malformed `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET` or `ENCRYPTION_KEY` makes every request return HTTP 500 (`Server misconfigured: …`) and logs the exact missing name, instead of silently starting with a weak or absent key.
- `/setup` is rate-limited, requires the secret in the `X-Setup-Secret` header (query-string secrets are rejected), and only accepts a URL on the worker's own host with the exact `/webhook` path.
- Rate limits are best-effort: they are KV-backed (eventually consistent across edge locations) and fail open if KV is unavailable — an availability-over-strictness trade-off.
- **Data storage:** memory and conversation history are stored in Cloudflare D1. Credentials are encrypted; memory/conversations are not encrypted at rest and are readable by whoever has access to your Cloudflare account's D1. The app itself never exposes one user's memory or chats to other users — including admins.
- Local secrets belong in `.dev.vars` (gitignored) — see `.dev.vars.example`; all three secrets are required there too.
- The worker refuses to process requests when any of the three secrets is missing or malformed (see `validateSecrets` in `src/crypto.js`).

## 🧪 Tests

Behaviour is covered by Node's built-in test runner — no dependencies to install:

```bash
npm test
```

The suite (67 tests in `test/`) covers message splitting (`split.test.js`), memory serialization (`memory.test.js`), crypto including mandatory-secret validation (`crypto.test.js`), sanitizers and admin-ID parsing (`utils.test.js`), Mini App routes for every endpoint (`routes.test.js`), settings validation (`settings.test.js`), reaction classification (`reactions.test.js`), the prompt brain (`brain.test.js`) and the deploy-URL extraction (`deploy.test.js`).

## 📄 License

[MIT](LICENSE) © MHDLabs

</div>
