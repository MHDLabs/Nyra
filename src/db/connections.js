// AI connections: CRUD, the cached connection list, health bookkeeping and
// active-connection resolution. Owns the single `userConnectionsCache`.
import { CONNECTION_CACHE_TTL_MS } from "../config.js";
import { generateShortId, isAdmin, now, normalizeBaseUrl } from "../utils.js";
import { encryptCredential } from "../crypto.js";

let userConnectionsCache = new Map();

function invalidateUserConnectionsCache(userId) {
  if (userId) userConnectionsCache.delete(String(userId));
  else userConnectionsCache.clear();
}

export async function getUserConnections(env, userId, forceRefresh) {
  const key = String(userId);
  const cached = userConnectionsCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.connections;
  try {
    const result = await env.DB.prepare("SELECT * FROM ai_connections WHERE (telegram_id = ? AND is_global = 0) OR is_global = 1 ORDER BY is_global DESC, display_order ASC, created_at ASC").bind(userId).all();
    const list = result.results || [];
    userConnectionsCache.set(key, { connections: list, expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS });
    return list;
  } catch (err) {
    console.error("getUserConnections failed:", err.message);
    return [];
  }
}

export async function getEnabledUserConnections(env, userId) {
  const all = await getUserConnections(env, userId);
  return all.filter(function (c) { return c.enabled === 1; });
}

export async function getUserConnectionById(env, userId, connectionId) {
  try {
    return await env.DB.prepare("SELECT * FROM ai_connections WHERE connection_id = ? AND ((telegram_id = ? AND is_global = 0) OR is_global = 1)").bind(connectionId, userId).first();
  } catch (err) { return null; }
}

export async function saveGlobalConnection(env, adminId, params) {
  const ts = now();
  const encrypted = await encryptCredential(env, adminId, params.api_key);
  const connectionId = generateShortId();
  const isGlobal = params.is_global === 0 || params.is_global === false || params.personal ? 0 : 1;
  // Last line of defence against a double "/chat/completions": every write path
  // (wizard, Mini App, personal models) funnels through here.
  const baseUrl = normalizeBaseUrl(params.provider, params.base_url);
  let maxOrder = 100;
  try {
    const row = await env.DB.prepare("SELECT MAX(display_order) AS m FROM ai_connections WHERE is_global = 1").first();
    if (row && row.m !== null && row.m !== undefined) maxOrder = row.m + 10;
  } catch (err) {}
  await env.DB.prepare(
    "INSERT INTO ai_connections (connection_id, telegram_id, label, provider, base_url, model, encrypted_key, key_iv, encryption_version, enabled, is_global, is_default, description, display_order, supports_vision, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?, 0, ?, ?, ?, 0, ?, ?)"
  ).bind(connectionId, adminId, params.label, params.provider, baseUrl, params.model, encrypted.ct, encrypted.iv, isGlobal, params.description || "", maxOrder, params.supports_vision === 1 || params.supports_vision === true ? 1 : 0, ts, ts).run();
  invalidateUserConnectionsCache(null);
  return connectionId;
}

export async function updateUserConnection(env, userId, connectionId, updates) {
  const ts = now();
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  const fields = [];
  const values = [];
  if (updates.label !== undefined) { fields.push("label = ?"); values.push(updates.label); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.base_url !== undefined) { fields.push("base_url = ?"); values.push(normalizeBaseUrl(updates.provider || conn.provider, updates.base_url)); }
  if (updates.model !== undefined) { fields.push("model = ?"); values.push(updates.model); }
  if (updates.provider !== undefined) { fields.push("provider = ?"); values.push(updates.provider); }
  if (updates.is_fast !== undefined) { fields.push("is_fast = ?"); values.push(updates.is_fast ? 1 : 0); }
  if (updates.supports_vision !== undefined) { fields.push("supports_vision = ?"); values.push(updates.supports_vision ? 1 : 0); }
  if (updates.encrypted_key !== undefined && updates.key_iv !== undefined) {
    fields.push("encrypted_key = ?"); values.push(updates.encrypted_key);
    fields.push("key_iv = ?"); values.push(updates.key_iv);
  }
  if (fields.length === 0) return true;
  fields.push("updated_at = ?"); values.push(ts);
  values.push(connectionId);
  try {
    await env.DB.prepare("UPDATE ai_connections SET " + fields.join(", ") + " WHERE connection_id = ?").bind.apply(null, values).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("updateUserConnection failed:", err.message); return false; }
}

export async function deleteUserConnection(env, userId, connectionId) {
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  try {
    await env.DB.prepare("DELETE FROM ai_connections WHERE connection_id = ?").bind(connectionId).run();
    invalidateUserConnectionsCache(null);
    try { await env.DB.prepare("UPDATE users SET active_connection_id = NULL, updated_at = ? WHERE active_connection_id = ?").bind(now(), connectionId).run(); } catch (e) {}
    return true;
  } catch (err) { console.error("deleteUserConnection failed:", err.message); return false; }
}

export async function toggleUserConnection(env, userId, connectionId) {
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  try {
    const newState = conn.enabled === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE ai_connections SET enabled = ?, updated_at = ? WHERE connection_id = ?").bind(newState, now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { return false; }
}

export async function setDefaultConnection(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return false;
  try {
    await env.DB.prepare("UPDATE ai_connections SET is_default = 0 WHERE is_global = 1").run();
    await env.DB.prepare("UPDATE ai_connections SET is_default = 1, updated_at = ? WHERE connection_id = ? AND is_global = 1").bind(now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("setDefaultConnection failed:", err.message); return false; }
}

/** Toggle fast-mode on a global connection. Fast models stream straight from
 * the webhook request instead of waiting in the queue consumer's batch window. */
export async function setConnectionFast(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return false;
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, adminId)) return false;
  try {
    const newState = conn.is_fast === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE ai_connections SET is_fast = ?, updated_at = ? WHERE connection_id = ?").bind(newState, now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("setConnectionFast failed:", err.message); return false; }
}

/**
 * Toggle image/vision support on a connection. Only meaningful for models that
 * actually accept image input — when on, the user's photos are forwarded to the
 * model instead of being reduced to a "[user sent a photo]" placeholder.
 */
export async function setConnectionVision(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return false;
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, adminId)) return false;
  try {
    const newState = conn.supports_vision === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE ai_connections SET supports_vision = ?, updated_at = ? WHERE connection_id = ?").bind(newState, now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("setConnectionVision failed:", err.message); return false; }
}

export async function updateUserConnectionTest(env, userId, connectionId, status, error, latencyMs, diagnostic) {
  const ts = now();
  try {
    if (status === "success") {
      await env.DB.prepare("UPDATE ai_connections SET last_test_at = ?, last_test_status = ?, last_test_error = NULL, last_test_latency_ms = ?, last_test_diagnostic = NULL, consecutive_failures = 0, last_success_at = ?, updated_at = ? WHERE connection_id = ?")
        .bind(ts, status, latencyMs || null, ts, ts, connectionId).run();
    } else {
      await env.DB.prepare("UPDATE ai_connections SET last_test_at = ?, last_test_status = ?, last_test_error = ?, last_test_latency_ms = ?, last_test_diagnostic = ?, updated_at = ? WHERE connection_id = ?")
        .bind(ts, status, error || null, latencyMs || null, diagnostic || null, ts, connectionId).run();
    }
    invalidateUserConnectionsCache(null);
  } catch (err) { console.error("updateUserConnectionTest failed:", err.message); }
}

export async function recordConnectionFailure(env, connectionId) {
  try {
    await env.DB.prepare("UPDATE ai_connections SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE connection_id = ?").bind(now(), connectionId).run();
    invalidateUserConnectionsCache(null);
  } catch (err) {}
}

export async function recordConnectionSuccess(env, connectionId) {
  try {
    await env.DB.prepare("UPDATE ai_connections SET consecutive_failures = 0, last_success_at = ?, updated_at = ? WHERE connection_id = ?").bind(now(), now(), connectionId).run();
    invalidateUserConnectionsCache(null);
  } catch (err) {}
}

/** The caller's own enabled connections (never the operator's). */
export async function getEnabledPersonalConnections(env, userId) {
  const all = await getUserConnections(env, userId);
  return all.filter(function (c) { return c.enabled === 1 && c.is_global === 0 && Number(c.telegram_id) === Number(userId); });
}

/**
 * Enabled operator-owned connections. These are the models a user with no API
 * key of their own can actually reach, so the shared-service switch must never
 * be treated as "available" when this returns zero rows.
 */
export async function getEnabledSharedConnections(env) {
  try {
    const res = await env.DB.prepare(
      "SELECT connection_id, telegram_id, label, provider, base_url, model, enabled, is_global, is_default, is_fast, supports_vision, description, display_order, last_test_status, last_test_diagnostic, last_test_error, last_test_at, consecutive_failures, created_at FROM ai_connections WHERE is_global = 1 AND enabled = 1 ORDER BY is_default DESC, display_order ASC, created_at ASC"
    ).all();
    return res.results || [];
  } catch (err) {
    console.error("getEnabledSharedConnections failed:", err.message);
    return [];
  }
}

/** Operator-owned connections including disabled ones, credential-free. */
export async function listGlobalConnections(env) {
  try {
    const res = await env.DB.prepare(
      "SELECT connection_id, telegram_id, label, provider, base_url, model, description, enabled, is_global, is_default, is_fast, supports_vision, display_order, last_test_status, last_test_error, last_test_diagnostic, last_test_at, consecutive_failures, created_at FROM ai_connections WHERE is_global = 1 ORDER BY is_default DESC, display_order ASC, created_at ASC"
    ).all();
    return res.results || [];
  } catch (err) {
    console.error("listGlobalConnections failed:", err.message);
    return [];
  }
}

export async function countEnabledSharedConnections(env) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections WHERE is_global = 1 AND enabled = 1").first();
    return row ? row.c : 0;
  } catch (err) { return 0; }
}

/** Explicit enable/disable for a global connection (admin only). */
export async function setGlobalConnectionEnabled(env, adminId, connectionId, enabled) {
  if (!isAdmin(env, adminId)) return false;
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn || conn.is_global !== 1) return false;
  try {
    await env.DB.prepare("UPDATE ai_connections SET enabled = ?, updated_at = ? WHERE connection_id = ? AND is_global = 1")
      .bind(enabled ? 1 : 0, now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("setGlobalConnectionEnabled failed:", err.message); return false; }
}

export async function resolveUserActiveConnection(env, user) {
  const conns = await getEnabledUserConnections(env, user.telegram_id);
  if (conns.length === 0) return { connection: null, switched: false, previousMissing: false };
  let conn = null;
  if (user && user.active_connection_id) {
    for (let i = 0; i < conns.length; i++) if (conns[i].connection_id === user.active_connection_id) { conn = conns[i]; break; }
  }
  if (!conn) {
    let target = null;
    for (let i = 0; i < conns.length; i++) if (conns[i].is_global === 1 && conns[i].is_default === 1) { target = conns[i]; break; }
    if (!target) target = conns[0];
    try { await env.DB.prepare("UPDATE users SET active_connection_id = ?, updated_at = ? WHERE telegram_id = ?").bind(target.connection_id, now(), user.telegram_id).run(); } catch (err) {}
    return { connection: target, switched: true, previousMissing: !!(user && user.active_connection_id) };
  }
  return { connection: conn, switched: false, previousMissing: false };
}

// --- Routes (multi-model + multi-token fallback groups) --------------------

export async function countPersonalConnections(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections WHERE telegram_id = ? AND is_global = 0").bind(userId).first();
    return row ? row.c : 0;
  } catch (err) { return 0; }
}
