# Task 17 — Cryptography Module Hardening

## Architecture (unchanged)

- Master key: `ENCRYPTION_KEY` as base64 of exactly 32 bytes (never derived from bot token).
- Per-owner key: HKDF-SHA256, salt `nyra-owner-${ownerId}`, info `nyra-credential-v2`, 256-bit output.
- Encryption: AES-256-GCM, random 12-byte IV, ciphertext + IV stored as Base64.

## TypeScript

Removed `@ts-nocheck`. Added:

- `CryptoEnv`
- `EncryptedCredential`
- Explicit parameter/return types on all exports
- `getWebhookSecret` remains `async`

## Validation

- Master key still requires exactly 32 decoded bytes.
- Decrypt rejects missing/malformed Base64 and non-12-byte IVs with `INVALID_CIPHERTEXT`.
- Auth failures remain `DECRYPTION_FAILED` without returning plaintext.

## Compatibility

HKDF salt/info, AES-GCM parameters, and stored `{ct, iv}` format are unchanged. Existing ciphertext remains decryptable.

## Tests

`test/crypto.test.js` extended with empty plaintext, invalid Base64, wrong IV length, and missing fields.
