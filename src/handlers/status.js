// GET /status — plain-text status and bootstrap endpoint. The Mini App owns
// "/", so this is the URL that initialises the schema, teaches the Worker
// its public origin, and registers the Telegram webhook + menu button.
import { checkMemoryRate } from "../utils.js";
import { ensureWebhook, ensureMenuButton } from "../telegram.js";
import { maybeInitSchema } from "../db.js";

// GET /status — plain-text status + bootstrap endpoint (the Mini App owns "/").
// Idempotent: initialises the schema (KV-gated), registers/verifies the Telegram
// webhook from the request's own origin, and points the bot's menu button at the
// Mini App, so a fresh one-click deployment becomes functional the first time
// this (or any other Worker-handled) URL is opened.
export async function handleStatus(request, env, adminIds) {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!checkMemoryRate("status:" + clientIp, 30, 60000)) return new Response("Too Many Requests", { status: 429 });
  await maybeInitSchema(env);
  const origin = new URL(request.url).origin;
  const hook = await ensureWebhook(env, origin);
  const menu = await ensureMenuButton(env, origin);
  const hookLine = hook.ok
    ? hook.status + " → " + hook.url
    : "problem: " + hook.status + (hook.detail ? " — " + hook.detail : "");
  const menuLine = menu.ok ? (menu.status === "registered" ? "registered → " + origin : menu.status) : "problem: " + menu.status;
  const adminLine = adminIds.configured
    ? adminIds.valid.length + " configured" + (adminIds.invalid.length ? "; " + adminIds.invalid.length + " non-numeric entr" + (adminIds.invalid.length === 1 ? "y" : "ies") + " ignored" : "")
    : "NOT CONFIGURED — set ADMIN_IDS to your numeric Telegram user ID(s) in wrangler.toml [vars] and redeploy";
  const body = [
    "Nyra is running.",
    "",
    "Webhook:     " + hookLine,
    "Menu button: " + menuLine,
    "Admin IDs:   " + adminLine,
    "Queue:       " + (env.NYRA_QUEUE ? "bound (NYRA_QUEUE)" : "MISSING — check the queues config in wrangler.toml"),
    "Mini App:    " + origin + "/ (served from the ASSETS binding)",
    "",
    adminIds.configured ? "Send /start to the bot in Telegram." : "Admin commands are disabled until ADMIN_IDS is set."
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
