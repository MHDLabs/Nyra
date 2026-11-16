# Security

Practical security overview for Nyra contributors and operators. The canonical policy is **[SECURITY.md](https://github.com/MHDLabs/Nyra/blob/main/SECURITY.md)** in the repository root.

## Principles

- Treat production Telegram tokens, provider API keys, and `ENCRYPTION_KEY` as high-value secrets.
- Prefer the smallest change that fixes a real defect; do not weaken validation or redaction to silence tests.
- Keep vulnerability details out of public Issues when disclosure could enable exploitation.

## Reporting vulnerabilities

Follow **[SECURITY.md](https://github.com/MHDLabs/Nyra/blob/main/SECURITY.md)**:

1. Prefer **GitHub Private Vulnerability Reporting** (repository Security → Report a vulnerability) when available.
2. Do **not** open a public Issue for sensitive findings.
3. Never include live credentials, full production dumps, or personal user data in reports.

Supported fix line: security fixes are applied on the default branch (`main`).

## Secure contribution practices

Documented in [CONTRIBUTING.md](https://github.com/MHDLabs/Nyra/blob/main/CONTRIBUTING.md) and [AGENTS.md](https://github.com/MHDLabs/Nyra/blob/main/AGENTS.md):

- Do not commit secrets or `.env` files.
- Use synthetic fixtures in tests only.
- Issue → dedicated branch → PR against `main`; no direct pushes to `main`.
- Run typecheck and the full test suite before review.

## Secret handling in the product

As implemented in code:

- **Deployment secrets** are Worker secrets / bindings, not source-controlled files.
- **Provider API keys at rest** are encrypted (AES-256-GCM with HKDF-derived per-owner keys). See [`src/crypto.ts`](https://github.com/MHDLabs/Nyra/blob/main/src/crypto.ts).
- **Logs and diagnostics** should go through redaction helpers in [`src/redact.ts`](https://github.com/MHDLabs/Nyra/blob/main/src/redact.ts).
- **Mini App error responses** should use safe helpers such as `jsonError` / `jsonErrorFromException` in [`src/miniapp/respond.ts`](https://github.com/MHDLabs/Nyra/blob/main/src/miniapp/respond.ts) so internal exception details are not returned to clients.

## Platform security features

This repository is maintained with GitHub security features enabled where the project has configured them, including dependency alerts, code scanning, and secret scanning. **Dashboard counts change over time**—check the live [Security](https://github.com/MHDLabs/Nyra/security) tab rather than relying on any snapshot in documentation.

If a security product page or API endpoint is unavailable for the repository, treat that area as unverified rather than “clean.”

## Operational notes

- Rotate credentials if they may have been exposed.
- Keep `ADMIN_IDS` limited to trusted numeric Telegram user IDs.
- After deploy, use `/status` (and related ops checks) to confirm configuration health without printing secret values.

## See also

- [Home](Home)
- [Architecture](Architecture)
- [SECURITY.md](https://github.com/MHDLabs/Nyra/blob/main/SECURITY.md)
