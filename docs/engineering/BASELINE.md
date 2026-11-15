# Nyra JavaScript Baseline

**Baseline commit:** `a86b96e4e254d51f939e3f4201dca589b6f54f38`  
**Tag:** `nyra-js-baseline-a86b96e`  
**Tag message:** Final JavaScript baseline before TypeScript migration  
**Default branch:** `main`  
**Remote:** `https://github.com/MHDLabs/Nyra`  
**Recorded:** 2026-11-15

## Verification

| Check | Result |
|-------|--------|
| Local tag points to baseline SHA | Yes (`git rev-parse nyra-js-baseline-a86b96e^{}`) |
| Remote tag present | Yes (`origin` refs/tags/nyra-js-baseline-a86b96e) |
| Working tree at baseline | Clean on `main` / tag |
| Source language | JavaScript (ESM) under `src/`, `test/`, `public/` |

## Test baseline

Command: `npm test` (Node built-in test runner; no application runtime deps required)

| Metric | Value |
|--------|-------|
| Tests | 332 |
| Suites | 12 |
| Pass | 332 |
| Fail | 0 |
| Skipped | 0 |
| Duration | ~21 s |

Syntax: `find src test -name '*.js' \| xargs -n1 node --check` — exit 0.

## Inventory (tracked files)

Approximate counts at baseline:

| Area | Count |
|------|-------|
| All tracked files | 164 |
| `src/**/*.js` | ~96 modules |
| `test/**/*.js` | 41 |
| `public/**` | static assets + Mini App / admin panel JS |
| Workflows | `.github/workflows/ci.yml`, `deploy.yml` |

## Runtime stack

- Cloudflare Workers (`nodejs_compat`)
- D1 (`DB`), KV (`KV`), Queues (`NYRA_QUEUE`, `NYRA_DLQ`), Workers AI (`AI`), Assets (`ASSETS`)
- Telegram Bot API (webhook + queue consumer)
- Wrangler deploy (local and GitHub Actions)

## Important product switches at baseline

- Mini App: **intentionally disabled** (`MINIAPP_DISABLED` maintenance)
- AI attempts: **single attempt**, 120 s timeout (no multi-retry loop)
- Guest mode: **automatic** via `getChatMember` (not an admin trigger toggle)
- Admin web panel: `/admin-panel` password-gated
- Chat archive: `chat_logs` for admin panel

## Recovery

To restore this baseline:

```bash
git fetch --tags
git checkout nyra-js-baseline-a86b96e
```

Do not delete or force-move this tag.
