import type { NyraEnv } from "../../types/env.js";
import { now } from "../utils.js";
import { NYRA_VARIANTS } from "../config.js";

// Small key/value settings used by group behavior and operational controls.
export async function getSetting(env: NyraEnv, key, fallback) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(env: NyraEnv, key, value, updatedBy) {
  try {
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    ).bind(key, String(value), now(), updatedBy || null).run();
    return true;
  } catch (error) {
    console.error("setSetting failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

function parseWordList(raw) {
  const value = String(raw || "").trim();
  if (!value) return NYRA_VARIANTS.slice();
  const parts = value.split(/[,\n]+/).map(word => word.trim()).filter(Boolean);
  return parts.length ? parts : NYRA_VARIANTS.slice();
}

/** Global group-trigger policy (admin-configurable). */
export async function getTriggerConfig(env: NyraEnv) {
  const enabled = (await getSetting(env, "trigger_enabled", "1")) !== "0";
  const reply = (await getSetting(env, "trigger_reply", "1")) !== "0";
  const mention = (await getSetting(env, "trigger_mention", "1")) !== "0";
  const words = parseWordList(await getSetting(env, "trigger_words", NYRA_VARIANTS.join(",")));
  const guestMode = (await getSetting(env, "guest_mode", "0")) === "1"
    || (await getSetting(env, "guest_mode", "0")) === "true";
  return { enabled, reply, mention, words, guestMode };
}

export async function setTriggerFlag(env: NyraEnv, key, on, updatedBy) {
  const allowed = ["trigger_enabled", "trigger_reply", "trigger_mention", "guest_mode"];
  if (!allowed.includes(key)) return false;
  return await setSetting(env, key, on ? "1" : "0", updatedBy);
}

export async function setTriggerWords(env: NyraEnv, words, updatedBy) {
  const list = Array.isArray(words) ? words : parseWordList(words);
  const cleaned = list.map(word => String(word).trim().slice(0, 32)).filter(Boolean).slice(0, 20);
  return await setSetting(env, "trigger_words", cleaned.join(","), updatedBy);
}

/** Legacy compatibility export; guest detection now depends on Telegram membership. */
export async function isGuestModeEnabled(_env: NyraEnv) {
  return false;
}

/** Guest mode applies when Nyra was addressed but is not a full group member. */
export async function detectGuestContext(env: NyraEnv, chat, botId) {
  if (!chat || !chat.id) return false;
  const type = chat.type || "";
  if (type === "private" || (type !== "group" && type !== "supergroup") || !botId) return false;
  try {
    const { tg } = await import("../telegram.js");
    const response = await tg(env, "getChatMember", { chat_id: chat.id, user_id: botId });
    const status = response && response.ok && response.result ? String(response.result.status || "") : "";
    return status !== "member" && status !== "administrator" && status !== "creator";
  } catch {
    return false;
  }
}
