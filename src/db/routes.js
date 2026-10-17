// Routes: multi-model / multi-token fallback groups plus the ordered streaming
// plan (`buildRoutePlan`) consumed by the AI layer. Owns `userRoutesCache`.
import { CONNECTION_CACHE_TTL_MS } from "../config.js";
import { generateShortId, now } from "../utils.js";
import { encryptCredential } from "../crypto.js";

let userRoutesCache = new Map();

function invalidateUserRoutesCache(userId) {
  if (userId) userRoutesCache.delete(String(userId));
  else userRoutesCache.clear();
}

export async function getUserRoutes(env, userId, forceRefresh) {
  const key = String(userId);
  const cached = userRoutesCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.routes;
  try {
    const result = await env.DB.prepare("SELECT * FROM routes WHERE telegram_id = ? ORDER BY is_default DESC, display_order ASC, created_at ASC").bind(userId).all();
    const list = result.results || [];
    userRoutesCache.set(key, { routes: list, expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS });
    return list;
  } catch (err) {
    console.error("getUserRoutes failed:", err.message);
    return [];
  }
}

export async function getRouteById(env, userId, routeId) {
  try {
    return await env.DB.prepare("SELECT * FROM routes WHERE route_id = ? AND telegram_id = ?").bind(routeId, userId).first();
  } catch (err) { return null; }
}

export async function getRouteModels(env, routeId) {
  try {
    const result = await env.DB.prepare("SELECT * FROM route_models WHERE route_id = ? ORDER BY is_default DESC, display_order ASC, created_at ASC").bind(routeId).all();
    return result.results || [];
  } catch (err) { return []; }
}

export async function getRouteTokens(env, routeId) {
  try {
    const result = await env.DB.prepare("SELECT * FROM route_tokens WHERE route_id = ? ORDER BY is_primary DESC, display_order ASC, created_at ASC").bind(routeId).all();
    return result.results || [];
  } catch (err) { return []; }
}

/** Full route bundle: route + ordered models + ordered tokens. */
export async function getRouteBundle(env, userId, routeId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return null;
  const models = await getRouteModels(env, routeId);
  const tokens = await getRouteTokens(env, routeId);
  return { route: route, models: models, tokens: tokens };
}

/** Expand a route into an ordered list of synthetic connections the AI layer can
 * stream through: for each model (default first), for each enabled token. */
export function buildRoutePlan(bundle) {
  if (!bundle || !bundle.route) return [];
  const route = bundle.route;
  const models = bundle.models.filter(function (m) { return true; });
  const tokens = bundle.tokens.filter(function (t) { return t.enabled === 1; });
  const plan = [];
  for (let mi = 0; mi < models.length; mi++) {
    const m = models[mi];
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      plan.push({
        connection_id: route.route_id + ":" + t.token_id + ":" + m.model_id,
        route_id: route.route_id,
        token_id: t.token_id,
        model_id: m.model_id,
        telegram_id: route.telegram_id,
        label: route.label,
        provider: route.provider,
        base_url: route.base_url,
        model: m.model,
        encrypted_key: t.encrypted_key,
        key_iv: t.key_iv,
        is_global: 1,
        is_fast: 0,
        is_route: true,
        consecutive_failures: t.consecutive_failures || 0,
        is_primary: mi === 0 && ti === 0
      });
    }
  }
  return plan;
}

/** The user's active (or default) enabled route, if any. */
export async function resolveUserActiveRoute(env, user) {
  const routes = await getUserRoutes(env, user.telegram_id);
  if (routes.length === 0) return null;
  let route = null;
  if (user && user.active_route_id) {
    for (let i = 0; i < routes.length; i++) if (routes[i].route_id === user.active_route_id) { route = routes[i]; break; }
  }
  if (!route) {
    for (let i = 0; i < routes.length; i++) if (routes[i].is_default === 1) { route = routes[i]; break; }
  }
  if (!route) route = routes[0];
  const models = await getRouteModels(env, route.route_id);
  const tokens = await getRouteTokens(env, route.route_id);
  const enabledTokens = tokens.filter(function (t) { return t.enabled === 1; });
  if (models.length === 0 || enabledTokens.length === 0) return null;
  return { route: route, models: models, tokens: tokens };
}

export async function saveRoute(env, userId, params) {
  const ts = now();
  const routeId = generateShortId();
  let maxOrder = 100;
  try {
    const row = await env.DB.prepare("SELECT MAX(display_order) AS m FROM routes WHERE telegram_id = ?").bind(userId).first();
    if (row && row.m !== null && row.m !== undefined) maxOrder = row.m + 10;
  } catch (err) {}
  const models = params.models || [];
  const tokens = params.tokens || [];
  await env.DB.prepare("INSERT INTO routes (route_id, telegram_id, label, provider, base_url, is_default, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(routeId, userId, params.label, params.provider, params.base_url || "", maxOrder, ts, ts).run();
  const inserts = [];
  for (let i = 0; i < models.length; i++) {
    inserts.push(env.DB.prepare("INSERT INTO route_models (model_id, route_id, model, label, is_default, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(generateShortId(), routeId, models[i], models[i], i === 0 ? 1 : 0, 100 + i * 10, ts, ts));
  }
  for (let i = 0; i < tokens.length; i++) {
    const enc = await encryptCredential(env, userId, tokens[i]);
    inserts.push(env.DB.prepare("INSERT INTO route_tokens (token_id, route_id, label, encrypted_key, key_iv, encryption_version, enabled, is_primary, display_order, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 2, 1, ?, ?, 0, ?, ?)")
      .bind(generateShortId(), routeId, "token " + (i + 1), enc.ct, enc.iv, i === 0 ? 1 : 0, 100 + i * 10, ts, ts));
  }
  if (inserts.length > 0) await env.DB.batch(inserts);
  invalidateUserRoutesCache(userId);
  return routeId;
}

export async function updateRoute(env, userId, routeId, updates) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  const fields = [];
  const values = [];
  if (updates.label !== undefined) { fields.push("label = ?"); values.push(updates.label); }
  if (updates.provider !== undefined) { fields.push("provider = ?"); values.push(updates.provider); }
  if (updates.base_url !== undefined) { fields.push("base_url = ?"); values.push(updates.base_url); }
  if (fields.length === 0) return true;
  fields.push("updated_at = ?"); values.push(now());
  values.push(routeId);
  try {
    await env.DB.prepare("UPDATE routes SET " + fields.join(", ") + " WHERE route_id = ?").bind.apply(null, values).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { console.error("updateRoute failed:", err.message); return false; }
}

export async function deleteRoute(env, userId, routeId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM route_models WHERE route_id = ?").bind(routeId),
      env.DB.prepare("DELETE FROM route_tokens WHERE route_id = ?").bind(routeId),
      env.DB.prepare("DELETE FROM routes WHERE route_id = ?").bind(routeId)
    ]);
    try { await env.DB.prepare("UPDATE users SET active_route_id = NULL, updated_at = ? WHERE active_route_id = ?").bind(now(), routeId).run(); } catch (e) {}
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { console.error("deleteRoute failed:", err.message); return false; }
}

export async function setDefaultRoute(env, userId, routeId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE routes SET is_default = 0 WHERE telegram_id = ?").bind(userId),
      env.DB.prepare("UPDATE routes SET is_default = 1, updated_at = ? WHERE route_id = ? AND telegram_id = ?").bind(now(), routeId, userId)
    ]);
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { console.error("setDefaultRoute failed:", err.message); return false; }
}

export async function addRouteModel(env, userId, routeId, model) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  const ts = now();
  let count = 0;
  try { const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM route_models WHERE route_id = ?").bind(routeId).first(); count = row ? row.c : 0; } catch (e) {}
  try {
    await env.DB.prepare("INSERT INTO route_models (model_id, route_id, model, label, is_default, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
      .bind(generateShortId(), routeId, model, model, 100 + count * 10, ts, ts).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function removeRouteModel(env, userId, routeId, modelId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    await env.DB.prepare("DELETE FROM route_models WHERE model_id = ? AND route_id = ?").bind(modelId, routeId).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function setRouteDefaultModel(env, userId, routeId, modelId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE route_models SET is_default = 0 WHERE route_id = ?").bind(routeId),
      env.DB.prepare("UPDATE route_models SET is_default = 1, updated_at = ? WHERE model_id = ? AND route_id = ?").bind(now(), modelId, routeId)
    ]);
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function addRouteToken(env, userId, routeId, apiKey, label) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  const ts = now();
  let count = 0;
  try { const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM route_tokens WHERE route_id = ?").bind(routeId).first(); count = row ? row.c : 0; } catch (e) {}
  const enc = await encryptCredential(env, userId, apiKey);
  try {
    await env.DB.prepare("INSERT INTO route_tokens (token_id, route_id, label, encrypted_key, key_iv, encryption_version, enabled, is_primary, display_order, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 2, 1, 0, ?, 0, ?, ?)")
      .bind(generateShortId(), routeId, label || ("token " + (count + 1)), enc.ct, enc.iv, 100 + count * 10, ts, ts).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function removeRouteToken(env, userId, routeId, tokenId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    await env.DB.prepare("DELETE FROM route_tokens WHERE token_id = ? AND route_id = ?").bind(tokenId, routeId).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function toggleRouteToken(env, userId, routeId, tokenId) {
  const route = await getRouteById(env, userId, routeId);
  if (!route) return false;
  try {
    const tok = await env.DB.prepare("SELECT enabled FROM route_tokens WHERE token_id = ? AND route_id = ?").bind(tokenId, routeId).first();
    if (!tok) return false;
    await env.DB.prepare("UPDATE route_tokens SET enabled = ?, updated_at = ? WHERE token_id = ?").bind(tok.enabled === 1 ? 0 : 1, now(), tokenId).run();
    invalidateUserRoutesCache(userId);
    return true;
  } catch (err) { return false; }
}

export async function recordRouteTokenFailure(env, tokenId) {
  try {
    await env.DB.prepare("UPDATE route_tokens SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE token_id = ?").bind(now(), tokenId).run();
    invalidateUserRoutesCache(null);
  } catch (err) {}
}

export async function recordRouteTokenSuccess(env, tokenId) {
  try {
    await env.DB.prepare("UPDATE route_tokens SET consecutive_failures = 0, last_success_at = ?, last_used_at = ?, updated_at = ? WHERE token_id = ?").bind(now(), now(), now(), tokenId).run();
    invalidateUserRoutesCache(null);
  } catch (err) {}
}

// --- App settings (global deployment toggles) ------------------------------
