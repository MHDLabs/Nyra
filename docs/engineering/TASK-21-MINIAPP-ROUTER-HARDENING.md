# Task 21 — Mini App Router TypeScript and Query Hardening

## Scope

Remove the progressive TypeScript suppression from `src/miniapp/router.ts` and validate numeric query parameters before they reach route handlers or database queries.

## Changes

- Removed `@ts-nocheck` and added explicit `NyraEnv`, `ExecutionContext`, `Request`, and `Response` contracts.
- Typed JSON request-body parsing as a safe object record.
- Replaced permissive `parseInt` handling with one strict unsigned-decimal parser.
- Rejects repeated parameters, partial numeric strings, signed values, fractions, non-finite/unsafe integers, and offset overflow.
- Keeps absent and empty `page` / `limit` values on their existing defaults.
- Preserves the DLQ handler's 200-row maximum by validating offsets against the effective clamped limit.
- Constrains usage-report windows to 1–3650 days to avoid invalid date arithmetic or unreasonable lookback ranges.
- Adds route-level regression tests proving invalid values return HTTP 400 before D1 access, and valid pagination values reach handlers as expected.

## Query contracts

| Route family | Parameter | Contract |
|---|---|---|
| Admin users / chats | `page` | Non-negative safe integer; 50 rows per page |
| Admin broadcasts | `page` | Non-negative safe integer; 20 rows per page |
| Admin failed updates | `page` | Non-negative safe integer with safe offset |
| Admin failed updates | `limit` | Positive safe integer; handler retains max 200 |
| Admin connection/shared usage | `days` | Integer from 1 through 3650; default 7 |

Empty single values retain the existing default. Duplicate values are rejected instead of silently choosing one.

## Compatibility

No endpoint paths, methods, successful response shapes, page-size defaults, or DLQ limit-clamping behavior are changed. Malformed numeric query strings that were previously partially accepted by `parseInt` now receive a JSON 400 response.

## Coverage

`@ts-nocheck` under `src/`: **51 → 50**.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run test:all`
- `npx wrangler deploy --dry-run`
