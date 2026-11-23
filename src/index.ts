import type { NyraEnv } from "../types/env.js";
// Nyra — Worker entry point (composition root).
//
// The update-handling bodies live in `src/handlers/` (see
// `src/handlers/index.js`). This file keeps only what cannot move: the
// `export default` the Workers runtime looks for, the startup contract
// (secrets + schema) and the HTTP route table that dispatches into the handlers.
import { parseAdminIds } from "./utils.js";
import { validateSecrets } from "./crypto.js";
import { ensureSchema, maybeInitSchema } from "./db.js";
import { ensureWebhook, restoreDefaultMenuButton, ensureBotCommands } from "./telegram.js";
import { routeAdminPanel } from "./admin-panel/router.js";
import { logFailedUpdate, cleanupOldFailedUpdates } from "./dlq.js";
import { handleWebhook, handleSetup, handleStatus, processMessage, handleCallbackQuery } from "./handlers/index.js";

// A queue message's ordering group. Two updates only need to stay serialized
// when they belong to the same conversation, so the chat id is the key and the
// user id is the fallback for callback queries that carry no chat.
function conversationKey(update) {
  if (!update) return "none";
  const msg = update.message || update.edited_message;
  if (msg && msg.chat && msg.chat.id !== undefined) return "c:" + msg.chat.id;
  const q = update.callback_query;
  if (q && q.message && q.message.chat && q.message.chat.id !== undefined) return "c:" + q.message.chat.id;
  if (q && q.from && q.from.id !== undefined) return "u:" + q.from.id;
  return "none";
}

// Marker written after a message is fully handled. Telegram redelivers a batch
// when an ack never lands, and re-running a handled update duplicates its
// outbound messages; the marker makes that redelivery a cheap no-op. KV is
// eventually consistent, so this is best-effort — the real dedup for new
// updates is the processed_updates row in the webhook.
const QUEUE_DONE_TTL = 3600;

async function alreadyHandled(env: NyraEnv, updateId) {
  if (updateId === undefined || updateId === null) return false;
  if (!env.KV || typeof env.KV.get !== "function") return false;
  try { return !!(await env.KV.get("qdone:" + updateId)); } catch (e) { return false; }
}

async function markHandled(env: NyraEnv, updateId) {
  if (updateId === undefined || updateId === null) return;
  if (!env.KV || typeof env.KV.put !== "function") return;
  try { await env.KV.put("qdone:" + updateId, "1", { expirationTtl: QUEUE_DONE_TTL }); } catch (e) {}
}

// One conversation's messages, in order. On failure, retry this message and
// re-queue the rest of the same-chat batch without processing them — otherwise
// msg2 can finish before a retried msg1 and the user sees answers out of order.
async function processChain(env: NyraEnv, ctx, messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const update = msg.body && msg.body.update;
    if (!update) { safeAck(msg); continue; }
    if (msg.attempts > 1 && (await alreadyHandled(env, update.update_id))) { safeAck(msg); continue; }
    try {
      if (update.message) await processMessage(env, ctx, update.message);
      else if (update.callback_query) await handleCallbackQuery(env, ctx, update.callback_query);
      await markHandled(env, update.update_id);
      safeAck(msg);
    } catch (err) {
      console.error("Queued update processing failed:", err.message);
      safeRetry(msg);
      for (let j = i + 1; j < messages.length; j++) safeRetry(messages[j]);
      return;
    }
  }
}

function safeAck(msg) { try { msg.ack(); } catch (e) { console.error("queue ack failed:", e.message); } }
function safeRetry(msg) { try { msg.retry(); } catch (e) { console.error("queue retry failed:", e.message); } }

export default {
  async fetch(request: Request, env: NyraEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Telegram webhook credentials are mandatory. AI credentials are checked when
    // a model request is attempted, so the Worker can still serve health/admin routes.
    const missing = validateSecrets(env);
    if (missing) {
      console.error("Server misconfigured — missing required secret(s): " + missing.join(", "));
      return new Response("Server misconfigured: missing " + missing.join(", "), { status: 500 });
    }
    // ADMIN_IDS is a required one-click-deploy input; enforce at runtime so a
    // missing/typo'd value is loud (status page + logs) instead of silent.
    const adminIds = parseAdminIds(env.ADMIN_IDS);
    if (!adminIds.configured) console.error("ADMIN_IDS is not set to numeric Telegram user ID(s) — admin commands are disabled.");
    else if (adminIds.invalid.length) console.error("ADMIN_IDS has non-numeric entries (ignored): " + adminIds.invalid.join(", "));
    // Webhook endpoint
    if (request.method === "POST" && url.pathname === "/webhook") return await handleWebhook(request, env, ctx);

    // Setup endpoint (admin only)
    if (request.method === "GET" && url.pathname === "/setup") return await handleSetup(request, env);

    // Public status / bootstrap endpoint. It initialises the schema and registers
    // the Telegram webhook; the web admin panel is routed separately below.
    if (request.method === "GET" && url.pathname === "/status") return await handleStatus(request, env, adminIds);

    // Standalone password-gated web admin panel.
    if (url.pathname === "/admin-panel" || url.pathname.startsWith("/admin-panel/") || url.pathname.startsWith("/admin-api/")) {
      return (await routeAdminPanel(env, ctx, request, url.pathname)) as Response;
    }

    // Any Worker-handled request can teach the public origin for webhook
    // bootstrapping, even when /status has not been opened. This is KV-gated.
    ctx.waitUntil(ensureWebhook(env, url.origin).catch(function () {}));

    // No public Mini App or general-purpose asset shell is exposed by the Worker.
    return new Response("Not Found", { status: 404 });
  },
  // Scheduled maintenance: schema probe, webhook verification, and queue hygiene.
  async scheduled(event: ScheduledEvent, env: NyraEnv, ctx: ExecutionContext): Promise<void> {
    const missing = validateSecrets(env);
    if (missing) {
      console.error("Scheduled run skipped — missing required secret(s): " + missing.join(", "));
      return;
    }
    await maybeInitSchema(env);
    const res = await ensureWebhook(env, null);
    if (!res.ok && res.status !== "awaiting_first_request") {
      console.error("Webhook re-check failed [" + res.status + "]:" + (res.detail ? " " + res.detail : ""));
    }
    await restoreDefaultMenuButton(env);
    ctx.waitUntil(ensureBotCommands(env));
    // Clean up old failed updates (30 day retention)
    ctx.waitUntil(cleanupOldFailedUpdates(env, 30));
  },
  // Queue consumer: runs the full AI pipeline outside the webhook request lifecycle.
  // Consumer invocations allow long wall time (vs. the 30s post-response waitUntil cap),
  // so streaming, bounded same-model tool retries, consolidation and heartbeats are no longer cut off at 30s.
  async queue(batch: MessageBatch, env: NyraEnv, ctx: ExecutionContext): Promise<void> {
    const missing = validateSecrets(env);
    if (missing) {
      console.error("Queue batch skipped — missing required secret(s): " + missing.join(", "));
      for (let i = 0; i < batch.messages.length; i++) {
        try { batch.messages[i].retry(); } catch (e) { console.error("queue retry failed:", e.message); }
      }
      return;
    }
    await ensureSchema(env);
    const queueName = batch.queue || "nyra-updates";
    // DLQ consumer: persist permanently failed updates so /admin → Failed
    // Updates can list and replay them. `logFailedUpdate` was called here
    // without ever being imported, so every DLQ message threw and was acked —
    // the failed-update log stayed permanently empty.
    if (queueName === "nyra-updates-dlq") {
      for (let i = 0; i < batch.messages.length; i++) {
        const msg = batch.messages[i];
        try {
          await logFailedUpdate(env, msg);
          msg.ack();
        } catch (err) {
          console.error("DLQ logging failed:", err.message);
          msg.ack(); // Ack anyway to prevent infinite loop
        }
      }
      return;
    }
    // Main queue consumer. Messages are grouped by conversation (chat, falling
    // back to user) and each group runs as its own sequential chain: two
    // updates in the same chat keep their order, while unrelated chats in the
    // same batch proceed in parallel. The previous strict `await` loop made one
    // slow AI turn block every other user in the batch.
    const groups = new Map<string, any[]>();
    for (let i = 0; i < batch.messages.length; i++) {
      const msg = batch.messages[i];
      const key = conversationKey(msg.body && (msg.body as any).update);
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }
    const chains: Promise<void>[] = [];
    groups.forEach(function (list) { chains.push(processChain(env, ctx, list)); });
    await Promise.all(chains);
  }
};
