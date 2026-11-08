// GET /status — plain-text status and bootstrap endpoint. The Mini App owns
// "/", so this is the URL that initialises the schema, teaches the Worker
// its public origin, and registers the Telegram webhook + menu button.
import { checkMemoryRate } from "../utils.js";
import { ensureWebhook, ensureMenuButton } from "../telegram.js";
import { maybeInitSchema } from "../db.js";
import { getBuildInfo, checkUpstreamUpdate, UPSTREAM_REPO, UPSTREAM_BRANCH } from "../version.js";

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

  const build = getBuildInfo(env);
  const buildLine = build.shortSha
    ? build.shortSha + (build.ref ? " (" + build.ref + ")" : "") + (build.builtAt ? " @ " + build.builtAt : "") + " [" + build.source + "]"
    : "unknown (deploy without CI build metadata)";

  // Soft upstream check — never blocks status. ?update=1 forces a check;
  // otherwise we still check so admins see drift after OTA deploys.
  let updateLine = "not checked";
  try {
    const upd = await checkUpstreamUpdate(env);
    if (!upd.ok) {
      updateLine = "check failed (" + (upd.error || "error") + ")";
    } else if (upd.updateAvailable === true) {
      updateLine = "UPDATE AVAILABLE — upstream " + UPSTREAM_REPO + "@" + UPSTREAM_BRANCH +
        " is " + (upd.upstream.shortSha || "?") +
        (upd.upstream.message ? ' "' + upd.upstream.message + '"' : "") +
        " — push/merge to main with deploy secrets, or re-run the Deploy workflow";
    } else if (upd.updateAvailable === false) {
      updateLine = "up to date with " + UPSTREAM_REPO + "@" + UPSTREAM_BRANCH;
    } else {
      updateLine = "upstream " + (upd.upstream && upd.upstream.shortSha ? upd.upstream.shortSha : "?") + " (local SHA unknown)";
    }
  } catch (err) {
    updateLine = "check error";
  }

  const body = [
    "Nyra is running.",
    "",
    "Webhook:     " + hookLine,
    "Menu button: " + menuLine,
    "Admin IDs:   " + adminLine,
    "Queue:       " + (env.NYRA_QUEUE ? "bound (NYRA_QUEUE)" : "MISSING — check the queues config in wrangler.toml"),
    "Mini App:    " + origin + "/ (served from the ASSETS binding)",
    "Build:       " + buildLine,
    "Updates:     " + updateLine,
    "",
    adminIds.configured ? "Send /start to the bot in Telegram." : "Admin commands are disabled until ADMIN_IDS is set."
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
