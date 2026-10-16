import { test } from "node:test";
import assert from "node:assert/strict";
import { getMasterKey, validateSecrets, getWebhookSecret, encryptCredential, decryptCredential } from "../src/crypto.js";
import { bytesToBase64 } from "../src/utils.js";

function testEnv(fill) {
  const key = new Uint8Array(32).fill(fill);
  return { ENCRYPTION_KEY: bytesToBase64(key) };
}

test("getMasterKey accepts a 32-byte base64 key and rejects invalid ones", () => {
  assert.ok(getMasterKey(testEnv(7)) instanceof Uint8Array);
  assert.equal(getMasterKey({}), null);
  assert.equal(getMasterKey({ ENCRYPTION_KEY: "not-base64!!" }), null);
  assert.equal(getMasterKey({ ENCRYPTION_KEY: bytesToBase64(new Uint8Array(16)) }), null);
});

test("encrypt/decrypt round trip for the same owner", async () => {
  const env = testEnv(3);
  const { ct, iv } = await encryptCredential(env, 111, "sk-test-123");
  const out = await decryptCredential(env, 111, ct, iv);
  assert.equal(out, "sk-test-123");
});

test("credential cannot be decrypted with a different owner id", async () => {
  const env = testEnv(3);
  const { ct, iv } = await encryptCredential(env, 111, "sk-secret");
  await assert.rejects(() => decryptCredential(env, 222, ct, iv), /DECRYPTION_FAILED/);
});

test("tampered ciphertext fails to decrypt", async () => {
  const env = testEnv(3);
  const { ct, iv } = await encryptCredential(env, 111, "sk-secret");
  const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  const tampered = bytesToBase64(bytes);
  await assert.rejects(() => decryptCredential(env, 111, tampered, iv), /DECRYPTION_FAILED/);
});

test("different master keys produce different ciphertext", async () => {
  const { ct: ct1 } = await encryptCredential(testEnv(1), 111, "same input");
  const { ct: ct2 } = await encryptCredential(testEnv(2), 111, "same input");
  assert.notEqual(ct1, ct2);
});

// --- Mandatory manual secrets (nothing is derived from the bot token) -------

test("webhook secret comes only from TELEGRAM_SECRET", async () => {
  assert.equal(await getWebhookSecret({ TELEGRAM_SECRET: "explicit-secret" }), "explicit-secret");
  assert.equal(await getWebhookSecret({ TELEGRAM_SECRET: "  padded  " }), "padded");
  assert.equal(await getWebhookSecret({ TELEGRAM_SECRET: "   " }), null);
  assert.equal(await getWebhookSecret({}), null);
  // A bot token alone must never produce a webhook secret.
  assert.equal(await getWebhookSecret({ TELEGRAM_BOT_TOKEN: "1:AAA" }), null);
});

test("master key comes only from ENCRYPTION_KEY", () => {
  const env = { ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(9)) };
  const key = getMasterKey(env);
  assert.ok(key instanceof Uint8Array);
  assert.deepEqual(key, new Uint8Array(32).fill(9));
  // A bot token alone must never produce a master key.
  assert.equal(getMasterKey({ TELEGRAM_BOT_TOKEN: "999:token-only" }), null);
});

test("validateSecrets reports every missing or malformed secret", () => {
  assert.deepEqual(validateSecrets({}), ["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET", "ENCRYPTION_KEY"]);
  assert.deepEqual(
    validateSecrets({ TELEGRAM_BOT_TOKEN: "1:AAA", TELEGRAM_SECRET: "s", ENCRYPTION_KEY: bytesToBase64(new Uint8Array(16)) }),
    ["ENCRYPTION_KEY (must be 32 bytes, base64-encoded)"]);
  assert.deepEqual(validateSecrets({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_SECRET: "s" }), [
    "TELEGRAM_BOT_TOKEN",
    "ENCRYPTION_KEY"
  ]);
  assert.equal(validateSecrets({ TELEGRAM_BOT_TOKEN: "1:AAA", TELEGRAM_SECRET: "s", ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32)) }), null);
});

test("encryption refuses to work without an explicit master key", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "999:token-only-master" };
  assert.equal(getMasterKey(env), null);
  await assert.rejects(() => encryptCredential(env, 42, "sk-x"), /ENCRYPTION_KEY_MISSING/);
  await assert.rejects(() => decryptCredential(env, 42, "AAA", "AAA"), /ENCRYPTION_KEY_MISSING/);
});

test("explicit key round trips and rejects a different owner", async () => {
  const env = { ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(5)) };
  const { ct, iv } = await encryptCredential(env, 42, "sk-explicit-roundtrip");
  assert.equal(await decryptCredential(env, 42, ct, iv), "sk-explicit-roundtrip");
  await assert.rejects(() => decryptCredential(env, 43, ct, iv), /DECRYPTION_FAILED/);
});
