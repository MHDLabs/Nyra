# Task 19 — DLQ Mini App API Hardening

## Flow

`router.ts` routes:
- `GET /api/admin/failed-updates` → `handleAdminFailedUpdates(env, page, limit)`
- `POST /api/admin/failed-updates/replay` → `handleReplayFailedUpdate(env, body.id)`

Handlers call `listFailedUpdates` / `replayFailedUpdate` from `src/dlq.ts`.

## TypeScript

Removed `@ts-nocheck` from `src/miniapp/dlq-api.ts`.

## Validation

| Input | Policy |
|-------|--------|
| page | Non-negative integer (default 0); reject fractional/NaN/negative |
| limit | Positive integer (default 50); max 200 |
| offset | `page * limit` with overflow guard |
| replay id | Positive safe integer (number or digit string) |

## Errors

Catch blocks use `jsonErrorFromException` with public messages only:
- `Failed to load failed updates`
- `Failed to replay update`

## Compatibility

Success list shape remains the `listFailedUpdates` page object.
Replay success remains `{ success: true }`.

## Coverage

`@ts-nocheck` under `src/`: 53 → 52.
