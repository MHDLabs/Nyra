# Task 18 — DLQ TypeScript Hardening & Safe Diagnostics

## Architecture

Failed queue messages are inserted into D1 `failed_updates`. Admins list rows,
inspect diagnostics, and may replay by re-enqueuing the original update body.

## TypeScript

Removed `@ts-nocheck`. Added structured types for env, rows, and page responses.
Untrusted pagination/retention inputs are clamped before SQL.

## Redaction

`listFailedUpdates` redacts `message_text` and `error_info` for display via
`redactSecrets` / `redactValue`. Stored `error_info` is **not** rewritten, so
replay continues to use the original update payload.

## Replay

- Invalid IDs rejected.
- Already-replayed rows rejected.
- Malformed JSON / missing `body` fails closed.
- Concurrent replay is **not** atomic (documented limitation; no schema change).

## Limits

- Default page size 50; clamped 1–200.
- Offset ≥ 0.
- Retention days clamped 1–3650.
- Display `error_info` still capped at 1000 characters.

## Coverage

`@ts-nocheck` under `src/`: 54 → 53.
