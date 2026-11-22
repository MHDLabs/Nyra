# Nyra configuration

Nyra uses one operator-configured OpenAI-compatible endpoint and model for every user. There is no per-user API key, provider selector, or model selector.

## Worker secrets

Set these through Cloudflare Worker secrets. Never commit their values.

| Secret | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_SECRET` | Random webhook/setup secret |
| `AI_API_KEY` | Central OpenAI-compatible API credential |
| `ADMIN_PANEL_PASSWORD` | Optional password for the standalone web admin panel |

Example:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_SECRET
wrangler secret put AI_API_KEY
wrangler secret put ADMIN_PANEL_PASSWORD
```

The Worker never sends `AI_API_KEY` to Telegram users or browser clients. Do not print it in logs or paste it into issues.

## Worker variables

Set these in `wrangler.toml` under `[vars]`, or through the Cloudflare dashboard.

| Variable | Required | Description |
| --- | --- | --- |
| `AI_MODEL` | Yes | One model identifier accepted by the configured endpoint |
| `AI_BASE_URL` | No | OpenAI-compatible API base URL; defaults to `https://api.openai.com/v1` |
| `AI_SUPPORTS_VISION` | No | Set to `true` only if the selected model and endpoint accept image input |
| `ADMIN_IDS` | Yes for Telegram admin commands | Comma-separated numeric Telegram user IDs |

Example:

```toml
[vars]
AI_MODEL = "your-model-id"
AI_BASE_URL = "https://api.openai.com/v1"
AI_SUPPORTS_VISION = "false"
ADMIN_IDS = "123456789"
```

Use the base URL supplied by your OpenAI-compatible provider. Keep the trailing `/v1` when the provider requires it; Nyra appends `/chat/completions`.

## Migration and data-retention warning

The simplification includes forward-only D1 migration 23. When deployed, it permanently removes legacy provider connections and encrypted BYOK credentials, model/route metadata, reminder and delivery records, voice transcripts, schedules, proactive-check-in records, retired user columns, and selected obsolete settings. Back up or export any of those historical records before deployment if they may still be needed. The migration is designed to preserve core user profiles, conversation history, memories, custom instructions, groups, chat logs, broadcasts, admin data, and usage records. The migration was tested against a legacy-shaped in-memory SQLite database; no production D1 database has been inspected or modified by this PR.

## Important behavior

- Every permitted user shares the same model and provider account. Provider costs belong to the operator.
- Model selection and credential management are not available in Telegram or the web admin panel.
- Streaming and tool calls use the same configured model. Nyra does not switch to another model or provider.
- Vision is disabled unless `AI_SUPPORTS_VISION=true` is set deliberately.
- A successful `/status` response confirms that the Worker is running; it does not prove that the configured provider credential is accepted. Test an actual chat request after configuration.
- The standalone web admin panel is separate from the removed Telegram Mini App. Its password is configured with `ADMIN_PANEL_PASSWORD`.

## Local validation

```bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
```
