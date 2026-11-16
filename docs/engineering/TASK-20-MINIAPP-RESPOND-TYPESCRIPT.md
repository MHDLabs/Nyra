# Task 20 — Mini App Response Helpers TypeScript Hardening

## Scope

Remove the progressive TypeScript suppression from `src/miniapp/respond.ts` and make the shared JSON response/error helper contracts explicit.

## Changes

- Removed `@ts-nocheck` from `src/miniapp/respond.ts`.
- Added explicit input and return types for response, status normalization, error sanitization, and safe logging helpers.
- Reused the existing `RedactionOptions` contract and added a narrow Mini App error-options type for the optional log context.
- Kept the public JSON error envelope as `{ error: string }`.
- Added regression coverage for status normalization, safe defaults, internal error masking, control characters, secret redaction, message length caps, and sanitized exception logging.

## Compatibility

No route behavior or response schema is intentionally changed. Existing handlers continue importing the same helper names and using the same arguments.

## Coverage

`@ts-nocheck` under `src/`: **52 → 51**.

## Verification

Run before merge:

- `npm run typecheck`
- `node --import tsx --test test/respond.test.js` or `npm test`
- `npm run test:all`
- `npx wrangler deploy --dry-run`
