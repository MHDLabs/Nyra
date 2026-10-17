// Mini App authentication. initData is an HMAC-SHA256 over the raw query
// string keyed by a secret derived from the bot token ("WebAppData") —
// verified exactly as Telegram specifies, including the 1-hour freshness
// bound. Nothing in the Mini App is reachable without passing this.
import { createHmac } from "node:crypto";
import { getUser, isPersonalModelsAllowed, getPersonalModelLimit } from "../db.js";
import { now, isAdmin } from "../utils.js";

const INIT_DATA_MAX_AGE_MS = 3600000; // 1 hour

/**
 * Validate Telegram Mini App initData
 * Based on: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");
    const dataCheckString = Array.from(params.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) return null;

    const authDate = params.get("auth_date");
    if (!authDate) return null;
    const authTimestamp = parseInt(authDate, 10) * 1000;
    if (Date.now() - authTimestamp > INIT_DATA_MAX_AGE_MS) return null;

    const userParam = params.get("user");
    if (!userParam) return null;
    const user = JSON.parse(userParam);

    return {
      userId: user.id,
      username: user.username || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      languageCode: user.language_code || null,
      authDate: authTimestamp
    };
  } catch (err) {
    console.error("initData validation error:", err.message);
    return null;
  }
}

/**
 * Extract and validate initData from request headers
 */
export function extractInitData(request, env) {
  const initData = request.headers.get("X-Init-Data");
  if (!initData) return null;
  return validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
}

/**
 * Handle Mini App authentication
 */
export async function handleAuth(env, initData) {
  const validated = validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!validated) {
    return new Response(JSON.stringify({ error: "Invalid initData" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const user = await getUser(env, validated.userId);
  const adminStatus = isAdmin(env, validated.userId);
  const personalAllowed = adminStatus || await isPersonalModelsAllowed(env);
  const personalLimit = await getPersonalModelLimit(env);

  return new Response(JSON.stringify({
    user: {
      telegram_id: validated.userId,
      first_name: validated.firstName,
      username: validated.username,
      memory_mode: user?.memory_mode || "normal",
      personality_id: user?.personality_id || "default",
      active_connection_id: user?.active_connection_id || null,
      active_route_id: user?.active_route_id || null,
      coding_mode: user?.coding_mode || 0
    },
    isAdmin: adminStatus,
    personal_models_allowed: personalAllowed,
    personal_model_limit: personalLimit
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
