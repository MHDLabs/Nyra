// Nyra — Telegram Bot API layer: calls, send/edit/delete, keyboards, typing heartbeat.
import { TELEGRAM_API, MAX_TELEGRAM_LENGTH, TELEGRAM_TIMEOUT_MS, TELEGRAM_RETRY_MAX, TELEGRAM_RETRY_WAIT_CAP_MS, TYPING_HEARTBEAT_MS } from "./config.js";
import { truncate, sleep, splitForTelegram, fetchWithTimeout } from "./utils.js";

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

function isParseError(result) {
  if (!result || result.ok) return false;
  const d = String(result.description || "").toLowerCase();
  return d.indexOf("parse") !== -1 || d.indexOf("entity") !== -1 || d.indexOf("tag") !== -1;
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
