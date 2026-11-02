// Mini App parity handlers for everything the Telegram menus could already do
// but the web UI could not reach: preferred name, memory inspection/clearing,
// personality selection, custom instructions and the per-connection fast /
// vision switches. All of them reuse the same storage helpers as the bot menus,
// so the two surfaces cannot drift apart. Error text is localized from the
// user's stored locale.
import { getUserStrict } from "../db/users.js";
import { setConnectionFast, setConnectionVision } from "../db/connections.js";
import { MAX_CUSTOM_INSTRUCTIONS, RETIRED_PERSONALITY_IDS, ONBOARDING_MAX_NAME_LENGTH } from "../config.js";
import { now, truncate } from "../utils.js";
import { listAvailablePersonalities, formatMemoryForUser, parseMemoryData, serializeMemoryData } from "../memory.js";
import { localeForUser, t } from "../i18n/index.js";
import { jsonOk, jsonError } from "./respond.js";

const MEMORY_MODES = ["normal", "minimal", "none"];

async function loadUser(env, userId) {
  return await getUserStrict(env, userId);
}

function localeOf(user) {
  return localeForUser(user);
}

/**
 * Memory inspection: current mode plus the facts long-term memory holds.
 * formatMemoryForUser` already escapes its output for HTML, which the Mini App
 * renders as text - so the raw structured data is returned as well and the
 * client decides how to present it.
 */
export async function handleUserMemory(env, userId) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleUserMemory failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const mode = user.memory_mode || "normal";
  const data = parseMemoryData(user.memory_data);
  return jsonOk({
    mode: mode,
    data: data,
    formatted: formatMemoryForUser(user.memory_data, mode),
    msg_counter: user.msg_counter || 0,
    has_data: Object.keys(data).length > 0
  });
}

/** Change the memory mode (normal | minimal | none). */
export async function handleSetMemoryMode(env, userId, body) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleSetMemoryMode failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const locale = localeOf(user);
  const mode = String((body && body.mode) || "");
  if (MEMORY_MODES.indexOf(mode) === -1) return jsonError(400, t(locale, "common.invalid_input"));
  await env.DB.prepare("UPDATE users SET memory_mode = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(mode, now(), userId).run();
  return jsonOk({ success: true, mode: mode });
}

/** Clear stored memory facts. `mode` is untouched so the user keeps their choice. */
export async function handleClearMemory(env, userId) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleClearMemory failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  await env.DB.prepare("UPDATE users SET memory_data = '{}', msg_counter = 0, updated_at = ? WHERE telegram_id = ?")
    .bind(now(), userId).run();
  return jsonOk({ success: true });
}

/**
 * Preferred name shown to the model and used by onboarding. Updating it also
 * mirrors the value into memory_data.preferred_name (other memory fields are
 * preserved) so the prompt does not disagree with the profile.
 */
export async function handleSetPreferredName(env, userId, body) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleSetPreferredName failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const locale = localeOf(user);
  if (!body || body.name === undefined) return jsonError(400, t(locale, "common.invalid_input"));
  const name = String(body.name === null ? "" : body.name).trim();
  if (name.length > ONBOARDING_MAX_NAME_LENGTH) {
    return jsonError(400, t(locale, "prefs.name_too_long", { max: ONBOARDING_MAX_NAME_LENGTH }));
  }
  const data = parseMemoryData(user.memory_data);
  const hadMemoryName = !!data.preferred_name;
  if (name) data.preferred_name = name;
  else delete data.preferred_name;
  const memoryChanged = !!name || hadMemoryName;
  await env.DB.prepare("UPDATE users SET preferred_name = ?, memory_data = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(name || null, memoryChanged ? serializeMemoryData(data) : (user.memory_data || "{}"), now(), userId).run();
  return jsonOk({ success: true, preferred_name: name || null });
}

/** Built-in plus the user's own personalities, with the active one flagged. */
export async function handlePersonalities(env, userId) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handlePersonalities failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const available = await listAvailablePersonalities(env, userId);
  const current = user.personality_id || "default";
  return jsonOk({
    builtins: available.builtins,
    customs: available.customs,
    personality_id: current
  });
}

/**
 * Select a personality. The id must resolve to a built-in or to one of THIS
 * user's custom personalities - accepting an arbitrary string would let anyone
 * point `personality_id` at another user's custom prompt.
 */
export async function handleSetPersonality(env, userId, body) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleSetPersonality failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const locale = localeOf(user);
  const requested = String((body && body.personality_id) || "").trim();
  if (!requested) return jsonError(400, t(locale, "common.invalid_input"));

  let resolved = null;
  if (requested === "default") {
    resolved = "default";
  } else if (requested.indexOf("custom:") === 0) {
    const rawId = requested.slice("custom:".length);
    const row = await env.DB.prepare("SELECT personality_id FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1")
      .bind(rawId, userId).first();
    if (row) resolved = "custom:" + row.personality_id;
  } else {
    const row = await env.DB.prepare("SELECT personality_id FROM personalities WHERE personality_id = ? AND enabled = 1")
      .bind(requested).first();
    if (row && RETIRED_PERSONALITY_IDS.indexOf(row.personality_id) === -1) resolved = row.personality_id;
  }
  if (!resolved) return jsonError(404, t(locale, "common.not_found"));

  await env.DB.prepare("UPDATE users SET personality_id = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(resolved, now(), userId).run();
  return jsonOk({ success: true, personality_id: resolved });
}

/**
 * Read/write the free-text custom instructions that `buildContextMessages`
 * appends to every system prompt. `body.text === null` (or "clear") removes
 * them, matching the bot's "Clear" button.
 */
export async function handleCustomInstructions(env, userId, body) {
  let user = null;
  try {
    user = await loadUser(env, userId);
  } catch (err) {
    console.error("handleCustomInstructions failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(localeForUser(null), "common.not_found"));
  const locale = localeOf(user);

  const raw = body ? body.text : undefined;
  const isClear = raw === null || raw === undefined || body.clear === true || String(raw).trim() === "";
  if (isClear) {
    await env.DB.prepare("UPDATE users SET custom_instructions = NULL, updated_at = ? WHERE telegram_id = ?")
      .bind(now(), userId).run();
    return jsonOk({ success: true, text: null });
  }

  const text = String(raw).trim();
  if (text.length > MAX_CUSTOM_INSTRUCTIONS) {
    return jsonError(400, t(locale, "prefs.instructions_too_long", { max: MAX_CUSTOM_INSTRUCTIONS }));
  }
  await env.DB.prepare("UPDATE users SET custom_instructions = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(text, now(), userId).run();
  return jsonOk({ success: true, text: text, preview: truncate(text, 400) });
}

/**
 * Flip a connection's fast / vision capability. Admin-only and global-only:
 * `setConnectionFast` and `setConnectionVision` both re-check `isAdmin`, and a
 * personal connection belongs to its owner rather than the admin panel.
 */
export async function handleAdminConnectionToggle(env, adminId, body) {
  const connectionId = body && body.connection_id;
  const field = body && body.field;
  if (!connectionId) return jsonError(400, t(localeForUser(null), "common.invalid_input"));
  if (field !== "fast" && field !== "vision") return jsonError(400, t(localeForUser(null), "common.invalid_input"));

  try {
    const row = await env.DB.prepare("SELECT connection_id, is_global FROM ai_connections WHERE connection_id = ?")
      .bind(connectionId).first();
    if (!row) return jsonError(404, t(localeForUser(null), "common.not_found"));
    if (row.is_global !== 1) return jsonError(403, t(localeForUser(null), "common.forbidden"));

    const ok = field === "fast"
      ? await setConnectionFast(env, adminId, connectionId)
      : await setConnectionVision(env, adminId, connectionId);
    if (!ok) return jsonError(403, t(localeForUser(null), "common.forbidden"));

    const updated = await env.DB.prepare("SELECT is_fast, supports_vision FROM ai_connections WHERE connection_id = ?")
      .bind(connectionId).first();
    return jsonOk({
      success: true,
      connection_id: connectionId,
      is_fast: updated ? updated.is_fast : null,
      supports_vision: updated ? updated.supports_vision : null
    });
  } catch (err) {
    console.error("handleAdminConnectionToggle failed:", err.message);
    return jsonError(500, t(localeForUser(null), "common.database_unavailable"));
  }
}
