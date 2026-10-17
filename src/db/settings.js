// Global deployment settings (`app_settings` key/value toggles).
import { now } from "../utils.js";

export async function getSetting(env, key, fallback) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
    if (!row) return fallback;
    return row.value;
  } catch (err) { return fallback; }
}

export async function setSetting(env, key, value, updatedBy) {
  try {
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(key, String(value), now(), updatedBy || null).run();
    return true;
  } catch (err) { console.error("setSetting failed:", err.message); return false; }
}

export async function isPersonalModelsAllowed(env) {
  const v = await getSetting(env, "allow_personal_models", "0");
  return v === "1" || v === "true";
}

export async function getPersonalModelLimit(env) {
  const v = await getSetting(env, "personal_model_limit", "5");
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
