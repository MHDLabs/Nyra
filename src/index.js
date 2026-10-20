// Nyra — Worker entry point (composition root).
//
// The update-handling bodies live in `src/handlers/` (see
// `src/handlers/index.js`). This file keeps only what cannot move: the
// `export default` the Workers runtime looks for, the startup contract
// (secrets + schema) and the HTTP route table that dispatches into the handlers.
import { parseAdminIds } from "./utils.js";
import { getMasterKey, validateSecrets } from "./crypto.js";
import { ensureSchema, maybeInitSchema } from "./db.js";
import { ensureWebhook, ensureMenuButton } from "./telegram.js";
import { routeMiniAppAPI } from "./miniapp.js";
import { logFailedUpdate } from "./dlq.js";
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

async function alreadyHandled(env, updateId) {
  if (updateId === undefined || updateId === null) return false;
  if (!env.KV || typeof env.KV.get !== "function") return false;
  try { return !!(await env.KV.get("qdone:" + updateId)); } catch (e) { return false; }
}

async function markHandled(env, updateId) {
  if (updateId === undefined || updateId === null) return;
  if (!env.KV || typeof env.KV.put !== "function") return;
  try { await env.KV.put("qdone:" + updateId, "1", { expirationTtl: QUEUE_DONE_TTL }); } catch (e) {}
}

// One conversation's messages, in order. Failures never stop the chain: a
// retried update must not stall the messages queued behind it in the same chat.
async function processChain(env, ctx, messages) {
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
    }
  }
}

function safeAck(msg) { try { msg.ack(); } catch (e) { console.error("queue ack failed:", e.message); } }
function safeRetry(msg) { try { msg.retry(); } catch (e) { console.error("queue retry failed:", e.message); } }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // All three secrets are mandatory manual entries. A deployment without any
    // one of them crashes loudly on every request — no derivation, no fallback.
    const missing = validateSecrets(env);
    if (missing) {
      console.error("Server misconfigured — missing required secret(s): " + missing.join(", "));
      return new Response("Server misconfigured: missing " + missing.join(", "), { status: 500 });
    }
    if (!getMasterKey(env)) {
      console.error("ENCRYPTION_KEY is not a valid 32-byte base64 key.");
      return new Response("Server misconfigured: invalid ENCRYPTION_KEY", { status: 500 });
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

    // Public status / bootstrap page. The Mini App owns "/", so this is the
    // endpoint that initialises the schema, learns the public origin and
    // registers the Telegram webhook + Mini App menu button.
    if (request.method === "GET" && url.pathname === "/status") return await handleStatus(request, env, adminIds);

    // Every other Worker-handled request also teaches us the public origin, so
    // the webhook bootstraps even when only the Mini App (/api/*) is used and
    // /status is never opened. KV-gated inside ensureWebhook; never blocks.
    ctx.waitUntil(ensureWebhook(env, url.origin).catch(function () {}));

    // Mini App API endpoints
    if (url.pathname.startsWith("/api/")) {
      return await routeMiniAppAPI(env, ctx, request, url.pathname);
    }

    // Everything else (the Mini App: /, /index.html, /app.js, /styles.css) is
    // served by Cloudflare's native asset layer from ./public — see [assets] in
    // wrangler.toml. Reaching this point means no asset matched.
    return new Response("Not Found", { status: 404 });
  },
  // Cron: self-healing — schema probe (KV-gated) plus webhook and Mini App
  // menu-button re-verification of the learned URL (no-op until a request has
  // taught the Worker its public origin). Runs every
  // 5 minutes via [triggers] in wrangler.toml.
  async scheduled(event, env, ctx) {
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
    const menu = await ensureMenuButton(env, null);
    if (!menu.ok && menu.status !== "awaiting_first_request") {
      console.error("Menu button re-check failed [" + menu.status + "]:" + (menu.detail ? " " + menu.detail : ""));
    }
  },
  // Queue consumer: runs the full AI pipeline outside the webhook request lifecycle.
  // Consumer invocations allow long wall time (vs. the 30s post-response waitUntil cap),
  // so streaming, fallbacks, consolidation and heartbeats are no longer cut off at 30s.
  async queue(batch, env, ctx) {
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
    const groups = new Map();
    for (let i = 0; i < batch.messages.length; i++) {
      const msg = batch.messages[i];
      const key = conversationKey(msg.body && msg.body.update);
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }
    const chains = [];
    groups.forEach(function (list) { chains.push(processChain(env, ctx, list)); });
    await Promise.all(chains);
  }
};
