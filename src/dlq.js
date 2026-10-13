/**
 * Dead-letter queue handling: logs permanently failed updates after max retries.
 * Failed updates are stored in D1 for admin review and optional manual replay.
 */

import { now } from "./utils.js";

/**
 * Log a failed queue message to the database.
 * @param {object} env - Worker environment bindings
 * @param {object} message - Failed queue message
 */
export async function logFailedUpdate(env, message) {
  const ts = now();
  const update = message.body?.update;
  const updateId = update?.update_id || 0;
  const userId = update?.message?.from?.id || update?.callback_query?.from?.id || 0;
  const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || 0;
  const messageText = update?.message?.text || update?.callback_query?.data || "";
  const errorInfo = JSON.stringify({
    attempts: message.attempts || 0,
    timestamp: message.timestamp || ts,
    body: update
  }).substring(0, 10000);

  try {
    await env.DB.prepare(
      "INSERT INTO failed_updates (update_id, user_id, chat_id, message_text, error_info, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(updateId, userId, chatId, messageText.substring(0, 500), errorInfo, ts).run();
  } catch (err) {
    console.error("Failed to log DLQ message:", err.message);
  }
}

/**
 * List failed updates for admin review.
 * @param {object} env - Worker environment bindings
 * @param {number} limit - Max number of records to return
 * @param {number} offset - Pagination offset
 * @returns {Promise<object>} Failed updates and pagination info
 */
export async function listFailedUpdates(env, limit = 50, offset = 0) {
  const countResult = await env.DB.prepare("SELECT COUNT(*) as total FROM failed_updates").first();
  const total = countResult?.total || 0;

  const results = await env.DB.prepare(
    "SELECT id, update_id, user_id, chat_id, message_text, created_at, replayed_at FROM failed_updates ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  return {
    items: results.results || [],
    total,
    limit,
    offset
  };
}

/**
 * Replay a failed update by re-enqueuing it.
 * @param {object} env - Worker environment bindings
 * @param {number} id - Failed update record ID
 * @returns {Promise<boolean>} Success status
 */
export async function replayFailedUpdate(env, id) {
  const record = await env.DB.prepare("SELECT error_info, replayed_at FROM failed_updates WHERE id = ?").bind(id).first();
  if (!record) return false;
  if (record.replayed_at) return false; // Already replayed

  try {
    const errorInfo = JSON.parse(record.error_info || "{}");
    const update = errorInfo.body;
    if (!update) return false;

    await env.NYRA_QUEUE.send({ update });
    await env.DB.prepare("UPDATE failed_updates SET replayed_at = ? WHERE id = ?").bind(now(), id).run();
    return true;
  } catch (err) {
    console.error("Failed to replay update:", err.message);
    return false;
  }
}
