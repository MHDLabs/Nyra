// Nyra — Telegram Bot API layer: calls, send/edit/delete, keyboards, typing heartbeat.
import { TELEGRAM_API, MAX_TELEGRAM_LENGTH, TELEGRAM_TIMEOUT_MS, TELEGRAM_RETRY_MAX, TELEGRAM_RETRY_WAIT_CAP_MS, TYPING_HEARTBEAT_MS, WEBHOOK_RECHECK_MS, WEBHOOK_ATTEMPT_GUARD_MS } from "./config.js";
import { truncate, sleep, splitForTelegram, fetchWithTimeout } from "./utils.js";
import { getWebhookSecret } from "./crypto.js";

export async function tg(env, method, payload, attempt) {
  const currentAttempt = attempt || 0;
  const url = TELEGRAM_API + "/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method;
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, TELEGRAM_TIMEOUT_MS);
    const data = await resp.json();
    if (!data.ok) {
      if (data.error_code === 429 && data.parameters && data.parameters.retry_after && currentAttempt < TELEGRAM_RETRY_MAX) {
        const waitMs = Math.min(data.parameters.retry_after * 1000, TELEGRAM_RETRY_WAIT_CAP_MS);
        await sleep(waitMs);
        return await tg(env, method, payload, currentAttempt + 1);
      }
      console.error("Telegram API error [" + method + "]:", data.description || data);
    }
    return data;
  } catch (err) {
    console.error("Telegram fetch failed [" + method + "]:", err.message);
    return { ok: false, description: err.message };
  }
}

// --- Automatic webhook registration (zero-config deployment) ---------------
// The Worker registers its own Telegram webhook without any user step:
//   * GET /status (the bootstrap page, hit by the post-deploy probe) learns the
//     public origin from the incoming request and registers it; any other
//     Worker-handled request (for example a Mini App /api/* call) learns it too;
//   * the scheduled handler re-verifies the learned URL (Telegram-side
//     deletions then self-heal within one cron interval).
// KV state bounds Telegram API traffic: at most one verification per
// WEBHOOK_ATTEMPT_GUARD_MS, full re-checks at most per WEBHOOK_RECHECK_MS.
const WEBHOOK_STATE_KEY = "nyra:webhook:state";
// Mini App menu button (the "Nyra" button next to the Telegram input field).
const MENU_BUTTON_STATE_KEY = "nyra:menu:button:state";
const MENU_BUTTON_TEXT = "Nyra";

async function readWebhookState(env) {
  try {
    const raw = await env.KV.get(WEBHOOK_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("Webhook state read failed:", err.message);
    return null;
  }
}

async function writeWebhookState(env, state) {
  try { await env.KV.put(WEBHOOK_STATE_KEY, JSON.stringify(state)); }
  catch (err) { console.error("Webhook state write failed:", err.message); }
}

// Short, non-reversible tag for a webhook secret. Only the tag is persisted, so
// a rotated TELEGRAM_SECRET is detectable without storing the secret in KV.
async function secretFingerprint(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const bytes = new Uint8Array(digest).subarray(0, 8);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// origin: public origin (scheme://host) of the current request, or null from
// the scheduled handler — then the already-learned URL is re-verified.
export async function ensureWebhook(env, origin) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, status: "no_token" };
    const secret = await getWebhookSecret(env);
    if (!secret) return { ok: false, status: "no_secret" };
    // Telegram stores the secret_token from the last successful setWebhook, so
    // a changed TELEGRAM_SECRET must invalidate the cached state — otherwise
    // the cache would report "verified" while Telegram still sends the old
    // value and every update is rejected as unauthorized.
    const secretTag = await secretFingerprint(secret);
    const state = await readWebhookState(env);
    // A stored state belongs to the current secret only when its tag matches.
    // The learned URL is independent of the secret, so it survives rotation.
    const rotated = !state || state.secretTag !== secretTag;
    const target = origin || (state && state.url) || null;
    if (!target) return { ok: false, status: "awaiting_first_request" };
    const nowMs = Date.now();
    const webhookUrl = target.replace(/\/+$/, "") + "/webhook";
    // Only a verification performed with this exact secret can be reused.
    if (!rotated && state.verifiedAt && nowMs - state.verifiedAt < WEBHOOK_RECHECK_MS && state.url === target) {
      return { ok: true, status: "cached", url: webhookUrl };
    }
    if (!rotated && state.attemptedAt && nowMs - state.attemptedAt < WEBHOOK_ATTEMPT_GUARD_MS) {
      return { ok: false, status: "busy", url: webhookUrl };
    }
    // Claim the attempt window BEFORE any Telegram call (hammering guard).
    await writeWebhookState(env, {
      url: (state && state.url) || null,
      attemptedAt: nowMs,
      verifiedAt: rotated ? 0 : (state && state.verifiedAt) || 0,
      secretTag: secretTag
    });
    // getWebhookInfo only reports the URL, never the secret_token, so it can
    // confirm a registration only when the secret has not changed.
    if (!rotated) {
      const info = await tg(env, "getWebhookInfo", {});
      if (info && info.ok && info.result && info.result.url === webhookUrl) {
        await writeWebhookState(env, { url: target, attemptedAt: 0, verifiedAt: nowMs, secretTag: secretTag });
        return { ok: true, status: "verified", url: webhookUrl };
      }
    }
    const set = await tg(env, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"]
    });
    if (set && set.ok) {
      await writeWebhookState(env, { url: target, attemptedAt: 0, verifiedAt: nowMs, secretTag: secretTag });
      console.log("Webhook registered: " + webhookUrl);
      return { ok: true, status: "registered", url: webhookUrl };
    }
    return { ok: false, status: "error", detail: (set && set.description) || "setWebhook failed" };
  } catch (err) {
    console.error("ensureWebhook failed:", err.message);
    return { ok: false, status: "error", detail: err.message };
  }
}

// Register the Mini App as the bot's chat menu button, so it is reachable from
// the Telegram UI (the button next to the message input). Idempotent and
// KV-gated: at most one setChatMenuButton per origin per WEBHOOK_RECHECK_MS.
export async function ensureMenuButton(env, origin) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, status: "no_token" };
    const target = origin ? origin.replace(/\/+$/, "") : null;
    if (!target) return { ok: false, status: "awaiting_first_request" };
    let state = null;
    try {
      const raw = await env.KV.get(MENU_BUTTON_STATE_KEY);
      state = raw ? JSON.parse(raw) : null;
    } catch (err) { state = null; }
    const nowMs = Date.now();
    if (state && state.url === target && state.setAt && nowMs - state.setAt < WEBHOOK_RECHECK_MS) {
      return { ok: true, status: "cached" };
    }
    const result = await tg(env, "setChatMenuButton", {
      menu_button: { type: "web_app", text: MENU_BUTTON_TEXT, web_app: { url: target } }
    });
    if (result && result.ok) {
      try { await env.KV.put(MENU_BUTTON_STATE_KEY, JSON.stringify({ url: target, setAt: nowMs })); }
      catch (err) {}
      console.log("Mini App menu button registered: " + target);
      return { ok: true, status: "registered" };
    }
    return { ok: false, status: "error", detail: (result && result.description) || "setChatMenuButton failed" };
  } catch (err) {
    console.error("ensureMenuButton failed:", err.message);
    return { ok: false, status: "error", detail: err.message };
  }
}

function isParseError(result) {
  if (!result || result.ok) return false;
  const d = String(result.description || "").toLowerCase();
  return d.indexOf("parse") !== -1 || d.indexOf("entity") !== -1 || d.indexOf("tag") !== -1;
}

// Container/extension → media type, for images the user sends as a document.
const IMAGE_MEDIA_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

function mediaTypeForDocument(doc) {
  if (!doc) return "image/jpeg";
  if (doc.mime_type && doc.mime_type.indexOf("image/") === 0) return doc.mime_type;
  const name = String(doc.file_name || "");
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "image/jpeg";
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_MEDIA_TYPES[ext] || null;
}

/**
 * Pick the image Telegram sent that is worth sending to a vision model:
 * the largest `photo` size, or an image `document` (uncompressed uploads) when
 * no photo size is present. Returns null when the message carries no image.
 */
export function pickImageFile(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    let best = message.photo[0];
    for (let i = 1; i < message.photo.length; i++) {
      const p = message.photo[i];
      if ((p.file_size || 0) > (best.file_size || 0)) best = p;
    }
    if (!best || !best.file_id) return null;
    return { fileId: best.file_id, mediaType: "image/jpeg" };
  }
  if (message.document) {
    const mediaType = mediaTypeForDocument(message.document);
    if (!mediaType) return null;
    if ((message.document.file_size || 0) > 10 * 1024 * 1024) return null;
    return { fileId: message.document.file_id, mediaType: mediaType };
  }
  return null;
}

const TELEGRAM_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Download a Telegram file by file_id and return base64 plus its media type. */
export async function downloadTelegramFile(env, fileId) {
  if (!env.TELEGRAM_BOT_TOKEN || !fileId) return null;
  try {
    const info = await tg(env, "getFile", { file_id: fileId });
    if (!info || !info.ok || !info.result || !info.result.file_path) return null;
    const filePath = info.result.file_path;
    const url = TELEGRAM_API + "/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath;
    const resp = await fetchWithTimeout(url, { method: "GET", cache: "no-store" }, TELEGRAM_TIMEOUT_MS);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0 || buf.byteLength > TELEGRAM_FILE_MAX_BYTES) return null;
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { data: btoa(binary), mediaType: mediaTypeForDocument({ file_name: filePath }) || "image/jpeg" };
  } catch (err) {
    console.error("downloadTelegramFile failed:", err.message);
    return null;
  }
}

export async function sendMessageReturn(env, chatId, text, options) {
  const opts = options || {};
  const safeText = truncate(text || "", 40000);
  const chunks = splitForTelegram(safeText, MAX_TELEGRAM_LENGTH);
  let firstResult = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i], disable_web_page_preview: true };
    if (opts.parse_mode) payload.parse_mode = opts.parse_mode;
    if (opts.reply_markup && i === chunks.length - 1) payload.reply_markup = opts.reply_markup;
    if (opts.reply_to_message_id && i === 0) payload.reply_to_message_id = opts.reply_to_message_id;
    let result = await tg(env, "sendMessage", payload);
    if (isParseError(result) && payload.parse_mode) {
      delete payload.parse_mode;
      result = await tg(env, "sendMessage", payload);
    }
    if (i === 0) firstResult = result;
  }
  return firstResult;
}

export async function sendMessage(env, chatId, text, options) {
  const result = await sendMessageReturn(env, chatId, text, options);
  return result && result.ok;
}

export async function sendMessageSafeResult(env, chatId, text, options) {
  const opts = options || {};
  let result = await sendMessageReturn(env, chatId, text, opts);
  if (result && result.ok) return result;
  if (!opts.reply_to_message_id) return result;
  const retryOpts = Object.assign({}, opts);
  delete retryOpts.reply_to_message_id;
  return await sendMessageReturn(env, chatId, text, retryOpts);
}

export async function answerCallback(env, callbackId, text) {
  try { await tg(env, "answerCallbackQuery", { callback_query_id: callbackId, text: text || "" }); }
  catch (err) { console.error("answerCallback failed:", err.message); }
}

export async function editMessage(env, chatId, messageId, text, replyMarkup, parseMode) {
  if (!messageId) {
    const opts = {};
    if (replyMarkup) opts.reply_markup = replyMarkup;
    if (parseMode) opts.parse_mode = parseMode;
    return await sendMessageReturn(env, chatId, text, opts);
  }
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: truncate(text || "\u200b", MAX_TELEGRAM_LENGTH),
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (parseMode) payload.parse_mode = parseMode;
  let result = await tg(env, "editMessageText", payload);
  if (isParseError(result) && payload.parse_mode) {
    delete payload.parse_mode;
    result = await tg(env, "editMessageText", payload);
  }
  return result;
}

export async function deleteMessage(env, chatId, messageId) {
  try { return await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId }); }
  catch (err) { console.error("deleteMessage failed:", err.message); return { ok: false }; }
}

export function buildInlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function startTypingHeartbeat(env, ctx, chatId) {
  const signal = { stopped: false, cancelTimer: null };
  const task = (async function () {
    let consecutiveErrors = 0;
    while (!signal.stopped) {
      try {
        const result = await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
        if (result && result.ok) consecutiveErrors = 0;
        else consecutiveErrors++;
      } catch (e) {
        consecutiveErrors++;
      }
      if (consecutiveErrors >= 5) break;
      await new Promise(function (resolve) {
        let resolved = false;
        const finish = function () { if (!resolved) { resolved = true; resolve(); } };
        const timer = setTimeout(finish, TYPING_HEARTBEAT_MS);
        signal.cancelTimer = function () { clearTimeout(timer); finish(); };
      });
      signal.cancelTimer = null;
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(task);
  return {
    stop: function () {
      signal.stopped = true;
      if (signal.cancelTimer) signal.cancelTimer();
    }
  };
}
