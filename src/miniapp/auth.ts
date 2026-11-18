// Mini App authentication. initData is an HMAC-SHA256 over the raw query
// string keyed by a secret derived from the bot token ("WebAppData") —
// verified exactly as Telegram specifies, including the 1-hour freshness
// bound. Nothing in the Mini App is reachable without passing this.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NyraEnv } from "../../types/env.js";
import { getUserStrict, upsertUser, isPersonalModelsAllowed, getPersonalModelLimit } from "../db.js";
import { isAdmin } from "../utils.js";

const INIT_DATA_MAX_AGE_MS = 3600000; // 1 hour

export type ValidatedInitData = {
  userId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  authDate: number;
};

/**
 * Validate Telegram Mini App initData
 * Based on: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: unknown, botToken: unknown): ValidatedInitData | null {
  if (!initData || !botToken) return null;
  if (typeof initData !== "string" || typeof botToken !== "string") return null;

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

    // Constant-time compare so the signature cannot be recovered byte-by-byte
    // from response timing.
    const enc = new TextEncoder();
    const a = enc.encode(computedHash);
    const b = enc.encode(String(hash));
    if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) return null;

    const authDate = params.get("auth_date");
    if (!authDate) return null;
    const authTimestamp = parseInt(authDate, 10) * 1000;
    if (!Number.isFinite(authTimestamp) || Date.now() - authTimestamp > INIT_DATA_MAX_AGE_MS) return null;

    const userParam = params.get("user");
    if (!userParam) return null;
    const user = JSON.parse(userParam) as Record<string, unknown>;
    if (typeof user.id !== "number" && typeof user.id !== "string") return null;
    const userId = Number(user.id);
    if (!Number.isFinite(userId)) return null;

    return {
      userId,
      username: typeof user.username === "string" ? user.username : null,
      firstName: typeof user.first_name === "string" ? user.first_name : null,
      lastName: typeof user.last_name === "string" ? user.last_name : null,
      languageCode: typeof user.language_code === "string" ? user.language_code : null,
      authDate: authTimestamp
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("initData validation error:", message);
    return null;
  }
}

/**
 * Extract and validate initData from request headers
 */
export function extractInitData(request: Request, env: NyraEnv): ValidatedInitData | null {
  const initData = request.headers.get("X-Init-Data");
  if (!initData) return null;
  return validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
}

/**
 * Handle Mini App authentication
 */
export async function handleAuth(env: NyraEnv, initData: unknown): Promise<Response> {
  const validated = validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!validated) {
    return new Response(JSON.stringify({ error: "Invalid initData" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  let user: Record<string, unknown> | null = null;
  try {
    await upsertUser(env, {
      id: validated.userId,
      first_name: validated.firstName,
      last_name: validated.lastName,
      username: validated.username,
      language_code: validated.languageCode
    });
    user = (await getUserStrict(env, validated.userId)) as Record<string, unknown> | null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handleAuth upsertUser failed:", message);
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const adminStatus = isAdmin(env, validated.userId);
  const personalAllowed = adminStatus || (await isPersonalModelsAllowed(env));
  const personalLimit = await getPersonalModelLimit(env);

  return new Response(
    JSON.stringify({
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
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}
