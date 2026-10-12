// Nyra — crypto: master key handling and AES-256-GCM credential encryption.
import { bytesToBase64, base64ToBytes } from "./utils.js";

// --- Derived secrets (zero-config / one-click deployment) ------------------
// A one-click deployment only prompts for TELEGRAM_BOT_TOKEN and ADMIN_IDS, so
// the webhook secret and the credential master key are derived deterministically
// from the bot token via HKDF-SHA256 when the explicit env secrets are absent.
// Explicit secrets always take precedence — existing installations keep the
// exact keys they already use. Trade-off (documented in README): anyone who
// obtains the bot token can derive the master key, so protect the token.
const DERIVED_MASTER_SALT = "nyra:derived-master-key:v1";
const DERIVED_MASTER_INFO = "nyra credential encryption master key";
const DERIVED_WEBHOOK_SALT = "nyra:derived-webhook-secret:v1";
const DERIVED_WEBHOOK_INFO = "nyra telegram webhook secret token";

let derived = { token: null, masterKey: null, webhookSecret: null };

async function hkdfSha256(ikm, saltStr, infoStr, bits) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(ikm), { name: "HKDF" }, false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(saltStr), info: enc.encode(infoStr) },
    baseKey, bits);
  return new Uint8Array(out);
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Idempotent and keyed by the token: safe to call from every entry point
// (fetch, queue consumer, scheduled handler) and from encrypt/decrypt.
export async function initSecrets(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || derived.token === token) return;
  const masterKey = await hkdfSha256(token, DERIVED_MASTER_SALT, DERIVED_MASTER_INFO, 256);
  const webhookSecret = bytesToHex(await hkdfSha256(token, DERIVED_WEBHOOK_SALT, DERIVED_WEBHOOK_INFO, 256));
  derived = { token: token, masterKey: masterKey, webhookSecret: webhookSecret };
}

export function getMasterKey(env) {
  if (env.ENCRYPTION_KEY) {
    // An explicit-but-invalid key must fail loudly, never silently fall back.
    try {
      const bytes = base64ToBytes(env.ENCRYPTION_KEY);
      if (bytes.length !== 32) return null;
      return bytes;
    } catch (err) { return null; }
  }
  if (env.TELEGRAM_BOT_TOKEN && derived.token === env.TELEGRAM_BOT_TOKEN) return derived.masterKey;
  return null;
}

// Effective webhook secret: explicit env value wins, otherwise the
// token-derived value (byte-identical everywhere — single implementation).
export async function getWebhookSecret(env) {
  if (env.TELEGRAM_SECRET) return env.TELEGRAM_SECRET;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  await initSecrets(env);
  return derived.token === env.TELEGRAM_BOT_TOKEN ? derived.webhookSecret : null;
}

async function deriveKeyForOwner(masterKeyBytes, ownerId) {
  const baseKey = await crypto.subtle.importKey("raw", masterKeyBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const salt = new TextEncoder().encode("nyra-owner-" + ownerId);
  const info = new TextEncoder().encode("nyra-credential-v2");
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: info }, baseKey, 256);
  return new Uint8Array(bits);
}

export async function encryptCredential(env, ownerId, plaintext) {
  await initSecrets(env);
  const masterKey = getMasterKey(env);
  if (!masterKey) throw new Error("ENCRYPTION_KEY_MISSING");
  const ownerKey = await deriveKeyForOwner(masterKey, ownerId);
  const key = await crypto.subtle.importKey("raw", ownerKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext));
  return { ct: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptCredential(env, ownerId, ctB64, ivB64) {
  await initSecrets(env);
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
