// POST /webhook. This is the durability boundary: the update is
// deduplicated by update_id and enqueued *before* the 200, so a Telegram
// retry never double-processes and a failed enqueue releases the dedup slot.
import type { NyraEnv } from "../../types/env.js";
import type { CallbackQuery, TelegramMessage, TelegramUpdate } from "../../types/telegram.js";
import { okResponse, constantTimeEqual } from "../utils.js";
import { getMasterKey, getWebhookSecret } from "../crypto.js";
import { ensureSchema } from "../db.js";
import { processMessage } from "./message.js";
import { handleCallbackQuery } from "./callback.js";
import { isFastMessage } from "./fast-path.js";

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

export async function handleWebhook(request: Request, env: NyraEnv, ctx: WorkerCtx): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  const expectedSecret = await getWebhookSecret(env);
  if (!expectedSecret || !constantTimeEqual(secret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const masterKey = getMasterKey(env);
  if (!masterKey) {
    console.error("ENCRYPTION_KEY missing or invalid. Refusing to process requests.");
    return new Response("Service Unavailable", { status: 503 });
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
  // Fast path: a message whose resolved model is marked fast is processed inline
  // (no queue wait). Command messages and button taps are cheap (no AI call) so
  // they are always handled inline too — this is what makes commands and menus
  // feel instant instead of waiting for the queue consumer's batch window.
  const msgUpdate = update.message;
  const cbUpdate = update.callback_query;
  // Commands and button taps run inline (await) so Telegram delivery is reliable.
  // waitUntil alone can drop work on isolate recycle; users then see "no response".
  if (cbUpdate && cbUpdate.from && !cbUpdate.from.is_bot) {
    await safeCallback(env, ctx, cbUpdate);
    return okResponse();
  }
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat) {
    const ctype = msgUpdate.chat.type;
    if (ctype === "private" || ctype === "group" || ctype === "supergroup") {
      const isCommand = typeof msgUpdate.text === "string" && msgUpdate.text.trim().startsWith("/");
      if (isCommand) {
        await safeProcessMessage(env, ctx, msgUpdate);
        return okResponse();
      }
      try {
        if (await isFastMessage(env, msgUpdate.from)) {
          // Best-effort per-user lock so two concurrent webhook AI turns for the
          // same chat are not both processed inline out of order.
          const lockKey = "fastlock:" + msgUpdate.from.id;
          let locked = false;
          if (env.KV) {
            const held = await env.KV.get(lockKey);
            if (!held) {
              await env.KV.put(lockKey, "1", { expirationTtl: 90 });
              locked = true;
            }
          }
          if (locked || !env.KV) {
            try {
              await safeProcessMessage(env, ctx, msgUpdate);
              return okResponse();
            } finally {
              if (locked && env.KV) {
                try {
                  await env.KV.delete(lockKey);
                } catch {
                  /* ignore */
                }
              }
            }
          }
          // Lock held: fall through to queue so order is preserved by processChain.
        }
      } catch (err) {
        console.error("fast path failed, using queue:", errorMessage(err));
      }
    }
  }
  try {
    await env.NYRA_QUEUE.send({ update: update });
  } catch (err) {
    console.error("update enqueue failed:", errorMessage(err));
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
