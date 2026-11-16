# Security Policy

## Supported versions

Security fixes are applied to the default branch (`main`) of this repository. Deployed Worker versions should track `main` closely.

## Reporting a vulnerability

Please **do not** open a public GitHub Issue for sensitive security findings.

Preferred options:

1. **GitHub Private Vulnerability Reporting** (Security → Advisories / Report a vulnerability), when enabled for this repository.
2. If private reporting is unavailable, contact a repository administrator through a private channel and include:
   - A short description of the issue
   - Affected component or file paths (no secret values)
   - Steps to reproduce
   - Potential impact

## What to include

- Impact assessment (data exposure, auth bypass, injection, etc.)
- Minimal reproduction without real credentials
- Whether the issue is already being exploited (if known)

## What not to include

- Live Telegram bot tokens, API keys, or encryption keys
- Full production configuration dumps
- Personal user data

## Handling

Maintainers will triage reports, confirm impact, and coordinate a fix on a dedicated branch. Public disclosure should wait until a fix is merged and deployed when practical.

## Application security notes

- Secrets are supplied via Cloudflare Worker secrets / environment bindings, not source control.
- Credential material at rest uses AES-256-GCM with a deployment-managed master key (`ENCRYPTION_KEY`).
- Logging paths use `src/redact.ts` to scrub tokens and admin identifiers.
- Synthetic values in unit tests must never be production credentials.

## Dependency and scanning tooling

This repository uses GitHub code scanning, secret scanning, and Dependabot where enabled. Findings are triaged; alerts are not dismissed solely to clear dashboards.
