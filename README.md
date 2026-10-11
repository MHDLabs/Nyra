<div dir="ltr">

# ⚡ Nyra

**A self-hosted AI assistant for Telegram, running entirely on Cloudflare Workers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![Runtime](https://img.shields.io/badge/runtime-Nodeless%20JS-33cc33.svg)](worker.js)

English · [فارسی](README.fa.md)

---

Nyra connects your Telegram bot to any AI provider you choose — OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, …). It runs as a single Worker file with no build step, no server to maintain, and no framework to learn. Your API keys are encrypted at rest, and everything else lives in Cloudflare D1 and KV.

## ✨ Features

- **🚀 Zero infrastructure** — one Worker file, Cloudflare D1, and a KV namespace. No servers, no builds.
- **🔀 Any provider** — OpenAI-compatible APIs (custom base URL) and Anthropic, with streaming responses edited live in the chat.
- **👥 Multiple connections** — admins define shared global models; users can add their own, switch per chat, and set a personal default.
- **🔐 Encrypted keys** — provider API keys are sealed with AES-256-GCM (HKDF-derived per owner) and never leave the database in plaintext.
- **🛟 Automatic fallback** — if a connection fails or times out, Nyra retries and falls back to other enabled connections within a time budget.
- **🧠 Memory** — persistent per-user memory with three modes (normal, minimal, none), explicit `/remember` and `/forget`, and periodic consolidation.
- **🎭 Personalities** — built-in Default, Friendly, and Funny personas, plus up to 10 custom personalities per user.
- **👥 Group support** — in groups, Nyra replies only when mentioned by name (`Nyra` / `نیرا` / `نيرا`) or when you reply to one of her messages; context is tracked per thread.
- **🛡️ Rate limiting & blocking** — per-user, per-chat, and per-admin limits, plus an admin block list.
- **🛠️ Admin panel** — manage users, chats, group modes, connections, and block list, and view stats and system status — all inline in Telegram.

## 📋 Requirements

- A [Cloudflare account](https://dash.cloudflare.com) (free plan is enough)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An API key from an AI provider (OpenAI-compatible or Anthropic)
- [Node.js](https://nodejs.org) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

## 🚀 Setup

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the token it gives you.

### 2. Create the storage

```bash
wrangler d1 create nyra
wrangler kv namespace create KV
```

Copy the `database_id` and KV `id` from the output into `wrangler.toml`.

### 3. Set the secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN   # paste the @BotFather token
wrangler secret put TELEGRAM_SECRET      # openssl rand -hex 32
wrangler secret put ENCRYPTION_KEY       # openssl rand -base64 32
```

Set your admin Telegram user ID in `wrangler.toml` under `[vars] → ADMIN_IDS` (comma-separated for multiple admins).

### 4. Deploy

```bash
wrangler deploy
```

### 5. Register the webhook

Open this URL once (replace the host with your worker's, and the secret with your `TELEGRAM_SECRET`):

```
https://<your-worker>.workers.dev/setup?secret=<TELEGRAM_SECRET>&url=https://<your-worker>.workers.dev/webhook
```

A JSON response with `"ok": true` means Nyra is live. Open your bot in Telegram and send `/start`.

### 6. Connect a model

In a private chat with the bot, open `/admin` → **Connections** and add a provider (OpenAI-compatible with a base URL, or Anthropic), API key, and model. Test it inline, then set it as the global default.

## ⚙️ Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `TELEGRAM_SECRET` | ✅ | Secret token Telegram sends with every webhook call; also gates `/setup` |
| `ENCRYPTION_KEY` | ✅ | Base64-encoded 32-byte key for AES-256-GCM encryption of stored API keys |
| `ADMIN_IDS` | recommended | Comma-separated Telegram user IDs with admin access |
| `TELEGRAM_BOT_ID` / `TELEGRAM_BOT_USERNAME` | optional | Cached bot identity; fetched automatically when omitted |

D1 is bound as `DB` and KV as `KV` (see `wrangler.toml`). The schema is created and migrated automatically on first use.

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

- Webhook updates are rejected unless they carry your `TELEGRAM_SECRET`; the comparison is constant-time.
- Provider API keys are encrypted with AES-256-GCM using keys derived per owner from your `ENCRYPTION_KEY`.
- `/setup` is rate-limited and only accepts URLs on the worker's own host.
- Local secrets belong in `.dev.vars` (gitignored) — see `.dev.vars.example`.
- The worker refuses to process requests when `ENCRYPTION_KEY` is missing or malformed.

## 📄 License

[MIT](LICENSE) © MHDLabs

</div>
