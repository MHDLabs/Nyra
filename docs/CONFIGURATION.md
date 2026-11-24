# Nyra configuration

Nyra uses an administrator-managed model catalog. Each user can select one of the enabled models that the administrator makes available to users. Provider credentials remain server-side and are encrypted before they are stored in D1.

## 1. Worker secrets

Set these through Cloudflare Worker secrets. Never place their values in Git.

| Secret | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_SECRET` | Random webhook/setup secret |
| `ADMIN_PANEL_PASSWORD` | Password for the standalone web admin panel |
| `NYRA_MODEL_ENCRYPTION_KEY` | Stable encryption key for provider API keys stored in D1 |
| `AI_API_KEY` | Legacy single-provider compatibility only |
 
Generate a strong model-encryption secret locally:

```bash
openssl rand -hex 32
wrangler secret put NYRA_MODEL_ENCRYPTION_KEY
```

Paste the generated value into the Wrangler prompt. Keep this secret backed up in a password manager and do not rotate it casually: changing it makes existing encrypted provider keys unreadable. If it is lost or changed, re-enter the affected provider API keys through the admin panel.

The model registry requires `NYRA_MODEL_ENCRYPTION_KEY` to contain at least 32 characters. The key is never returned by the admin API and is never written to a source file.

## 2. Worker variables

Set these in `wrangler.toml` under `[vars]`, or through the Cloudflare dashboard.

| Variable | Required | Description |
| --- | --- | --- |
| `ADMIN_IDS` | For Telegram admin controls | Comma-separated numeric Telegram user IDs |
| `AI_MODEL` | Legacy only | Old single-model fallback when no catalog model is configured |
| `AI_BASE_URL` | Legacy only | OpenAI-compatible base URL for the legacy model |
| `AI_SUPPORTS_VISION` | Legacy only | Whether the legacy endpoint accepts images |

The model catalog replaces `AI_MODEL` and `AI_API_KEY` for normal operation. Existing legacy values remain available as a compatibility fallback until the catalog has a configured default.

## 3. Configure the built-in models

Open the web admin panel at `/admin-panel`, sign in with `ADMIN_PANEL_PASSWORD`, and open **Models**. You can also open the AI Models section from the Telegram `/admin` menu.

The initial catalog contains:

| Model | Provider model ID | Initial behavior |
| --- | --- | --- |
| Groq · Qwen 3.8 27B | `qwen/qwen3.8-27b` | Enabled and global default |
| Cloudflare · Qwen 3.8 27B | `@cf/qwen/qwen3.8-27b` | Reserved for Groq HTTP 429 fallback |
| Cloudflare · GLM 4.7 Flash | `@cf/zai-org/glm-4.7-flash` | Optional and initially disabled |

### Groq · Qwen 3.8 27B

The built-in Base URL is:

```text
https://api.groq.com/openai/v1
```

Add the Groq API key in the model card's password field and save. The key is encrypted before it is stored.

### Cloudflare · Qwen 3.8 27B fallback

Replace the `ACCOUNT_ID` placeholder in its Base URL with your Cloudflare account ID:

```text
https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1
```

Add a Cloudflare API token that has permission to use Workers AI. Then save the Base URL and key. Keep this model enabled. It is intentionally hidden from the user model picker and is only used as the one defined automatic fallback.

Nyra attempts this model automatically only when the primary Groq Qwen request returns HTTP 429 and no partial response has already been sent. If that fallback attempt also fails, the original message may show a one-time **Retry with Cloudflare Qwen** button. Other Groq errors do not trigger this automatic fallback.

### Cloudflare · GLM 4.7 Flash

Set its Cloudflare Base URL and API token the same way. Enable the model when ready. To make it selectable by everyone, enable **Selectable for all users**. To make it available only to the administrator, turn that option off. An admin-only model cannot be the global default.

## 4. User model selection

Users can open `/models` or choose **Settings → Choose Model**. They see only models that are enabled, have a configured API key and valid Base URL, and are marked as selectable for users.

The selected model is stored per user. An administrator can also select an admin-only model for their own account.

The administrator controls the catalog, provider keys, visibility, vision support, enabled state, and global default. Users cannot add providers or change credentials.

## 5. OpenAI-compatible custom providers

Add a provider in the **Models** section of the web admin panel:

1. Enter a display name.
2. Enter the exact provider model ID.
3. Enter the OpenAI-compatible API Base URL, normally ending in `/v1`.
4. Enter the API key.
5. Choose whether the endpoint supports image input and whether users may select it.
6. Save, then enable the model in its model card.

Nyra sends requests to `<Base URL>/chat/completions`. Supply the base URL, not the full `/chat/completions` endpoint. HTTPS is required except for localhost development endpoints.

The Telegram admin controls are also available:

```text
/modeladd Display name | provider/model-id | https://provider.example/v1
/modelbase MODEL_ID https://provider.example/v1
/modelkey MODEL_ID API_KEY
```

Use the web panel for API keys where possible. The private Telegram `/modelkey` command is restricted to administrators, its message is deleted after handling, and it is processed outside the durable message queue so plaintext credentials are not stored in queue payloads. Never send this command in a group.

## 6. Maintenance mode

Administrators can toggle Maintenance from the web panel's Models section or from the Telegram `/admin` menu. It uses one shared D1 setting. While enabled, normal user messages are rejected before onboarding, preference flows, or AI work can be added. Administrators retain access to management commands.

## 7. Queue and Telegram behavior

- Ordinary messages and slash commands are placed in the durable queue. The sensitive `/modelkey` command is the exception.
- Messages in the same chat are serialized in Telegram update order using D1 conversation locks and pending-update records.
- Different chats can be processed concurrently, so one slow conversation does not hold up other users.
- Private chats receive a typing indicator and a temporary hourglass reaction as soon as a message is accepted by the queue; the hourglass is removed after processing. Group typing is started only after the message actually addresses Nyra, so unrelated group messages do not make the bot appear busy.
- Telegram 429 responses respect `retry_after` up to the configured retry ceiling. Send and edit errors are logged separately; duplicate no-op edits are treated as successful.
- Streaming edits are throttled to avoid flooding Telegram while keeping replies visibly incremental.

## 8. Local validation

```bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
```

Run `/status` after deployment to confirm the Worker build, model-key encryption configuration, and catalog status. Then send a test chat message: a successful status response alone does not prove that a provider key is valid.

## 9. Migration note

The model catalog and per-user model selection are added by D1 migration 25. Queue conversation locks and durable per-chat ordering are added by migrations 26 and 27. These migrations add model/queue tables and the user-selected-model column; they do not store provider keys in plaintext.
