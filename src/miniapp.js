// Mini App backend API
import { createHmac } from "node:crypto";
import { getUser, getUserConnectionById, getEnabledUserConnections, parseUsageStats, now, isAdmin, getAllConnectionUsageStats } from "./db.js";
import { escapeHtml } from "./utils.js";
import { createBroadcast, startBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast, listBroadcasts, getBroadcast, getBroadcastStats } from "./broadcast.js";
import { listFailedUpdates, replayFailedUpdate } from "./dlq.js";

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

  return new Response(JSON.stringify({
    user: {
      telegram_id: validated.userId,
      first_name: validated.firstName,
      username: validated.username,
      memory_mode: user?.memory_mode || "normal",
      personality_id: user?.personality_id || "default"
    },
    isAdmin: adminStatus
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
 * Handle chat message from Mini App
 */
export async function handleChatMessage(env, userId, message) {
  // This is a simplified version - real implementation would integrate with AI pipeline
  // For now, return a placeholder
  return new Response(JSON.stringify({
    response: "این ویژگی به زودی فعال می‌شود. لطفاً از ربات تلگرام استفاده کنید."
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
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
