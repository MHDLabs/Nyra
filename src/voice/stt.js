// Speech-to-text for Telegram voice messages.
//
// Scope is deliberately narrow: only `message.voice` is transcribed. Audio
// files, video notes and documents are not — they are not voice messages, and
// silently transcribing arbitrary uploads would be surprising.
//
// Guarantees:
//   * at-most-once per (chat_id, message_id): the D1 primary key is the lock,
//     so two concurrent updates for the same message cannot both call the
//     provider;
//   * eligibility is decided in one place, so the AI path and the cleanup job
//     agree on which messages count;
//   * a transcript is dropped once its originating message is no longer in the
//     latest MAX_CONTEXT_MESSAGES of the thread.
import { GROQ_STT_URL, GROQ_STT_MODEL, STT_TIMEOUT_MS, STT_MAX_BYTES, STT_MAX_TRANSCRIPT, MAX_CONTEXT_MESSAGES } from "../config.js";
import { now } from "../utils.js";
import { tg } from "../telegram.js";
import { TELEGRAM_API } from "../config.js";

/** Only a real voice note (the push-to-talk kind) qualifies. */
export function isVoiceMessage(message) {
  return !!(message && message.voice && typeof message.voice.file_id === "string" && message.voice.file_id);
}

/**
 * Whether this voice message should be transcribed at all.
 *
 * Private chat: always. Group chat: only when the voice message is the one that
 * triggered the bot (a reply to it, or a caption that addresses Nyra) — a group
 * full of unrelated voice notes must not burn transcription quota.
 */
export function isVoiceTranscribable(message, isGroup, triggered) {
  if (!isVoiceMessage(message)) return false;
  if ((message.voice.file_size || 0) > STT_MAX_BYTES) return false;
  if (!isGroup) return true;
  return triggered === true;
}

/** Resolve the Groq key: a dedicated secret, else the OpenAI one if it is Groq. */
export function getSttKey(env) {
  const dedicated = String((env && env.GROQ_API_KEY) || "").trim();
  if (dedicated) return dedicated;
  const fallback = String((env && env.GROQ_STT_API_KEY) || "").trim();
  return fallback;
}

async function downloadVoice(env, fileId) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const info = await tg(env, "getFile", { file_id: fileId });
  if (!info || !info.ok || !info.result || !info.result.file_path) return null;
  const url = TELEGRAM_API + "/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + info.result.file_path;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength > STT_MAX_BYTES) return null;
  return { buffer, filename: "voice.ogg", contentType: "audio/ogg" };
}

async function callGroq(env, key, audio) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, STT_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", new Blob([audio.buffer], { type: audio.contentType }), audio.filename);
    form.append("model", GROQ_STT_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const response = await fetch(GROQ_STT_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: form,
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      const detail = raw.slice(0, 180).replace(/\s+/g, " ").trim();
      throw new Error("Groq STT HTTP " + response.status + (detail ? ": " + detail : ""));
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error("Groq STT returned non-JSON"); }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) throw new Error("Groq STT returned an empty transcript");
    return text.slice(0, STT_MAX_TRANSCRIPT);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the cached row for a voice message, if any. */
export async function getTranscript(env, chatId, messageId) {
  try {
    return await env.DB.prepare("SELECT transcript, status FROM voice_transcripts WHERE chat_id = ? AND message_id = ?")
      .bind(chatId, messageId).first();
  } catch (err) {
    return null;
  }
}

/**
 * Transcribe a voice message at most once.
 *
 * Returns `{ ok, transcript }` or `{ ok: false, reason }`. Never throws: a
 * transcription failure degrades to the existing "[user sent a voice message]"
 * placeholder rather than failing the whole turn.
 */
export async function transcribeVoice(env, chatId, message) {
  const messageId = message && message.message_id;
  if (!isVoiceMessage(message) || typeof messageId !== "number") return { ok: false, reason: "not_a_voice_message" };

  const existing = await getTranscript(env, chatId, messageId);
  if (existing && existing.status === "done" && existing.transcript) return { ok: true, transcript: existing.transcript };
  if (existing && existing.status === "pending") return { ok: false, reason: "in_progress" };

  const key = getSttKey(env);
  if (!key) {
    await recordFailure(env, chatId, messageId, "GROQ_API_KEY is not configured");
    return { ok: false, reason: "not_configured" };
  }

  // Claim the row first. `INSERT OR IGNORE` + a changes check is the whole
  // concurrency control: exactly one caller wins and does the network work.
  let claimed = false;
  try {
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO voice_transcripts (chat_id, message_id, transcript, status, error, created_at) VALUES (?, ?, NULL, 'pending', NULL, ?)"
    ).bind(chatId, messageId, now()).run();
    claimed = !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    return { ok: false, reason: "storage_unavailable" };
  }
  if (!claimed) {
    const row = await getTranscript(env, chatId, messageId);
    if (row && row.status === "done" && row.transcript) return { ok: true, transcript: row.transcript };
    return { ok: false, reason: "in_progress" };
  }

  let audio;
  try {
    audio = await downloadVoice(env, message.voice.file_id);
  } catch (err) {
    audio = null;
  }
  if (!audio) {
    await recordFailure(env, chatId, messageId, "voice download failed");
    return { ok: false, reason: "download_failed" };
  }

  try {
    const transcript = await callGroq(env, key, audio);
    await env.DB.prepare("UPDATE voice_transcripts SET transcript = ?, status = 'done', error = NULL WHERE chat_id = ? AND message_id = ?")
      .bind(transcript, chatId, messageId).run();
    return { ok: true, transcript };
  } catch (err) {
    await recordFailure(env, chatId, messageId, String(err.message || "transcription failed").slice(0, 200));
    return { ok: false, reason: "provider_error" };
  }
}

async function recordFailure(env, chatId, messageId, error) {
  try {
    await env.DB.prepare(
      "INSERT INTO voice_transcripts (chat_id, message_id, transcript, status, error, created_at) VALUES (?, ?, NULL, 'failed', ?, ?) " +
      "ON CONFLICT(chat_id, message_id) DO UPDATE SET status = 'failed', error = excluded.error"
    ).bind(chatId, messageId, error, now()).run();
  } catch (err) { /* best effort */ }
}

/**
 * Drop transcripts whose originating message has fallen outside the latest
 * MAX_CONTEXT_MESSAGES of its own thread. Called from the cron housekeeping pass
 * so the table cannot grow without bound.
 */
export async function pruneStaleTranscripts(env, chatId, threadId) {
  try {
    const rows = await env.DB.prepare(
      "SELECT message_id FROM thread_messages WHERE chat_id = ? AND thread_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?"
    ).bind(chatId, threadId, MAX_CONTEXT_MESSAGES).all();
    const keep = new Set((rows.results || []).map(function (row) { return Number(row.message_id); }));
    const existing = await env.DB.prepare(
      "SELECT vt.message_id FROM voice_transcripts vt JOIN thread_messages tm ON tm.chat_id = vt.chat_id AND tm.message_id = vt.message_id WHERE vt.chat_id = ? AND tm.thread_id = ?"
    ).bind(chatId, threadId).all();
    let removed = 0;
    for (const row of existing.results || []) {
      if (keep.has(Number(row.message_id))) continue;
      await env.DB.prepare("DELETE FROM voice_transcripts WHERE chat_id = ? AND message_id = ?").bind(chatId, row.message_id).run();
      removed++;
    }
    return removed;
  } catch (err) {
    return 0;
  }
}

/** Global safety net so abandoned rows cannot accumulate. */
export async function pruneOldTranscripts(env, olderThanSeconds) {
  const cutoff = now() - (olderThanSeconds || 7 * 24 * 3600);
  try {
    const result = await env.DB.prepare("DELETE FROM voice_transcripts WHERE created_at < ?").bind(cutoff).run();
    return (result && result.meta && result.meta.changes) || 0;
  } catch (err) {
    return 0;
  }
}

/** Prefix a user-content string with a real transcript instead of a placeholder. */
export function withTranscript(content, transcript) {
  if (!transcript) return content;
  const base = String(content || "");
  if (base.indexOf("[user sent a voice message]") === -1) return base;
  return base.replace("[user sent a voice message]", '[transcribed voice message] "' + transcript + '"');
}

