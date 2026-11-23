/**
 * Dead-letter queue handling: logs permanently failed updates after max retries.
 * Failed updates are stored in D1 for admin review and optional manual replay.
 */

import { now, truncate } from "./utils.js";
import { redactSecrets, redactValue } from "./redact.js";

type DlqStatement = {
  bind(...args: unknown[]): DlqStatement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

type DlqEnv = {
  DB: {
    prepare(sql: string): DlqStatement;
  };
  NYRA_QUEUE: {
    send(body: unknown): Promise<void>;
  };
  ADMIN_IDS?: string | null;
};

type QueueMessageLike = {
  body?: {
    update?: TelegramUpdateLike;
    media_group_flush?: { chat_id?: number | string; media_group_id?: string };
  };
  attempts?: number;
  timestamp?: number;
};

type TelegramUpdateLike = {
  update_id?: number;
  message?: {
    from?: { id?: number };
    chat?: { id?: number };
    text?: string;
  };
  callback_query?: {
    from?: { id?: number };
    message?: { chat?: { id?: number } };
    data?: string;
  };
};

export type FailedUpdateRow = {
  id: number;
  update_id: number;
  user_id: number;
  chat_id: number;
  message_text: string;
  error_info: string;
  created_at: number;
  replayed_at: number | null;
};

export type FailedUpdatesPage = {
  items: FailedUpdateRow[];
  total: number;
  limit: number;
  offset: number;
};

function asFiniteInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clampLimit(limit: unknown): number {
  const n = asFiniteInt(limit, 50);
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

function clampOffset(offset: unknown): number {
  const n = asFiniteInt(offset, 0);
  return n < 0 ? 0 : n;
}

function clampRetentionDays(days: unknown): number {
  const n = asFiniteInt(days, 30);
  if (n < 1) return 1;
  if (n > 3650) return 3650;
  return n;
}

function redactionOpts(env: DlqEnv) {
  return { env: { ADMIN_IDS: env.ADMIN_IDS || undefined } };
}

/**
 * Log a failed queue message to the database.
 */
export async function logFailedUpdate(env: DlqEnv, message: unknown): Promise<void> {
  const ts = now();
  const msg = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const body = msg.body && typeof msg.body === "object" ? (msg.body as Record<string, unknown>) : undefined;
  const update = body && body.update && typeof body.update === "object" ? (body.update as TelegramUpdateLike) : undefined;
  const album = body && body.media_group_flush && typeof body.media_group_flush === "object"
    ? body.media_group_flush as { chat_id?: number | string; media_group_id?: string }
    : undefined;
  const updateId = (update && update.update_id) || 0;
  const userId =
    (update && update.message && update.message.from && update.message.from.id) ||
    (update && update.callback_query && update.callback_query.from && update.callback_query.from.id) ||
    0;
  const chatId =
    (update && update.message && update.message.chat && update.message.chat.id) ||
    (update &&
      update.callback_query &&
      update.callback_query.message &&
      update.callback_query.message.chat &&
      update.callback_query.message.chat.id) ||
    (album && album.chat_id) ||
    0;
  const messageText =
    (update && update.message && update.message.text) ||
    (update && update.callback_query && update.callback_query.data) ||
    (album ? "[photo album " + String(album.media_group_id || "") + "]" : "");
  const attempts = typeof msg.attempts === "number" ? msg.attempts : 0;
  let timestamp: number = ts;
  if (typeof msg.timestamp === "number") timestamp = msg.timestamp;
  else if (msg.timestamp instanceof Date) timestamp = Math.floor(msg.timestamp.getTime() / 1000);
  const errorInfo = JSON.stringify({
    attempts,
    timestamp,
    body: update ? { update } : (album ? { media_group_flush: album } : null)
  }).substring(0, 10000);

  try {
    await env.DB.prepare(
      "INSERT INTO failed_updates (update_id, user_id, chat_id, message_text, error_info, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(updateId, userId, chatId, String(messageText).substring(0, 500), errorInfo, ts)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to log DLQ message:", redactSecrets(msg));
  }
}

/**
 * List failed updates for admin review.
 * Display fields are redacted; stored rows are not modified.
 */
export async function listFailedUpdates(
  env: DlqEnv,
  limit: unknown = 50,
  offset: unknown = 0
): Promise<FailedUpdatesPage> {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);
  const opts = redactionOpts(env);

  const countResult = await env.DB.prepare("SELECT COUNT(*) as total FROM failed_updates").first<{ total?: number }>();
  const total = Number(countResult && countResult.total) || 0;

  const results = await env.DB.prepare(
    "SELECT id, update_id, user_id, chat_id, message_text, error_info, created_at, replayed_at FROM failed_updates ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(safeLimit, safeOffset)
    .all<FailedUpdateRow>();

  const items = (results.results || []).map(function (row) {
    const text = redactSecrets(String(row.message_text || ""), opts).slice(0, 500);
    let errorInfo = "";
    const rawInfo = row.error_info;
    if (rawInfo === null || rawInfo === undefined || rawInfo === "") {
      errorInfo = "";
    } else {
      try {
        const parsed = JSON.parse(String(rawInfo)) as unknown;
        const redacted = redactValue(parsed, opts);
        errorInfo = truncate(JSON.stringify(redacted), 1000);
      } catch {
        errorInfo = truncate(redactSecrets(String(rawInfo), opts), 1000);
      }
    }
    return Object.assign({}, row, {
      message_text: text,
      error_info: errorInfo
    });
  });

  return {
    items,
    total,
    limit: safeLimit,
    offset: safeOffset
  };
}

/**
 * Replay a failed update by re-enqueuing the original stored update body.
 * Does not use the redacted admin display copy.
 */
export async function replayFailedUpdate(env: DlqEnv, id: unknown): Promise<boolean> {
  const recordId = asFiniteInt(id, 0);
  if (recordId <= 0) return false;

  const record = await env.DB.prepare("SELECT error_info, replayed_at FROM failed_updates WHERE id = ?")
    .bind(recordId)
    .first<{ error_info?: string; replayed_at?: number | null }>();
  if (!record) return false;
  if (record.replayed_at) return false;

  try {
    const errorInfo = JSON.parse(record.error_info || "{}") as {
      body?: { update?: unknown; media_group_flush?: unknown };
    };
    const body = errorInfo.body;
    if (!body || typeof body !== "object") return false;

    if (body.media_group_flush && typeof body.media_group_flush === "object") {
      await env.NYRA_QUEUE.send({ media_group_flush: body.media_group_flush });
    } else if (body.update && typeof body.update === "object") {
      await env.NYRA_QUEUE.send({ update: body.update });
    } else {
      return false;
    }
    await env.DB.prepare("UPDATE failed_updates SET replayed_at = ? WHERE id = ?").bind(now(), recordId).run();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to replay update:", redactSecrets(msg));
    return false;
  }
}

/**
 * Clean up old failed updates that have not been replayed.
 */
export async function cleanupOldFailedUpdates(env: DlqEnv, retentionDays: unknown = 30): Promise<number> {
  const days = clampRetentionDays(retentionDays);
  const cutoff = now() - days * 24 * 3600;
  try {
    const result = await env.DB.prepare(
      "DELETE FROM failed_updates WHERE created_at < ? AND replayed_at IS NULL"
    )
      .bind(cutoff)
      .run();
    const deleted = (result && result.meta && result.meta.changes) || 0;
    if (deleted > 0) {
      console.log("DLQ cleanup: deleted " + deleted + " failed updates older than " + days + " days");
    }
    return deleted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("DLQ cleanup failed:", redactSecrets(msg));
    return 0;
  }
}
