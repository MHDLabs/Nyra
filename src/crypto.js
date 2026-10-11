// Nyra — crypto: master key handling and AES-256-GCM credential encryption.
import { bytesToBase64, base64ToBytes } from "./utils.js";

export function getMasterKey(env) {
  if (!env.ENCRYPTION_KEY) return null;
  try {
    const bytes = base64ToBytes(env.ENCRYPTION_KEY);
    if (bytes.length !== 32) return null;
    return bytes;
  } catch (err) { return null; }
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
