# Nyra Wiki

**Nyra** is a self-hosted AI assistant for Telegram that runs as a single [Cloudflare Worker](https://workers.cloudflare.com/).

It connects a Telegram bot to AI providers you configure (OpenAI, Anthropic, or OpenAI-compatible endpoints such as OpenRouter, Groq, or local gateways). API keys are encrypted at rest. Application state lives in Cloudflare D1 and KV. There is no separate application server to operate.

## Main capabilities

Verified against the current repository implementation:

- Telegram bot runtime (webhook → queue → handlers)
- Multi-provider AI connections with fallback
- Per-user memory and personalities
- Mini App JSON API and optional static Mini App assets
- External admin panel routes
- Reminders, schedules, and proactive check-ins (cron)
- Dead-letter queue (DLQ) inspection and replay
- Built-in zero-key web search helpers
- Secret redaction for logs and diagnostics

## Wiki navigation

- [Architecture](Architecture) — components, request flow, storage, and deployment shape
- [Security](Security) — reporting vulnerabilities and secure contribution practices

## Repository resources

| Resource | Location |
|----------|----------|
| README | [README.md](https://github.com/MHDLabs/Nyra/blob/main/README.md) |
| Persian README | [README.fa.md](https://github.com/MHDLabs/Nyra/blob/main/README.fa.md) |
| Contributing | [CONTRIBUTING.md](https://github.com/MHDLabs/Nyra/blob/main/CONTRIBUTING.md) |
| Security policy | [SECURITY.md](https://github.com/MHDLabs/Nyra/blob/main/SECURITY.md) |
| Agent guide | [AGENTS.md](https://github.com/MHDLabs/Nyra/blob/main/AGENTS.md) |
| Docs index | [docs/README.md](https://github.com/MHDLabs/Nyra/blob/main/docs/README.md) |
| Engineering notes | [docs/engineering/](https://github.com/MHDLabs/Nyra/tree/main/docs/engineering) |

## Where to start

1. Read the [README](https://github.com/MHDLabs/Nyra/blob/main/README.md) for deploy and configuration.
2. Follow [CONTRIBUTING.md](https://github.com/MHDLabs/Nyra/blob/main/CONTRIBUTING.md) for setup, tests, and the Issue → branch → PR workflow.
3. Use [Architecture](Architecture) when changing runtime behavior.
4. Use [Security](Security) and [SECURITY.md](https://github.com/MHDLabs/Nyra/blob/main/SECURITY.md) before handling secrets or reporting vulnerabilities.
