# Task 14 — Secret Redaction TypeScript Hardening

## Threat boundary

`src/redact.ts` is the only module responsible for scrubbing credentials and
admin identifiers from log lines and diagnostic payloads. It must remain free of
bindings, network access, and application imports.

## Hardening

- Removed `@ts-nocheck`.
- Introduced `SecretKind`, `RedactionOptions`, `RedactedErrorDetail`,
  `RedactableErrorLike`, and typed `RedactionRule`.
- Exported functions accept `unknown` at untrusted boundaries and never throw
  secret-bearing values on failure.

## Invariants preserved

- Replacement marker remains `[REDACTED]`.
- Rule order and regex sources unchanged.
- Admin ID matching uses digit boundaries (`(?<!\d)...(?!\d)`).
- Depth limit (6), array/object key caps (100), and `MAX_DETAIL_LENGTH` (300)
  unchanged.
- Inputs are not mutated.

## Tests

`test/redact.test.js` covers bot tokens, auth headers, init data, env secrets,
provider key prefixes, JWT/base64/hex, admin-id boundaries, deep objects, Error
instances, depth limits, throwing getters, and safe error diagnostics.

## Coverage

`@ts-nocheck` under `src/`: 58 → 57 (this module).

## Recommended next task

Dedicated security typing for `src/websearch.ts` (untrusted HTML/URL boundary)
with its own adversarial suite.
