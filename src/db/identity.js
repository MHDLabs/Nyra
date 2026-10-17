// Bot identity (numeric id + @username): in-isolate cache backed by KV.
import { BOT_IDENTITY_NEGATIVE_TTL, BOT_IDENTITY_TTL } from "../config.js";
import { tg } from "../telegram.js";

let botIdentityCache = { id: null, username: null, expiresAt: 0 };

export async function getBotIdentity(env) {
  if (botIdentityCache.expiresAt > Date.now()) return botIdentityCache;
  if (env.TELEGRAM_BOT_ID && env.TELEGRAM_BOT_USERNAME) {
    const parsedId = parseInt(env.TELEGRAM_BOT_ID, 10);
    if (!isNaN(parsedId) && parsedId > 0) {
      botIdentityCache = { id: parsedId, username: env.TELEGRAM_BOT_USERNAME, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      try { await env.KV.put("bot:identity", JSON.stringify({ id: parsedId, username: env.TELEGRAM_BOT_USERNAME }), { expirationTtl: 86400 }); } catch (err) {}
      return botIdentityCache;
    }
  }
  try {
    const cached = await env.KV.get("bot:identity", "json");
    if (cached && typeof cached.id === "number" && cached.id > 0) {
      botIdentityCache = { id: cached.id, username: cached.username || null, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      return botIdentityCache;
    }
  } catch (err) {}
  try {
    const me = await tg(env, "getMe", {});
    if (me && me.ok && me.result && typeof me.result.id === "number") {
      botIdentityCache = { id: me.result.id, username: me.result.username || null, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      try { await env.KV.put("bot:identity", JSON.stringify({ id: me.result.id, username: me.result.username || null }), { expirationTtl: 86400 }); } catch (err) {}
      return botIdentityCache;
    }
  } catch (err) {}
  botIdentityCache = { id: null, username: null, expiresAt: Date.now() + BOT_IDENTITY_NEGATIVE_TTL };
  return botIdentityCache;
}
