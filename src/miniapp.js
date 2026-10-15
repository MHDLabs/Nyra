// Mini App backend API
import { createHmac } from "node:crypto";
import { getUser, getUserConnectionById, getUserConnections, getEnabledUserConnections, parseUsageStats, getAllConnectionUsageStats, saveThreadMessage, getThreadContext, getUserRoutes, getRouteById, getRouteModels, getRouteTokens, getRouteBundle, saveRoute, updateRoute, deleteRoute, setDefaultRoute, addRouteModel, removeRouteModel, setRouteDefaultModel, addRouteToken, removeRouteToken, toggleRouteToken, getSetting, setSetting, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections, saveGlobalConnection, deleteUserConnection } from "./db.js";
import { escapeHtml, now, isAdmin } from "./utils.js";
import { tryStreamWithFallback, humanizeError } from "./ai.js";
import { buildContextMessages, getUserPersonality } from "./memory.js";
import { createBroadcast, startBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast, listBroadcasts, getBroadcast, getBroadcastStats } from "./broadcast.js";
import { listFailedUpdates, replayFailedUpdate } from "./dlq.js";

const INIT_DATA_MAX_AGE_MS = 3600000; // 1 hour

function jsonOk(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

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

/**
 * Get user profile
 */
export async function handleUserProfile(env, userId) {
  const user = await getUser(env, userId);
  if (!user) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  let activeConnection = null;
  if (user.active_connection_id) {
    activeConnection = await getUserConnectionById(env, userId, user.active_connection_id);
  }

  const personality = user.personality_id === "default" 
    ? { name: "پیش‌فرض" }
    : await env.DB.prepare("SELECT name FROM custom_personalities WHERE personality_id = ? AND telegram_id = ?")
        .bind(user.personality_id.replace("custom:", ""), userId).first();

  return new Response(JSON.stringify({
    telegram_id: user.telegram_id,
    first_name: user.first_name || "",
    username: user.username || null,
    memory_mode: user.memory_mode || "normal",
    personality_id: user.personality_id || "default",
    coding_mode: user.coding_mode || 0,
    active_connection: activeConnection ? {
      label: activeConnection.label,
      provider: activeConnection.provider,
      model: activeConnection.model
    } : null,
    personality: personality || { name: "پیش‌فرض" }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Get user statistics
 */
export async function handleUserStats(env, userId) {
  const user = await getUser(env, userId);
  let total = 0, success = 0, fail = 0;
  if (user && user.usage_stats) {
    try {
      const stats = JSON.parse(user.usage_stats);
      total = stats.total || 0;
      success = stats.success || 0;
      fail = stats.fail || 0;
    } catch (e) {}
  }

  return new Response(JSON.stringify({
    total: total,
    success: success,
    fail: fail
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Handle chat message from Mini App — runs the real AI pipeline for this user.
 */
export async function handleChatMessage(env, userId, message) {
  const text = (message || "").toString().trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "Empty message" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  try {
    const user = await getUser(env, userId);
    if (!user) return jsonError(404, "User not found");
    const personality = await getUserPersonality(env, user);
    const recent = await getThreadContext(env, userId, userId);
    const messages = buildContextMessages(personality, user, null, Array.isArray(recent) ? recent : [], text, user.memory_mode || "normal");
    let reply = "";
    let usedConn = null;
    let category = null;
    for await (const event of tryStreamWithFallback(env, user, messages, { totalBudgetMs: 25000, stallTimeoutMs: 15000 })) {
      if (event.type === "text") reply += event.text;
      else if (event.type === "done") usedConn = event.connection;
      else if (event.type === "error") category = event.category;
    }
    if (!reply) {
      return jsonError(502, humanizeError(category || "unknown"));
    }
    try {
      await saveThreadMessage(env, userId, userId, Date.now(), userId, "user", text);
      await saveThreadMessage(env, userId, userId, Date.now() + 1, userId, "assistant", reply);
    } catch (e) {}
    return jsonOk({ response: reply, connection: usedConn ? { label: usedConn.label, model: usedConn.model } : null });
  } catch (err) {
    console.error("handleChatMessage failed:", err.message);
    return jsonError(500, "Chat failed");
  }
}

/** List the user's available models and the active one. */
export async function handleUserConnections(env, userId) {
  try {
    const user = await getUser(env, userId);
    const conns = await getEnabledUserConnections(env, userId);
    const list = conns.map(function (c) {
      return { connection_id: c.connection_id, label: c.label, provider: c.provider, model: c.model, is_global: c.is_global, is_fast: c.is_fast, active: user && user.active_connection_id === c.connection_id };
    });
    return jsonOk({ connections: list, active_connection_id: user ? user.active_connection_id : null });
  } catch (err) { return jsonError(500, "Failed to load connections"); }
}

/** Set the user's active connection. */
export async function handleSetActiveConnection(env, userId, connectionId) {
  try {
    const conn = await getUserConnectionById(env, userId, connectionId);
    if (!conn || conn.enabled !== 1) return jsonError(404, "Connection not found");
    if (conn.is_global !== 1 && conn.telegram_id !== userId) return jsonError(403, "Not allowed");
    await env.DB.prepare("UPDATE users SET active_connection_id = ?, active_route_id = NULL, updated_at = ? WHERE telegram_id = ?").bind(connectionId, now(), userId).run();
    return jsonOk({ success: true, active_connection_id: connectionId });
  } catch (err) { return jsonError(500, "Failed to set active connection"); }
}

/** List routes the user can see (admin: all their routes; user: routes available). */
export async function handleUserRoutes(env, userId) {
  try {
    const routes = await getUserRoutes(env, userId);
    const out = [];
    for (let i = 0; i < routes.length; i++) {
      const models = await getRouteModels(env, routes[i].route_id);
      const tokens = await getRouteTokens(env, routes[i].route_id);
      out.push({
        route_id: routes[i].route_id,
        label: routes[i].label,
        provider: routes[i].provider,
        is_default: routes[i].is_default,
        models: models.map(function (m) { return { model_id: m.model_id, model: m.model, is_default: m.is_default }; }),
        token_count: tokens.length,
        enabled_token_count: tokens.filter(function (t) { return t.enabled === 1; }).length
      });
    }
    return jsonOk({ routes: out });
  } catch (err) { return jsonError(500, "Failed to load routes"); }
}

/** Admin: create a route. */
export async function handleAdminCreateRoute(env, userId, body) {
  try {
    if (!body || !body.label || !body.provider) return jsonError(400, "Missing fields");
    const routeId = await saveRoute(env, userId, { label: body.label, provider: body.provider, base_url: body.base_url || "", models: body.models || [], tokens: body.tokens || [] });
    return jsonOk({ success: true, route_id: routeId });
  } catch (err) { return jsonError(500, "Failed to create route"); }
}

/** Admin: delete a route. */
export async function handleAdminDeleteRoute(env, userId, routeId) {
  try {
    const ok = await deleteRoute(env, userId, routeId);
    return ok ? jsonOk({ success: true }) : jsonError(404, "Route not found");
  } catch (err) { return jsonError(500, "Failed to delete route"); }
}

/** Admin: route sub-actions (models, tokens, default, update). */
export async function handleAdminRouteAction(env, userId, routeId, action, body) {
  try {
    const route = await getRouteById(env, userId, routeId);
    if (!route) return jsonError(404, "Route not found");
    switch (action) {
      case "update":
        await updateRoute(env, userId, routeId, { label: body.label, provider: body.provider, base_url: body.base_url });
        break;
      case "default":
        await setDefaultRoute(env, userId, routeId);
        break;
      case "model-add":
        if (!body.model) return jsonError(400, "Missing model");
        await addRouteModel(env, userId, routeId, body.model);
        break;
      case "model-remove":
        if (!body.model_id) return jsonError(400, "Missing model_id");
        await removeRouteModel(env, userId, routeId, body.model_id);
        break;
      case "model-default":
        if (!body.model_id) return jsonError(400, "Missing model_id");
        await setRouteDefaultModel(env, userId, routeId, body.model_id);
        break;
      case "token-add":
        if (!body.api_key) return jsonError(400, "Missing api_key");
        await addRouteToken(env, userId, routeId, body.api_key, body.label);
        break;
      case "token-remove":
        if (!body.token_id) return jsonError(400, "Missing token_id");
        await removeRouteToken(env, userId, routeId, body.token_id);
        break;
      case "token-toggle":
        if (!body.token_id) return jsonError(400, "Missing token_id");
        await toggleRouteToken(env, userId, routeId, body.token_id);
        break;
      default:
        return jsonError(400, "Unknown action");
    }
    const bundle = await getRouteBundle(env, userId, routeId);
    return jsonOk({ success: true, route: bundle });
  } catch (err) { return jsonError(500, "Route action failed"); }
}

/** Admin settings: read global toggles. */
export async function handleAdminSettings(env) {
  try {
    const allow = await isPersonalModelsAllowed(env);
    const limit = await getPersonalModelLimit(env);
    return jsonOk({ allow_personal_models: allow, personal_model_limit: limit });
  } catch (err) { return jsonError(500, "Failed to load settings"); }
}

/** Admin settings: update a global toggle. */
export async function handleAdminUpdateSettings(env, userId, body) {
  try {
    if (body && body.allow_personal_models !== undefined) {
      await setSetting(env, "allow_personal_models", body.allow_personal_models ? "1" : "0", userId);
    }
    if (body && body.personal_model_limit !== undefined) {
      const n = parseInt(body.personal_model_limit, 10);
      if (Number.isFinite(n) && n > 0) await setSetting(env, "personal_model_limit", String(n), userId);
    }
    return await handleAdminSettings(env);
  } catch (err) { return jsonError(500, "Failed to update settings"); }
}

/** Non-admin personal models: list, gated by the global toggle. */
export async function handlePersonalModels(env, userId) {
  try {
    const allowed = await isPersonalModelsAllowed(env);
    const limit = await getPersonalModelLimit(env);
    const conns = await getUserConnections(env, userId);
    const mine = conns.filter(function (c) { return c.is_global === 0; }).map(function (c) { return { connection_id: c.connection_id, label: c.label, model: c.model, provider: c.provider, enabled: c.enabled }; });
    return jsonOk({ allowed: allowed, limit: limit, count: mine.length, models: mine });
  } catch (err) { return jsonError(500, "Failed to load personal models"); }
}

/** Non-admin: create a personal model, gated by the global toggle and limit. */
export async function handleCreatePersonalModel(env, userId, body) {
  try {
    if (!(await isPersonalModelsAllowed(env))) return jsonError(403, "Forbidden");
    if (!body || !body.label || !body.model || !body.api_key) return jsonError(400, "Missing fields");
    const limit = await getPersonalModelLimit(env);
    const used = await countPersonalConnections(env, userId);
    if (used >= limit) return jsonError(403, "Personal model limit reached");
    await saveGlobalConnection(env, userId, {
      label: body.label,
      provider: body.provider || "openai",
      base_url: body.base_url || "",
      model: body.model,
      api_key: body.api_key,
      description: body.description || "",
      personal: true
    });
    return await handlePersonalModels(env, userId);
  } catch (err) { return jsonError(500, "Failed to create personal model"); }
}

/** Non-admin: delete one of their own personal models. */
export async function handleDeletePersonalModel(env, userId, connectionId) {
  try {
    if (!(await isPersonalModelsAllowed(env))) return jsonError(403, "Forbidden");
    const conn = await getUserConnectionById(env, userId, connectionId);
    if (!conn || conn.is_global === 1 || conn.telegram_id !== userId) return jsonError(403, "Not allowed");
    await deleteUserConnection(env, userId, connectionId);
    return await handlePersonalModels(env, userId);
  } catch (err) { return jsonError(500, "Failed to delete personal model"); }
}

/**
 * Get admin statistics
 */
export async function handleAdminStats(env) {
  const [users, chats, connections, usageRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM chats WHERE enabled = 1").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM ai_connections WHERE enabled = 1").first(),
    env.DB.prepare("SELECT SUM(request_count) as total_reqs FROM connection_usage").first().catch(() => ({ total_reqs: 0 }))
  ]);

  return new Response(JSON.stringify({
    users: users?.count || 0,
    chats: chats?.count || 0,
    requests: usageRow?.total_reqs || 0,
    connections: connections?.count || 0
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Get admin users list
 */
export async function handleAdminUsers(env, page = 0, limit = 50) {
  const offset = page * limit;
  const users = await env.DB.prepare(`
    SELECT 
      telegram_id, 
      first_name, 
      username, 
      created_at,
      msg_counter as request_count
    FROM users 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();

  return new Response(JSON.stringify({
    users: users.results || [],
    total: total?.count || 0,
    page: page,
    hasMore: (offset + limit) < (total?.count || 0)
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Get admin chats list
 */
export async function handleAdminChats(env, page = 0, limit = 50) {
  const offset = page * limit;
  const chats = await env.DB.prepare(`
    SELECT 
      chat_id, 
      title, 
      chat_type, 
      enabled,
      mode,
      created_at
    FROM chats 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM chats").first();

  return new Response(JSON.stringify({
    chats: chats.results || [],
    total: total?.count || 0,
    page: page,
    hasMore: (offset + limit) < (total?.count || 0)
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Serve static Mini App files
 */
export function serveStatic(pathname) {
  // Map paths to files
  const fileMap = {
    "/": "/index.html",
    "/index.html": "/index.html",
    "/app.js": "/app.js",
    "/styles.css": "/styles.css"
  };

  const file = fileMap[pathname];
  if (!file) return null;

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  };

  const ext = file.substring(file.lastIndexOf("."));
  return {
    file: file.substring(1), // Remove leading slash for filesystem
    contentType: contentTypes[ext] || "text/plain"
  };
}

/**
 * Route Mini App API requests
 */
export async function routeMiniAppAPI(env, ctx, request, pathname) {
  const url = new URL(request.url);
  
  // Authentication endpoint (no auth required)
  if (pathname === "/api/auth" && request.method === "POST") {
    const body = await request.json();
    return await handleAuth(env, body.initData);
  }

  // All other endpoints require authentication
  const validated = extractInitData(request, env);
  if (!validated) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const userId = validated.userId;

  // User endpoints
  if (pathname === "/api/user/profile" && request.method === "GET") {
    return await handleUserProfile(env, userId);
  }

  if (pathname === "/api/user/stats" && request.method === "GET") {
    return await handleUserStats(env, userId);
  }

  if (pathname === "/api/user/coding-mode" && request.method === "POST") {
    const body = await request.json();
    return await handleToggleCodingMode(env, userId, body.enabled);
  }

  if (pathname === "/api/chat" && request.method === "POST") {
    const body = await request.json();
    return await handleChatMessage(env, userId, body.message);
  }

  // User model + route endpoints
  if (pathname === "/api/user/connections" && request.method === "GET") {
    return await handleUserConnections(env, userId);
  }

  if (pathname === "/api/user/active-connection" && request.method === "POST") {
    const body = await request.json();
    return await handleSetActiveConnection(env, userId, body.connection_id);
  }

  if (pathname === "/api/user/routes" && request.method === "GET") {
    return await handleUserRoutes(env, userId);
  }

  if (pathname === "/api/user/personal-models" && request.method === "GET") {
    return await handlePersonalModels(env, userId);
  }

  if (pathname === "/api/user/personal-models" && request.method === "POST") {
    const body = await request.json();
    return await handleCreatePersonalModel(env, userId, body);
  }

  if (pathname.startsWith("/api/user/personal-models/") && request.method === "DELETE") {
    const connectionId = pathname.split("/")[4];
    return await handleDeletePersonalModel(env, userId, connectionId);
  }

  // Admin endpoints (require admin privileges)
  if (pathname.startsWith("/api/admin/")) {
    if (!isAdmin(env, userId)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (pathname === "/api/admin/stats" && request.method === "GET") {
      return await handleAdminStats(env);
    }

    if (pathname === "/api/admin/users" && request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "0", 10);
      return await handleAdminUsers(env, page);
    }

    if (pathname === "/api/admin/chats" && request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "0", 10);
      return await handleAdminChats(env, page);
    }

    // Broadcast management
    if (pathname === "/api/admin/broadcasts" && request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "0", 10);
      return await handleAdminBroadcasts(env, page);
    }

    if (pathname === "/api/admin/broadcast/create" && request.method === "POST") {
      const body = await request.json();
      return await handleCreateBroadcast(env, userId, body);
    }

    if (pathname.startsWith("/api/admin/broadcast/") && request.method === "POST") {
      const parts = pathname.split("/");
      const broadcastId = parts[4];
      const action = parts[5];
      return await handleBroadcastAction(env, ctx, broadcastId, action, userId);
    }

    if (pathname.startsWith("/api/admin/broadcast/") && request.method === "GET") {
      const broadcastId = pathname.split("/")[4];
      return await handleGetBroadcast(env, broadcastId);
    }

    // Failed updates (DLQ) management
    if (pathname === "/api/admin/failed-updates" && request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "0", 10);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      return await handleAdminFailedUpdates(env, page, limit);
    }

    if (pathname === "/api/admin/failed-updates/replay" && request.method === "POST") {
      const body = await request.json();
      return await handleReplayFailedUpdate(env, body.id);
    }

    // Connection usage metrics
    if (pathname === "/api/admin/connection-usage" && request.method === "GET") {
      const days = parseInt(url.searchParams.get("days") || "7", 10);
      return await handleAdminConnectionUsage(env, days);
    }

    // Route management
    if (pathname === "/api/admin/routes" && request.method === "GET") {
      return await handleUserRoutes(env, userId);
    }

    if (pathname === "/api/admin/routes" && request.method === "POST") {
      const body = await request.json();
      return await handleAdminCreateRoute(env, userId, body);
    }

    if (pathname.startsWith("/api/admin/routes/") && request.method === "DELETE") {
      const routeId = pathname.split("/")[4];
      return await handleAdminDeleteRoute(env, userId, routeId);
    }

    if (pathname.startsWith("/api/admin/routes/") && request.method === "POST") {
      const parts = pathname.split("/");
      const routeId = parts[4];
      const action = parts[5];
      const body = await request.json().catch(() => ({}));
      return await handleAdminRouteAction(env, userId, routeId, action, body);
    }

    // Global settings
    if (pathname === "/api/admin/settings" && request.method === "GET") {
      return await handleAdminSettings(env);
    }

    if (pathname === "/api/admin/settings" && request.method === "POST") {
      const body = await request.json();
      return await handleAdminUpdateSettings(env, userId, body);
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Handle broadcast list
 */
async function handleAdminBroadcasts(env, page = 0) {
  const result = await listBroadcasts(env, page, 20);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Handle create broadcast
 */
async function handleCreateBroadcast(env, userId, body) {
  try {
    const { message, targetType, targetFilter } = body;
    if (!message || !targetType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const result = await createBroadcast(env, userId, message, targetType, targetFilter);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle broadcast action (start/pause/resume/cancel)
 */
async function handleBroadcastAction(env, ctx, broadcastId, action, userId) {
  try {
    let result;
    if (action === "start") {
      result = await startBroadcast(env, ctx, broadcastId, userId);
    } else if (action === "pause") {
      result = await pauseBroadcast(env, broadcastId, userId);
    } else if (action === "resume") {
      result = await resumeBroadcast(env, ctx, broadcastId, userId);
    } else if (action === "cancel") {
      result = await cancelBroadcast(env, broadcastId, userId);
    } else {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle get broadcast details
 */
async function handleGetBroadcast(env, broadcastId) {
  try {
    const broadcast = await getBroadcast(env, broadcastId);
    if (!broadcast) {
      return new Response(JSON.stringify({ error: "Broadcast not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const stats = await getBroadcastStats(env, broadcastId);
    return new Response(JSON.stringify({ broadcast, stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle admin failed updates list
 */
async function handleAdminFailedUpdates(env, page = 0, limit = 50) {
  try {
    const offset = page * limit;
    const result = await listFailedUpdates(env, limit, offset);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle replay failed update
 */
async function handleReplayFailedUpdate(env, id) {
  try {
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const success = await replayFailedUpdate(env, id);
    if (!success) {
      return new Response(JSON.stringify({ error: "Failed to replay update" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle toggle coding mode
 */
async function handleToggleCodingMode(env, userId, enabled) {
  try {
    const codingMode = enabled ? 1 : 0;
    await env.DB.prepare(
      "UPDATE users SET coding_mode = ?, updated_at = ? WHERE telegram_id = ?"
    ).bind(codingMode, now(), userId).run();

    return new Response(JSON.stringify({ success: true, coding_mode: codingMode }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle admin connection usage stats
 */
async function handleAdminConnectionUsage(env, days = 7) {
  try {
    const stats = await getAllConnectionUsageStats(env, days);
    return new Response(JSON.stringify({ stats, days }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
