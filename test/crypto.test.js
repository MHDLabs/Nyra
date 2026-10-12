import { test } from "node:test";
import assert from "node:assert/strict";
import { getMasterKey, initSecrets, getWebhookSecret, encryptCredential, decryptCredential } from "../src/crypto.js";
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

// --- Derived secrets (one-click deployment) --------------------------------

test("derived webhook secret is deterministic, 64-char lowercase hex", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "123456789:AA-derivation-a" };
  const a = await getWebhookSecret(env);
  const b = await getWebhookSecret(env);
  assert.equal(a, b);
  // Telegram secret_token charset: A-Za-z0-9_- — hex satisfies it.
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("different bot tokens derive different webhook secrets", async () => {
  const a = await getWebhookSecret({ TELEGRAM_BOT_TOKEN: "1:AAA" });
  const b = await getWebhookSecret({ TELEGRAM_BOT_TOKEN: "1:BBB" });
  assert.notEqual(a, b);
  assert.match(b, /^[0-9a-f]{64}$/);
});

test("explicit env secrets always win over derived values", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "1:AAA", TELEGRAM_SECRET: "explicit-secret" };
  assert.equal(await getWebhookSecret(env), "explicit-secret");
  const envKey = { TELEGRAM_BOT_TOKEN: "1:AAA", ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(9)) };
  await initSecrets(envKey);
  const key = getMasterKey(envKey);
  assert.ok(key instanceof Uint8Array);
  assert.deepEqual(key, new Uint8Array(32).fill(9));
});

test("token-only env: master key derives and encrypt/decrypt round trips", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "999:token-only-master" };
  await initSecrets(env);
  const key = getMasterKey(env);
  assert.ok(key instanceof Uint8Array);
  assert.equal(key.length, 32);
  const { ct, iv } = await encryptCredential(env, 42, "sk-derived-roundtrip");
  assert.equal(await decryptCredential(env, 42, ct, iv), "sk-derived-roundtrip");
  // encryptCredential also self-initialises: a fresh module import order is
  // covered by the explicit call above; wrong owner still fails.
  await assert.rejects(() => decryptCredential(env, 43, ct, iv), /DECRYPTION_FAILED/);
});

test("no token and no env key: no master key, no webhook secret", async () => {
  assert.equal(getMasterKey({}), null);
  assert.equal(await getWebhookSecret({}), null);
});
