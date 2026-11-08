// GET /status — plain-text status and bootstrap endpoint. The Mini App owns
// "/", so this is the URL that initialises the schema, teaches the Worker
// its public origin, and registers the Telegram webhook + menu button.
import { checkMemoryRate } from "../utils.js";
import { ensureWebhook, ensureMenuButton, tg } from "../telegram.js";
import { maybeInitSchema } from "../db.js";
import { getBuildInfo, checkUpstreamUpdate, UPSTREAM_REPO, UPSTREAM_BRANCH } from "../version.js";
import { MINIAPP_DISABLED } from "../config.js";
import { getMasterKey, getWebhookSecret } from "../crypto.js";

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

  const build = getBuildInfo(env);
  const buildLine = build.shortSha
    ? build.shortSha + (build.ref ? " (" + build.ref + ")" : "") + (build.builtAt ? " @ " + build.builtAt : "") + " [" + build.source + "]"
    : "unknown (deploy without CI build metadata)";

  let updateLine = "not checked";
  try {
    const upd = await checkUpstreamUpdate(env);
    if (!upd.ok) {
      updateLine = "check failed (" + (upd.error || "error") + ")";
    } else if (upd.updateAvailable === true) {
      updateLine = "UPDATE AVAILABLE — upstream " + UPSTREAM_REPO + "@" + UPSTREAM_BRANCH +
        " is " + (upd.upstream.shortSha || "?");
    } else if (upd.updateAvailable === false) {
      updateLine = "up to date with " + UPSTREAM_REPO + "@" + UPSTREAM_BRANCH;
    } else {
      updateLine = "upstream " + (upd.upstream && upd.upstream.shortSha ? upd.upstream.shortSha : "?") + " (local SHA unknown)";
    }
  } catch (err) {
    updateLine = "check error";
  }

  // Live Telegram diagnostics (no secrets printed).
  let botLine = "unknown";
  let tgHookLine = "unknown";
  try {
    const me = await tg(env, "getMe", {});
    if (me && me.ok && me.result) {
      botLine = "@" + (me.result.username || "?") + " id=" + me.result.id + " can_join=" + !!me.result.can_join_groups;
    } else {
      botLine = "getMe failed: " + ((me && me.description) || "error");
    }
  } catch (err) {
    botLine = "getMe error: " + (err && err.message ? err.message : "error");
  }
  try {
    const info = await tg(env, "getWebhookInfo", {});
    if (info && info.ok && info.result) {
      const r = info.result;
      tgHookLine = (r.url || "(none)") +
        " pending=" + (r.pending_update_count ?? "?") +
        (r.last_error_message ? " last_error=" + r.last_error_message : " last_error=none") +
        (r.last_error_date ? " last_error_at=" + r.last_error_date : "");
    } else {
      tgHookLine = "getWebhookInfo failed: " + ((info && info.description) || "error");
    }
  } catch (err) {
    tgHookLine = "getWebhookInfo error";
  }

  let secretsLine = "ok";
  const missing = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!(await getWebhookSecret(env))) missing.push("TELEGRAM_SECRET");
  if (!getMasterKey(env)) missing.push("ENCRYPTION_KEY(invalid_or_missing)");
  if (missing.length) secretsLine = "MISSING/INVALID: " + missing.join(", ");

  const body = [
    "Nyra is running.",
    "",
    "Secrets:     " + secretsLine,
    "Webhook:     " + hookLine,
    "TG webhook:  " + tgHookLine,
    "Bot:         " + botLine,
    "Menu button: " + menuLine,
    "Admin IDs:   " + adminLine,
    "Queue:       " + (env.NYRA_QUEUE ? "bound (NYRA_QUEUE)" : "MISSING — check the queues config in wrangler.toml"),
    "Mini App:    " + (MINIAPP_DISABLED ? "DISABLED (maintenance) — use chat commands" : origin + "/ (served from the ASSETS binding)"),
    "Build:       " + buildLine,
    "Updates:     " + updateLine,
    "",
    adminIds.configured ? "Send /start to the bot in Telegram." : "Admin commands are disabled until ADMIN_IDS is set."
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
