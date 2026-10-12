// Nyra — utilities: pure helpers, sanitizers, content building, rate limiting.
import { CALLBACK_ID_MAX, MAX_MEMORY_ENTRY_LENGTH, MEMORY_RATE_BUCKET_MAX_AGE_MS, NYRA_VARIANTS } from "./config.js";

const memoryRateBuckets = new Map();

export function now() { return Math.floor(Date.now() / 1000); }
export function okResponse() { return new Response("OK", { status: 200 }); }

export function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

export function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

// Word-boundary phrase match (Unicode-aware, works for Latin and Persian).
// "art" matches "I love art" but not "party"/"start" — used by /forget so a
// short topic cannot over-delete unrelated memory entries.
export function containsPhrase(haystack, phrase) {
  if (!haystack || !phrase) return false;
  const h = String(haystack).toLowerCase();
  const p = String(phrase).toLowerCase();
  if (!p) return false;
  let idx = h.indexOf(p);
  while (idx !== -1) {
    const before = idx > 0 ? h.charAt(idx - 1) : "";
    const after = h.charAt(idx + p.length);
    const beforeOk = !before || !WORD_CHAR_RE.test(before);
    const afterOk = !after || !WORD_CHAR_RE.test(after);
    if (beforeOk && afterOk) return true;
    idx = h.indexOf(p, idx + 1);
  }
  return false;
}

export function stripTelegramHtml(text) {
  if (!text) return "";
  return text.replace(/<\/?(?:b|i|u|s|code|pre|blockquote|tg-spoiler|a)(?:\s+[^>]*)?>/gi, "");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export function safeCallbackId(id) {
  if (!id) return "";
  const s = String(id);
  if (s.length <= CALLBACK_ID_MAX) return s;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return "h" + Math.abs(hash).toString(36) + "_" + s.slice(-8);
}

export function generateShortId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(function (b) { return b.toString(36).padStart(2, "0"); }).join("").slice(0, 10);
}

export function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function isOpenRouterUrl(baseUrl) {
  if (!baseUrl) return false;
  return String(baseUrl).toLowerCase().indexOf("openrouter.ai") !== -1;
}

function isOnlyEmojiOrSymbols(text) {
  if (!text) return false;
  const cleaned = String(text).replace(/\s/g, "");
  if (!cleaned) return false;
  return !/[a-zA-Z0-9\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/.test(cleaned);
}

export function containsNyraWord(text) {
  if (!text) return false;
  if (/\bnyra\b/i.test(text)) return true;
  for (let i = 0; i < NYRA_VARIANTS.length; i++) {
    if (text.indexOf(NYRA_VARIANTS[i]) !== -1) return true;
  }
  return false;
}

export function buildUserContent(message) {
  const text = ((message.text || message.caption || "") + "").trim();
  const hasSticker = !!message.sticker;
  const hasPhoto = !!(message.photo && message.photo.length);
  const hasAnimation = !!message.animation;
  const hasVideo = !!message.video;
  const hasVoice = !!message.voice;
  const hasDocument = !!message.document;

  let replyPrefix = "";
  if (message.reply_to_message) {
    const r = message.reply_to_message;
    if (r.sticker) {
      const em = r.sticker.emoji || "";
      replyPrefix = em ? "[replying to sticker: " + em + "] " : "[replying to a sticker] ";
    } else if (r.text) {
      replyPrefix = "[replying to: " + truncate(r.text, 80) + "] ";
    }
  }

  if (hasSticker && !text) {
    const em = message.sticker.emoji || "";
    return replyPrefix + (em ? "[sticker: " + em + "]" : "[sticker]");
  }

  if (!text) {
    if (hasPhoto) return replyPrefix + "[user sent a photo]";
    if (hasAnimation) return replyPrefix + "[user sent a GIF]";
    if (hasVideo) return replyPrefix + "[user sent a video]";
    if (hasVoice) return replyPrefix + "[user sent a voice message]";
    if (hasDocument) return replyPrefix + "[user sent a file]";
    return replyPrefix ? replyPrefix.trim() : "";
  }

  if (isOnlyEmojiOrSymbols(text)) {
    return replyPrefix + "[user sent emoji: " + text + "]";
  }

  return replyPrefix + text;
}

export function sanitizeMemoryString(s) {
  if (s === undefined || s === null) return "";
  let str = String(s).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (str.length > MAX_MEMORY_ENTRY_LENGTH) str = str.slice(0, MAX_MEMORY_ENTRY_LENGTH - 3) + "...";
  return str;
}

export function sanitizeMemoryFact(fact) {
  const s = sanitizeMemoryString(fact);
  if (!s) return "";
  const lower = s.toLowerCase();
  const badPatterns = ["ignore previous", "ignore above", "ignore all prior", "ignore all previous", "system:", "assistant:", "new directive", "<|", "### instruction", "###instruction", "disregard previous", "forget your instructions"];
  for (let i = 0; i < badPatterns.length; i++) {
    if (lower.indexOf(badPatterns[i]) !== -1) return "";
  }
  return s;
}

export function dedupeArray(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const str = String(arr[i]).trim();
    const key = str.toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); result.push(str); }
  }
  return result;
}

export function filterSubstrings(arr) {
  if (!Array.isArray(arr)) return [];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    const al = a.toLowerCase().trim();
    if (!al) continue;
    let dominated = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const b = arr[j];
      const bl = b.toLowerCase().trim();
      if (bl === al) continue;
      if (bl.length < al.length + 20) continue;
      const idx = bl.indexOf(al);
      if (idx === -1) continue;
      const beforeOk = idx === 0 || /[\s,.;:!?\-]/.test(bl[idx - 1]);
      const afterIdx = idx + al.length;
      const afterOk = afterIdx >= bl.length || /[\s,.;:!?\-]/.test(bl[afterIdx]);
      if (beforeOk && afterOk) { dominated = true; break; }
    }
    if (!dominated) result.push(a);
  }
  return result;
}

export function splitForTelegram(inputText, maxLen) {
  if (!inputText) return [""];
  if (inputText.length <= maxLen) return [inputText];
  // A delivered chunk = body + optional fence closure (up to 4 chars: "\n```")
  // + optional "[i/total]\n" counter prefix. Reserve both while splitting so no
  // chunk can ever exceed maxLen — Telegram rejects over-long messages with 400
  // and the send path silently drops the reply. The counter reserve adapts to the
  // actual part count (it depends on digit width, which is only known after the
  // first split); splitting converges because a larger reserve never increases
  // the number of parts.
  const FENCE_RESERVE = 4;
  let counterReserve = 6; // "[9/9]\n"
  let parts = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const budget = Math.max(1, maxLen - counterReserve - FENCE_RESERVE);
    parts = rawSplitForTelegram(inputText, budget);
    const needed = 2 * String(parts.length).length + 4; // "[<total>/<total>]\n"
    if (needed <= counterReserve) break;
    counterReserve = needed;
  }
  const total = parts.length;
  if (total > 1) {
    return parts.map(function (p, i) { return "[" + (i + 1) + "/" + total + "]\n" + p; });
  }
  return parts;
}

function rawSplitForTelegram(inputText, budget) {
  const parts = [];
  let remaining = inputText;
  while (remaining.length > budget) {
    let splitAt = -1;
    const windowEnd = Math.min(budget, remaining.length);
    for (let i = windowEnd - 2; i >= Math.floor(budget * 0.4); i--) {
      if (remaining[i] === "\n" && remaining[i + 1] === "\n") { splitAt = i + 2; break; }
    }
    if (splitAt === -1) {
      for (let i = windowEnd - 1; i >= Math.floor(budget * 0.4); i--) {
        if (remaining[i] === "\n") { splitAt = i + 1; break; }
      }
    }
    if (splitAt === -1) {
      for (let i = windowEnd - 1; i >= Math.floor(budget * 0.4); i--) {
        if (remaining[i] === " ") { splitAt = i + 1; break; }
      }
    }
    if (splitAt === -1) splitAt = windowEnd;
    const chunk = remaining.slice(0, splitAt);
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      const lastFence = chunk.lastIndexOf("```");
      const afterFence = chunk.slice(lastFence + 3);
      const match = afterFence.match(/^([a-zA-Z0-9_+#.-]+)/);
      const lang = match ? match[1] : "";
      parts.push(chunk + "\n```");
      remaining = "```" + lang + "\n" + remaining.slice(splitAt);
      continue;
    }
    parts.push(chunk);
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) parts.push(remaining);
  const cleaned = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i].trim().length > 0) cleaned.push(parts[i]);
  }
  // Whitespace-only input: keep the (bounded) chunks rather than falling back to
  // the original unbounded string.
  return cleaned.length > 0 ? cleaned : parts;
}

export async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const opts = Object.assign({}, options, { signal: controller.signal });
    return await fetch(url, opts);
  } finally {
    clearTimeout(timer);
  }
}

// ADMIN_IDS is a required deployment input (numeric ID(s), comma-separated).
// Only strictly numeric entries count; invalid entries are surfaced for
// reporting but can never match a numeric Telegram user ID.
export function parseAdminIds(raw) {
  const entries = String(raw == null ? "" : raw).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (let i = 0; i < entries.length; i++) {
    if (/^\d{1,20}$/.test(entries[i])) valid.push(entries[i]);
    else invalid.push(entries[i]);
  }
  return { valid: valid, invalid: invalid, configured: valid.length > 0 };
}

export function isAdmin(env, userId) {
  if (!env.ADMIN_IDS) return false;
  return parseAdminIds(env.ADMIN_IDS).valid.indexOf(String(userId)) !== -1;
}

export function getAdminIds(env) {
  if (!env.ADMIN_IDS) return [];
  return parseAdminIds(env.ADMIN_IDS).valid;
}

export function checkMemoryRate(key, limit, windowMs) {
  const nowMs = Date.now();
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const bucketKey = key + ":" + bucketStart;
  const current = memoryRateBuckets.get(bucketKey) || 0;
  if (current >= limit) return false;
  memoryRateBuckets.set(bucketKey, current + 1);
  if (memoryRateBuckets.size > 5000) {
    const keysToDelete = [];
    for (const k of memoryRateBuckets.keys()) {
      const idx = k.lastIndexOf(":");
      const bStart = parseInt(k.slice(idx + 1), 10);
      if (nowMs - bStart > MEMORY_RATE_BUCKET_MAX_AGE_MS) keysToDelete.push(k);
      if (keysToDelete.length > 2500) break;
    }
    for (const k of keysToDelete) memoryRateBuckets.delete(k);
  }
  return true;
}

export async function checkRateLimit(env, key, limit, windowSeconds) {
  const windowMs = windowSeconds * 1000;
  const nowMs = Date.now();
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const bucketKey = "rl:" + key + ":" + bucketStart;
  try {
    const raw = await env.KV.get(bucketKey);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    if (current >= limit) return false;
    await env.KV.put(bucketKey, String(current + 1), { expirationTtl: windowSeconds + 60 });
    return true;
  } catch (err) {
    console.error("checkRateLimit failed:", err.message);
    return true;
  }
}
