// POST /webhook. This is the durability boundary: the update is
// deduplicated by update_id and enqueued *before* the 200, so a Telegram
// retry never double-processes and a failed enqueue releases the dedup slot.
import type { NyraEnv } from "../../types/env.js";
import type { CallbackQuery, TelegramMessage, TelegramUpdate } from "../../types/telegram.js";
import { okResponse, constantTimeEqual } from "../utils.js";
import { getWebhookSecret } from "../crypto.js";
import { ensureSchema } from "../db.js";
import { handleCallbackQuery } from "./callback.js";
import { processMessage } from "./message.js";
import { enqueueTelegramPhotoAlbum, isTelegramPhotoAlbumMessage } from "../media-groups.js";
import { tg } from "../telegram.js";
import { setProcessingReaction } from "../reactions.js";

type WorkerCtx = { waitUntil?(promise: Promise<unknown>): void };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function errorStack(err: unknown): string {
  if (err instanceof Error && err.stack) return err.stack;
  return errorMessage(err);
}

async function safeProcessMessage(env: NyraEnv, ctx: WorkerCtx, message: TelegramMessage): Promise<boolean> {
  try {
    await processMessage(env, ctx, message);
    return true;
  } catch (err) {
    console.error("Sensitive admin command failed:", errorStack(err));
    try {
      if (message && message.chat && message.chat.id != null) {
        const { sendMessage } = await import("../telegram.js");
        await sendMessage(env, message.chat.id, "Sorry — the admin command could not be completed. Please check the settings and try again.", {});
      }
    } catch (notifyError) {
      console.error("Sensitive admin command failure notice failed:", errorMessage(notifyError));
    }
    return false;
  }
}


const INLINE_DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
async function wasInlineUpdateHandled(env: NyraEnv, updateId: number): Promise<boolean> {
  try { return !!(await env.KV.get("qdone:" + updateId)); } catch { return false; }
}
async function markInlineUpdateHandled(env: NyraEnv, updateId: number): Promise<void> {
  try { await env.KV.put("qdone:" + updateId, "1", { expirationTtl: INLINE_DONE_TTL_SECONDS }); }
  catch (error) { console.warn("Inline update completion marker failed:", errorMessage(error)); }
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
  const msgUpdate = update.message || update.edited_message;
  const cbUpdate = update.callback_query;
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
    if (!firstDelivery) {
      // Recover the narrow crash window where processed_updates was written but
      // the Worker stopped before it accepted the update into its durable path.
      if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat
        && /^\\/modelkey(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i.test(String(msgUpdate.text || msgUpdate.caption || "").trim())) {
        if (await wasInlineUpdateHandled(env, updateId)) return okResponse();
        const handled = await safeProcessMessage(env, ctx, msgUpdate);
        if (!handled) return new Response("Service Unavailable", { status: 503 });
        await markInlineUpdateHandled(env, updateId);
        return okResponse();
      }

      if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && isTelegramPhotoAlbumMessage(msgUpdate)) {
        try {
          await enqueueTelegramPhotoAlbum(env, msgUpdate);
          return okResponse();
        } catch (error) {
          console.error("Duplicate photo-album recovery failed:", errorMessage(error));
          return new Response("Service Unavailable", { status: 503 });
        }
      }

      if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat) {
        try {
          let pending = await env.DB.prepare("SELECT status FROM queue_pending_updates WHERE update_id=?")
            .bind(updateId).first();
          if (pending && Number(pending.status) !== 0) return okResponse();
          if (!pending) {
            if (await wasInlineUpdateHandled(env, updateId)) return okResponse();
            await env.DB.prepare(
              "INSERT OR IGNORE INTO queue_pending_updates (update_id, conversation_key, status, received_at) VALUES (?, ?, 0, ?)"
            ).bind(updateId, queueConversationKey(update), Math.floor(Date.now() / 1000)).run();
            pending = await env.DB.prepare("SELECT status FROM queue_pending_updates WHERE update_id=?")
              .bind(updateId).first();
            if (pending && Number(pending.status) !== 0) return okResponse();
          }
          await env.NYRA_QUEUE.send({ update });
          if (msgUpdate.chat.type === "private" && typeof ctx.waitUntil === "function"
            && !(typeof msgUpdate.text === "string" && msgUpdate.text.trim().startsWith("/"))) {
            ctx.waitUntil(tg(env, "sendChatAction", { chat_id: msgUpdate.chat.id, action: "typing" })
              .catch((error) => console.warn("Recovered update typing indicator failed:", errorMessage(error))));
            ctx.waitUntil(setProcessingReaction(env, msgUpdate.chat.id, msgUpdate.message_id));
          }
        } catch (error) {
          console.error("Duplicate queue recovery failed:", errorMessage(error));
          return new Response("Service Unavailable", { status: 503 });
        }
      }
      return okResponse();
    }
  }
  // Callback taps remain inline for fast Telegram acknowledgement. All user
  // messages, including slash commands, go through the durable queue so a
  // command cannot overtake an earlier AI turn in the same chat.
  if (cbUpdate && cbUpdate.from && !cbUpdate.from.is_bot) {
    await safeCallback(env, ctx, cbUpdate);
    return okResponse();
  }
  // API-key commands contain plaintext credentials and must never be stored in the queue payload.
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat
    && /^\/modelkey(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(String(msgUpdate.text || msgUpdate.caption || "").trim())) {
    const handled = await safeProcessMessage(env, ctx, msgUpdate);
    if (!handled) return new Response("Service Unavailable", { status: 503 });
    if (updateId !== null) await markInlineUpdateHandled(env, updateId);
    return okResponse();
  }
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && isTelegramPhotoAlbumMessage(msgUpdate)) {
    try {
      await enqueueTelegramPhotoAlbum(env, msgUpdate);
      if (typeof ctx.waitUntil === "function" && msgUpdate.chat) {
        ctx.waitUntil(tg(env, "sendChatAction", { chat_id: msgUpdate.chat.id, action: "typing" })
          .then((result) => {
            if (!result || !result.ok) console.warn("Initial album typing indicator failed:", result && result.description || "Telegram API error");
          })
          .catch((error) => console.warn("Initial album typing indicator failed:", errorMessage(error))));
      }
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
    // Kick off the visible typing indicator as soon as the durable queue accepts
    // the update; the consumer continues it with its heartbeat.
    if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat
      && msgUpdate.chat.type === "private"
      && !(typeof msgUpdate.text === "string" && msgUpdate.text.trim().startsWith("/"))
      && typeof ctx.waitUntil === "function") {
      // Private chats get an immediate indicator on queue acceptance. Group
      // typing starts only after the message actually addresses Nyra.
      ctx.waitUntil(tg(env, "sendChatAction", { chat_id: msgUpdate.chat.id, action: "typing" })
        .then((result) => {
          if (!result || !result.ok) console.warn("Initial typing indicator failed:", result && result.description || "Telegram API error");
        })
        .catch((error) => console.warn("Initial typing indicator failed:", errorMessage(error))));
      ctx.waitUntil(setProcessingReaction(env, msgUpdate.chat.id, msgUpdate.message_id));
    }
  } catch (err) {
    console.error("update enqueue failed:", errorMessage(err));
    if (updateId !== null) {
      try {
        await env.DB.prepare("DELETE FROM queue_pending_updates WHERE update_id = ?").bind(updateId).run();
        await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run();
      } catch (e) {
        console.error("queue/dedup rollback failed:", errorMessage(e));
      }
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  return okResponse();
}
