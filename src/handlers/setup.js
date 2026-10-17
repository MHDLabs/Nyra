// GET /setup?url= — manual webhook (re)registration, authenticated with the
// same derived secret Telegram uses. Refuses secrets in the query string.
// Kept because it is the escape hatch when automatic discovery is wrong.
import { RATE_LIMIT_SETUP_PER_MIN } from "../config.js";
import { jsonResponse, constantTimeEqual, checkMemoryRate } from "../utils.js";
import { getWebhookSecret } from "../crypto.js";
import { tg } from "../telegram.js";

export async function handleSetup(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/setup") return new Response("Not Found", { status: 404 });
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!checkMemoryRate("setup:" + clientIp, RATE_LIMIT_SETUP_PER_MIN, 60000)) return new Response("Too Many Requests", { status: 429 });
  if (url.searchParams.has("secret")) {
    // Secrets in the query string leak into logs/history/referrers — header only.
    console.error("Rejected /setup request: secret provided via query string. Use the X-Setup-Secret header.");
    return new Response("Unauthorized", { status: 401 });
  }
  const setupSecret = request.headers.get("X-Setup-Secret") || "";
  const expectedSecret = await getWebhookSecret(env);
  if (!expectedSecret || !constantTimeEqual(setupSecret, expectedSecret)) return new Response("Unauthorized", { status: 401 });
  const webhookUrl = url.searchParams.get("url");
  if (!webhookUrl) return new Response("Missing url parameter", { status: 400 });
  if (!webhookUrl.startsWith("https://")) return new Response("Webhook URL must use HTTPS", { status: 400 });
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.host !== url.host) return new Response("Webhook URL must match this worker's host", { status: 400 });
    if (parsed.pathname !== "/webhook") return new Response("Webhook URL path must be exactly /webhook", { status: 400 });
  } catch (err) { return new Response("Invalid webhook URL", { status: 400 }); }
  const result = await tg(env, "setWebhook", {
    url: webhookUrl,
    secret_token: expectedSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });
  return jsonResponse(result, result && result.ok ? 200 : 500);
}
