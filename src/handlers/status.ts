// GET /status — plain-text status and bootstrap endpoint for the Worker and Telegram webhook.
import type { NyraEnv } from "../../types/env.js";
import type { AdminIdResult } from "../utils/admin.js";
import { checkMemoryRate } from "../utils.js";
import { ensureWebhook, restoreDefaultMenuButton, tg } from "../telegram.js";
import { maybeInitSchema } from "../db.js";
import { getBuildInfo, checkUpstreamUpdate, UPSTREAM_REPO, UPSTREAM_BRANCH } from "../version.js";
import { getWebhookSecret } from "../crypto.js";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

export async function handleStatus(
  request: Request,
  env: NyraEnv,
  adminIds: AdminIdResult
): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!checkMemoryRate("status:" + clientIp, 30, 60000)) {
    return new Response("Too Many Requests", { status: 429 });
  }
  await maybeInitSchema(env);
  const origin = new URL(request.url).origin;
  const hook = await ensureWebhook(env, origin);
  await restoreDefaultMenuButton(env);
  const hookLine = hook.ok
    ? hook.status + " → " + hook.url
    : "problem: " + hook.status + (hook.detail ? " — " + hook.detail : "");
  const adminLine = adminIds.configured
    ? adminIds.valid.length +
      " configured" +
      (adminIds.invalid.length
        ? "; " +
          adminIds.invalid.length +
          " non-numeric entr" +
          (adminIds.invalid.length === 1 ? "y" : "ies") +
          " ignored"
        : "")
    : "NOT CONFIGURED — set ADMIN_IDS to your numeric Telegram user ID(s) in wrangler.toml [vars] and redeploy";

  const build = getBuildInfo(env);
  const buildLine = build.shortSha
    ? build.shortSha +
      (build.ref ? " (" + build.ref + ")" : "") +
      (build.builtAt ? " @ " + build.builtAt : "") +
      " [" +
      build.source +
      "]"
    : "unknown (deploy without CI build metadata)";

  let updateLine = "not checked";
  try {
    const upd = await checkUpstreamUpdate(env);
    if (!upd.ok) {
      updateLine = "check failed (" + (upd.error || "error") + ")";
    } else if (upd.updateAvailable === true) {
      updateLine =
        "UPDATE AVAILABLE — upstream " +
        UPSTREAM_REPO +
        "@" +
        UPSTREAM_BRANCH +
        " is " +
        (upd.upstream && upd.upstream.shortSha ? upd.upstream.shortSha : "?");
    } else if (upd.updateAvailable === false) {
      updateLine = "up to date with " + UPSTREAM_REPO + "@" + UPSTREAM_BRANCH;
    } else {
      updateLine =
        "upstream " +
        (upd.upstream && upd.upstream.shortSha ? upd.upstream.shortSha : "?") +
        " (local SHA unknown)";
    }
  } catch {
    updateLine = "check error";
  }

  // Live Telegram diagnostics (no secrets printed).
  let botLine = "unknown";
  let tgHookLine = "unknown";
  try {
    const me = await tg(env, "getMe", {});
    if (me && me.ok && me.result) {
      const result = me.result as { username?: string; id?: number | string; can_join_groups?: boolean };
      botLine =
        "@" +
        (result.username || "?") +
        " id=" +
        result.id +
        " can_join=" +
        !!result.can_join_groups;
    } else {
      botLine = "getMe failed: " + ((me && me.description) || "error");
    }
  } catch (err) {
    botLine = "getMe error: " + errorMessage(err);
  }
  try {
    const info = await tg(env, "getWebhookInfo", {});
    if (info && info.ok && info.result) {
      const r = info.result as {
        url?: string;
        pending_update_count?: number;
        last_error_message?: string;
        last_error_date?: number;
      };
      tgHookLine =
        (r.url || "(none)") +
        " pending=" +
        (r.pending_update_count ?? "?") +
        (r.last_error_message ? " last_error=" + r.last_error_message : " last_error=none") +
        (r.last_error_date ? " last_error_at=" + r.last_error_date : "");
    } else {
      tgHookLine = "getWebhookInfo failed: " + ((info && info.description) || "error");
    }
  } catch {
    tgHookLine = "getWebhookInfo error";
  }

  let secretsLine = "ok";
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!(await getWebhookSecret(env))) missing.push("TELEGRAM_SECRET");
  if (missing.length) secretsLine = "MISSING/INVALID: " + missing.join(", ");

  let centralAILine = env.AI_MODEL && env.AI_API_KEY ? String(env.AI_MODEL) + " (legacy env)" : "NOT CONFIGURED";
  let modelsLine = "not available";
  try {
    const modelResult = await env.DB.prepare(
      "SELECT id,label,provider,is_default,fallback_only,base_url,encrypted_api_key,key_iv FROM ai_models WHERE enabled=1"
    ).all();
    const models = (modelResult.results || []) as any[];
    const usable = models.filter((model) => String(model.provider) === "cloudflare"
      ? !!(env.AI && typeof env.AI.run === "function")
      : !!(model.encrypted_api_key && model.key_iv && model.base_url && !/[{}]|ACCOUNT_ID/i.test(String(model.base_url))));
    const selectable = usable.filter((model) => Number(model.fallback_only) !== 1);
    const fallback = usable.filter((model) => Number(model.fallback_only) === 1);
    const defaultModel = selectable.find((model) => Number(model.is_default) === 1);
    if (defaultModel) centralAILine = String(defaultModel.label);
    else if (usable.length === 0 && !(env.AI_MODEL && env.AI_API_KEY)) centralAILine = "NOT CONFIGURED";
    modelsLine = selectable.length + " selectable · " + fallback.length + " fallback configured";
  } catch {
    // The status route remains available if the first-time schema migration has not completed.
  }
  const modelEncryptionLine = String(env.NYRA_MODEL_ENCRYPTION_KEY || "").length >= 32
    ? "configured"
    : "MISSING — required for Groq/custom API keys; Workers AI binding does not need it";

  const body = [
    "Nyra is running.",
    "",
    "Secrets:     " + secretsLine,
    "Model keys:  " + modelEncryptionLine,
    "Central AI:  " + centralAILine,
    "Models:      " + modelsLine,
    "Webhook:     " + hookLine,
    "TG webhook:  " + tgHookLine,
    "Bot:         " + botLine,
    "Admin IDs:   " + adminLine,
    "Queue:       " + (env.NYRA_QUEUE ? "bound (NYRA_QUEUE)" : "MISSING — check the queues config in wrangler.toml"),
    "Build:       " + buildLine,
    "Updates:     " + updateLine,
    "",
    adminIds.configured
      ? "Send /start to the bot in Telegram."
      : "Admin commands are disabled until ADMIN_IDS is set."
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
