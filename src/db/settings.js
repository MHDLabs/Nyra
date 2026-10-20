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

export async function getWorkersAIPolicy(env) {
  const value = await getSetting(env, "workers_ai_policy", "disabled");
  return ["disabled", "admins", "all"].includes(value) ? value : "disabled";
}

export async function setWorkersAIPolicy(env, policy, updatedBy) {
  if (!["disabled", "admins", "all"].includes(policy)) return false;
  return await setSetting(env, "workers_ai_policy", policy, updatedBy);
}

export async function getWorkersAIModel(env) {
  const value = await getSetting(env, "workers_ai_model", "@cf/meta/llama-3.1-8b-instruct");
  return /^@cf\/[a-z0-9][a-z0-9./_-]{2,119}$/i.test(value) ? value : "@cf/meta/llama-3.1-8b-instruct";
}

export async function setWorkersAIModel(env, model, updatedBy) {
  const value = String(model || "").trim();
  if (!/^@cf\/[a-z0-9][a-z0-9./_-]{2,119}$/i.test(value)) return false;
  return await setSetting(env, "workers_ai_model", value, updatedBy);
}

export async function canUseWorkersAI(env, userId) {
  const policy = await getWorkersAIPolicy(env);
  if (policy === "disabled" || !env || !env.AI || typeof env.AI.run !== "function") return false;
  if (policy === "all") return true;
  const { isAdmin } = await import("../utils.js");
  return isAdmin(env, userId);
}
