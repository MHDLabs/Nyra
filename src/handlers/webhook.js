// POST /webhook. This is the durability boundary: the update is
// deduplicated by update_id and enqueued *before* the 200, so a Telegram
// retry never double-processes and a failed enqueue releases the dedup slot.
import { now, okResponse, constantTimeEqual } from "../utils.js";
import { getMasterKey, getWebhookSecret } from "../crypto.js";
import { ensureSchema } from "../db.js";
import { processMessage } from "./message.js";
import { handleCallbackQuery } from "./callback.js";
import { isFastMessage } from "./fast-path.js";

export async function handleWebhook(request, env, ctx) {
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
  let update;
  try { update = await request.json(); } catch (err) { return new Response("Bad Request", { status: 400 }); }
  try { await ensureSchema(env); } catch (err) {
    console.error("ensureSchema failed:", err.message);
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
      ).bind(updateId, Math.floor(Date.now() / 1000)).first();
      firstDelivery = inserted != null;
    } catch (err) {
      console.error("update dedup insert failed:", err.message);
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
  if (cbUpdate && cbUpdate.from && !cbUpdate.from.is_bot) {
    ctx.waitUntil(handleCallbackQuery(env, ctx, cbUpdate));
    return okResponse();
  }
  if (msgUpdate && msgUpdate.from && !msgUpdate.from.is_bot && msgUpdate.chat) {
    const ctype = msgUpdate.chat.type;
    if (ctype === "private" || ctype === "group" || ctype === "supergroup") {
      const isCommand = typeof msgUpdate.text === "string" && msgUpdate.text.trim().startsWith("/");
      if (isCommand) {
        ctx.waitUntil(processMessage(env, ctx, msgUpdate));
        return okResponse();
      }
      try {
        if (await isFastMessage(env, msgUpdate.from)) {
          ctx.waitUntil(processMessage(env, ctx, msgUpdate));
          return okResponse();
        }
      } catch (err) {
        console.error("fast path failed, using queue:", err.message);
      }
    }
  }
  try {
    await env.NYRA_QUEUE.send({ update: update });
  } catch (err) {
    console.error("update enqueue failed:", err.message);
    if (updateId !== null) {
      try { await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run(); }
      catch (e) { console.error("dedup rollback failed:", e.message); }
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  return okResponse();
}
