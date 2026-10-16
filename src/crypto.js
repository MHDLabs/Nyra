// Nyra — crypto: master key handling and AES-256-GCM credential encryption.
import { bytesToBase64, base64ToBytes } from "./utils.js";

// All three secrets are mandatory manual entries — nothing is derived from the
// bot token. TELEGRAM_BOT_TOKEN is the Telegram credential,
// TELEGRAM_SECRET is the webhook/setup secret token, and ENCRYPTION_KEY is a
// 32-byte base64 key that wraps every stored API key.
// Generate them yourself (see README):
//   openssl rand -hex 32    → TELEGRAM_SECRET
//   openssl rand -base64 32 → ENCRYPTION_KEY
// A missing or malformed secret returns null here; every entry point in
// src/index.js turns that into a hard failure (5xx) so a misconfigured
// deployment can never silently run with a weak or absent key.

// Validates and returns the 32-byte AES master key, or null when ENCRYPTION_KEY
// is absent / not base64 / not exactly 32 bytes.
export function getMasterKey(env) {
  if (!env.ENCRYPTION_KEY) return null;
  try {
    const bytes = base64ToBytes(env.ENCRYPTION_KEY);
    if (bytes.length !== 32) return null;
    return bytes;
  } catch (err) { return null; }
}

// Validates and returns the Telegram secret token, or null when unset/blank.
// This same value is used as the webhook secret_token, as the X-Setup-Secret
// header for /setup, and as the X-Telegram-Bot-Api-Secret-Token expectation.
export async function getWebhookSecret(env) {
  const secret = env.TELEGRAM_SECRET;
  if (typeof secret !== "string") return null;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Returns the list of required-but-missing/invalid secret names, or null when
// the deployment is fully configured. Entry points call this first and refuse
// to serve traffic when it returns anything — the worker must fail loudly
// rather than run with a weak or absent key.
export function validateSecrets(env) {
  const missing = [];
  if (!env.TELEGRAM_BOT_TOKEN || !String(env.TELEGRAM_BOT_TOKEN).trim()) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.TELEGRAM_SECRET || !String(env.TELEGRAM_SECRET).trim()) missing.push("TELEGRAM_SECRET");
  if (!env.ENCRYPTION_KEY || !String(env.ENCRYPTION_KEY).trim()) missing.push("ENCRYPTION_KEY");
  else if (!getMasterKey(env)) missing.push("ENCRYPTION_KEY (must be 32 bytes, base64-encoded)");
  return missing.length ? missing : null;
}

async function deriveKeyForOwner(masterKeyBytes, ownerId) {
  const baseKey = await crypto.subtle.importKey("raw", masterKeyBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const salt = new TextEncoder().encode("nyra-owner-" + ownerId);
  const info = new TextEncoder().encode("nyra-credential-v2");
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: info }, baseKey, 256);
  return new Uint8Array(bits);
}

export async function encryptCredential(env, ownerId, plaintext) {
  const masterKey = getMasterKey(env);
  if (!masterKey) throw new Error("ENCRYPTION_KEY_MISSING");
  const ownerKey = await deriveKeyForOwner(masterKey, ownerId);
  const key = await crypto.subtle.importKey("raw", ownerKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext));
  return { ct: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptCredential(env, ownerId, ctB64, ivB64) {
  const masterKey = getMasterKey(env);
  if (!masterKey) throw new Error("ENCRYPTION_KEY_MISSING");
  if (!ctB64 || !ivB64) throw new Error("INVALID_CIPHERTEXT");
  const ownerKey = await deriveKeyForOwner(masterKey, ownerId);
  const key = await crypto.subtle.importKey("raw", ownerKey, { name: "AES-GCM" }, false, ["decrypt"]);
  let iv, ct;
  try { iv = base64ToBytes(ivB64); ct = base64ToBytes(ctB64); }
  catch (err) { throw new Error("INVALID_CIPHERTEXT"); }
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    return new TextDecoder().decode(plaintext);
  } catch (err) { throw new Error("DECRYPTION_FAILED"); }
}
