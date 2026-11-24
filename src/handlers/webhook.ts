// POST /webhook. This is the durability boundary: the update is
// deduplicated by update_id and enqueued *before* the 200, so a Telegram
// retry never double-processes and a failed enqueue releases the dedup slot.
import type { NyraEnv } from "../../types/env.js";
import type { CallbackQuery, TelegramMessage, TelegramUpdate } from "../../types/telegram.js";
import { okResponse, constantTimeEqual } from "../utils.js";
import { getWebhookSecret } from "../crypto.js";
import { ensureSchema } from "../db.js";
import { processMessage } from "./message.js";
import { handleCallbackQuery } from "./callback.js";
import { enqueueTelegramPhotoAlbum, isTelegramPhotoAlbumMessage } from "../media-groups.js";

type WorkerCtx = { waitUntil?(promise: Promise<unknown>): void };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function errorStack(err: unknown): string {
  if (err instanceof Error && err.stack) return err.stack;
  return errorMessage(err);
}

async function safeProcessMessage(env: NyraEnv, ctx: WorkerCtx, message: TelegramMessage): Promise<void> {
  try {
    await processMessage(env, ctx, message);
  } catch (err) {
    console.error("processMessage failed:", errorStack(err));
    try {
      const chatId = message && message.chat && message.chat.id;
      if (chatId != null) {
        const { sendMessage } = await import("../telegram.js");
        await sendMessage(env, chatId, "Sorry — something went wrong handling that message. Please try again.", {});
      }
    } catch (e2) {
      console.error("processMessage failure notify failed:", errorMessage(e2));
    }
  }
}

async function safeCallback(env: NyraEnv, ctx: WorkerCtx, cb: CallbackQuery): Promise<void> {
  try {
    await handleCallbackQuery(env, ctx, cb);
  } catch (err) {
    console.error("handleCallbackQuery failed:", errorStack(err));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isTelegramUser(value: unknown): value is { id: number | string; is_bot?: boolean } {
  if (!isRecord(value)) return false;
  const id = value.id;
  return typeof id === "number" || typeof id === "string";
}

function isTelegramChat(value: unknown): value is { id: number | string; type?: string } {
  if (!isRecord(value)) return false;
  const id = value.id;
  return typeof id === "number" || typeof id === "string";
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!isRecord(value)) return false;
  if (typeof value.message_id !== "number") return false;
  if (!isTelegramChat(value.chat)) return false;
  if (value.from !== undefined && !isTelegramUser(value.from)) return false;
  return true;
}

function isCallbackQuery(value: unknown): value is CallbackQuery {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" && typeof value.id !== "number") return false;
  if (!isTelegramUser(value.from)) return false;
  if (value.message !== undefined && !isTelegramMessage(value.message)) return false;
  return true;
}

/**
 * Accept a Telegram update envelope. Requires a finite update_id.
 * Message / callback payloads used on the fast path are structurally checked;
 * other update kinds remain allowed so Telegram can deliver them to the queue.
 */
function asTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value)) return null;
  if (typeof value.update_id !== "number" || !Number.isFinite(value.update_id)) return null;
  if (value.message !== undefined && !isTelegramMessage(value.message)) return null;
  if (value.callback_query !== undefined && !isCallbackQuery(value.callback_query)) return null;
  if (value.edited_message !== undefined && !isTelegramMessage(value.edited_message)) return null;
  return value as TelegramUpdate;
}


function queueConversationKey(update: TelegramUpdate): string {
  const message = update.message || update.edited_message;
  if (message && message.chat && message.chat.id !== undefined) return "c:" + message.chat.id;
  const query = update.callback_query;
  if (query && query.message && query.message.chat && query.message.chat.id !== undefined) return "c:" + query.message.chat.id;
  if (query && query.from && query.from.id !== undefined) return "u:" + query.from.id;
  return "u:" + String(update.update_id);
}

export async function handleWebhook(request: Request, env: NyraEnv, ctx: WorkerCtx): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  const expectedSecret = await getWebhookSecret(env);
  if (!expectedSecret || !constantTimeEqual(secret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let updateRaw: unknown;
  try {
    updateRaw = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const update = asTelegramUpdate(updateRaw);
  if (!update) return new Response("Bad Request", { status: 400 });

  try {
    await ensureSchema(env);
  } catch (err) {
    console.error("ensureSchema failed:", errorMessage(err));
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!env.NYRA_QUEUE) {
    console.error("NYRA_QUEUE binding is missing. Deploy with the queue configuration from wrangler.toml.");
    return new Response("Service Unavailable", { status: 503 });
  }
  // Durable acceptance: deduplicate by update_id, then enqueue before acking.
  // Telegram retries on non-2xx, so an enqueue failure must free the dedup slot.
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  if (updateId !== null) {
    let firstDelivery = true;
    try {
      const inserted = await env.DB.prepare(
        "INSERT INTO processed_updates (update_id, received_at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING RETURNING update_id"
      )
        .bind(updateId, Math.floor(Date.now() / 1000))
        .first();
      firstDelivery = inserted != null;
    } catch (err) {
      console.error("update dedup insert failed:", errorMessage(err));
      return new Response("Service Unavailable", { status: 503 });
    }
    if (!firstDelivery) return okResponse();
  }
  // Commands and button taps run inline; every AI message is sent through
  // the durable queue so processing order and retry semantics stay consistent.
  const msgUpdate = update.message;
  const cbUpdate = update.callback_query;
  if (cbUpdate && cbUpdate.from && !cbUpdate.from.is_bot) {
    await safeCallback(env, ctx, cbUpdate);
    return okResponse();
  }
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat) {
    const isCommand = typeof msgUpdate.text === "string" && msgUpdate.text.trim().startsWith("/");
    if (isCommand) {
      await safeProcessMessage(env, ctx, msgUpdate);
      return okResponse();
    }
  }
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && isTelegramPhotoAlbumMessage(msgUpdate)) {
    try {
      await enqueueTelegramPhotoAlbum(env, msgUpdate);
    } catch (err) {
      console.error("photo-album enqueue failed:", errorMessage(err));
      if (updateId !== null) {
        try {
          await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run();
        } catch (e) {
          console.error("dedup rollback failed:", errorMessage(e));
        }
      }
      return new Response("Service Unavailable", { status: 503 });
    }
    return okResponse();
  }
  const conversation = queueConversationKey(update);
  try {
    if (updateId === null) throw new Error("A durable queue update requires update_id.");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO queue_pending_updates (update_id, conversation_key, status, received_at) VALUES (?, ?, 0, ?)"
    ).bind(updateId, conversation, Math.floor(Date.now() / 1000)).run();
  } catch (err) {
    console.error("queue ordering record failed:", errorMessage(err));
    if (updateId !== null) {
      try { await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run(); } catch {}
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  try {
    await env.NYRA_QUEUE.send({ update: update });
  } catch (err) {
    console.error("update enqueue failed:", errorMessage(err));
    if (updateId !== null) {
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM queue_pending_updates WHERE update_id = ?").bind(updateId),
          env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId)
        ]);
      } catch (e) {
        console.error("queue/dedup rollback failed:", errorMessage(e));
      }
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  return okResponse();
}
