// The Mini App's HTTP surface: one flat route table over `pathname`, with the
// authentication gate, the rate limiter and the admin gate applied before any
// handler runs. Kept as one table so the API contract is readable in one place
// — the handlers themselves are grouped by domain in sibling files.
import { isAdmin, checkRateLimit } from "../utils.js";
import { RATE_LIMIT_ADMIN_PER_MIN, RATE_LIMIT_USER_PER_MIN } from "../config.js";
import { extractInitData, handleAuth } from "./auth.js";
import { handleUserProfile, handleUserStats, handleChatMessage, handleUserConnections, handleSetActiveConnection, handleToggleCodingMode } from "./user.js";
import { handlePersonalModels, handleCreatePersonalModel, handleDeletePersonalModel } from "./personal.js";
import { handleUserRoutes, handleAdminCreateRoute, handleAdminDeleteRoute, handleAdminRouteAction } from "./routes.js";
import { handleAdminStats, handleAdminUsers, handleAdminChats, handleAdminSettings, handleAdminUpdateSettings, handleAdminConnectionUsage } from "./admin.js";
import { handleAdminBroadcasts, handleCreateBroadcast, handleBroadcastAction, handleGetBroadcast, handleBroadcastPreview } from "./broadcast-api.js";
import { handleAdminFailedUpdates, handleReplayFailedUpdate } from "./dlq-api.js";
import { handleUserMemory, handleSetMemoryMode, handleClearMemory, handlePersonalities, handleSetPersonality, handleCustomInstructions, handleAdminConnectionToggle } from "./preferences.js";
import { jsonOk, jsonError } from "./respond.js";

/** Read a JSON body without throwing on malformed input. */
async function readBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body;
  } catch (err) {
    return {};
  }
}

/**
 * Route Mini App API requests.
 *
 * `pathname` is normalised here (trailing slashes collapsed) so `/api/chat/`
 * hits the same handler as `/api/chat` — previously a stray trailing slash
 * produced a 404 that looked like a missing endpoint.
 */
export async function routeMiniAppAPI(env, ctx, request, pathname) {
  const url = new URL(request.url);
  let path = pathname || url.pathname || "";
  if (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  try {
    // Authentication endpoint (no auth required, but still rate limited so the
    // HMAC check cannot be used as a CPU-exhaustion oracle).
    if (path === "/api/auth" && request.method === "POST") {
      const allowed = await checkRateLimit(env, "auth:" + request.headers.get("CF-Connecting-IP"), RATE_LIMIT_USER_PER_MIN * 6, 60);
      if (!allowed) return jsonError(429, "Too many requests");
      const body = await readBody(request);
      return await handleAuth(env, body.initData);
    }

    // All other endpoints require authentication
    const validated = extractInitData(request, env);
    if (!validated) return jsonError(401, "Unauthorized");

    const userId = validated.userId;

    // Rate limit every authenticated call. Admin calls have their own budget so
    // panel polling cannot starve the user's own chat allowance.
    const isAdminPath = path.indexOf("/api/admin/") === 0;
    const limit = isAdminPath ? RATE_LIMIT_ADMIN_PER_MIN * 6 : RATE_LIMIT_USER_PER_MIN * 6;
    const bucket = isAdminPath ? "apiadm:" : "api:";
    const allowed = await checkRateLimit(env, bucket + userId, limit, 60);
    if (!allowed) return jsonError(429, "Too many requests. Please slow down.");

    // User endpoints
    if (path === "/api/user/profile" && request.method === "GET") {
      return await handleUserProfile(env, userId);
    }

    if (path === "/api/user/stats" && request.method === "GET") {
      return await handleUserStats(env, userId);
    }

    if (path === "/api/user/coding-mode" && request.method === "POST") {
      const body = await readBody(request);
      return await handleToggleCodingMode(env, userId, body.enabled);
    }

    if (path === "/api/chat" && request.method === "POST") {
      const body = await readBody(request);
      return await handleChatMessage(env, ctx, userId, body.message, request);
    }

    // User model + route endpoints
    if (path === "/api/user/connections" && request.method === "GET") {
      return await handleUserConnections(env, userId);
    }

    if (path === "/api/user/active-connection" && request.method === "POST") {
      const body = await readBody(request);
      return await handleSetActiveConnection(env, userId, body.connection_id);
    }

    if (path === "/api/user/routes" && request.method === "GET") {
      return await handleUserRoutes(env, userId);
    }

    // Memory: inspect, change mode, clear
    if (path === "/api/user/memory" && request.method === "GET") {
      return await handleUserMemory(env, userId);
    }

    if (path === "/api/user/memory" && request.method === "POST") {
      const body = await readBody(request);
      return await handleSetMemoryMode(env, userId, body);
    }

    if (path === "/api/user/memory/clear" && request.method === "POST") {
      return await handleClearMemory(env, userId);
    }

    // Personality selection
    if (path === "/api/user/personality" && request.method === "GET") {
      return await handlePersonalities(env, userId);
    }

    if (path === "/api/user/personality" && request.method === "POST") {
      const body = await readBody(request);
      return await handleSetPersonality(env, userId, body);
    }

    // Custom instructions
    if (path === "/api/user/custom-instructions" && request.method === "GET") {
      let user;
      try {
        user = await env.DB.prepare("SELECT custom_instructions FROM users WHERE telegram_id = ?").bind(userId).first();
      } catch (err) { return jsonError(500, "Database unavailable"); }
      if (!user) return jsonError(404, "User not found");
      return jsonOk({ text: user.custom_instructions || null, max: 1000 });
    }

    if (path === "/api/user/custom-instructions" && request.method === "POST") {
      const body = await readBody(request);
      return await handleCustomInstructions(env, userId, body);
    }

    if (path === "/api/user/personal-models" && request.method === "GET") {
      return await handlePersonalModels(env, userId);
    }

    if (path === "/api/user/personal-models" && request.method === "POST") {
      const body = await readBody(request);
      return await handleCreatePersonalModel(env, userId, body);
    }

    if (path.indexOf("/api/user/personal-models/") === 0 && request.method === "DELETE") {
      const connectionId = path.split("/")[4];
      return await handleDeletePersonalModel(env, userId, connectionId);
    }

    // Admin endpoints (require admin privileges)
    if (path.indexOf("/api/admin/") === 0) {
      if (!isAdmin(env, userId)) return jsonError(403, "Forbidden");

      if (path === "/api/admin/stats" && request.method === "GET") {
        return await handleAdminStats(env);
      }

      if (path === "/api/admin/users" && request.method === "GET") {
        const page = parseInt(url.searchParams.get("page") || "0", 10);
        return await handleAdminUsers(env, page);
      }

      if (path === "/api/admin/chats" && request.method === "GET") {
        const page = parseInt(url.searchParams.get("page") || "0", 10);
        return await handleAdminChats(env, page);
      }

      // Broadcast management
      if (path === "/api/admin/broadcasts" && request.method === "GET") {
        const page = parseInt(url.searchParams.get("page") || "0", 10);
        return await handleAdminBroadcasts(env, page);
      }

      if (path === "/api/admin/broadcast/create" && request.method === "POST") {
        const body = await readBody(request);
        return await handleCreateBroadcast(env, userId, body);
      }

      if (path === "/api/admin/broadcast/preview" && request.method === "POST") {
        const body = await readBody(request);
        return await handleBroadcastPreview(env, body);
      }

      // The action endpoint must be matched before the read endpoint, otherwise
      // POST /broadcast/<id>/start would fall through to the detail handler.
      if (path.indexOf("/api/admin/broadcast/") === 0 && request.method === "POST") {
        const parts = path.split("/");
        const broadcastId = parts[4];
        const action = parts[5];
        if (!action) return jsonError(400, "Missing broadcast action");
        return await handleBroadcastAction(env, ctx, broadcastId, action, userId);
      }

      if (path.indexOf("/api/admin/broadcast/") === 0 && request.method === "GET") {
        const broadcastId = path.split("/")[4];
        return await handleGetBroadcast(env, broadcastId);
      }

      // Failed updates (DLQ) management
      if (path === "/api/admin/failed-updates" && request.method === "GET") {
        const page = parseInt(url.searchParams.get("page") || "0", 10);
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        return await handleAdminFailedUpdates(env, page, limit);
      }

      if (path === "/api/admin/failed-updates/replay" && request.method === "POST") {
        const body = await readBody(request);
        return await handleReplayFailedUpdate(env, body.id);
      }

      // Connection usage metrics
      if (path === "/api/admin/connection-usage" && request.method === "GET") {
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        return await handleAdminConnectionUsage(env, days);
      }

      // Fast / vision capability switches for global connections
      if (path === "/api/admin/connection-toggle" && request.method === "POST") {
        const body = await readBody(request);
        return await handleAdminConnectionToggle(env, userId, body);
      }

      // Route management
      if (path === "/api/admin/routes" && request.method === "GET") {
        return await handleUserRoutes(env, userId);
      }

      if (path === "/api/admin/routes" && request.method === "POST") {
        const body = await readBody(request);
        return await handleAdminCreateRoute(env, userId, body);
      }

      if (path.indexOf("/api/admin/routes/") === 0 && request.method === "DELETE") {
        const routeId = path.split("/")[4];
        return await handleAdminDeleteRoute(env, userId, routeId);
      }

      if (path.indexOf("/api/admin/routes/") === 0 && request.method === "POST") {
        const parts = path.split("/");
        const routeId = parts[4];
        const action = parts[5];
        if (!action) return jsonError(400, "Missing route action");
        const body = await readBody(request);
        return await handleAdminRouteAction(env, userId, routeId, action, body);
      }

      // Global settings
      if (path === "/api/admin/settings" && request.method === "GET") {
        return await handleAdminSettings(env);
      }

      if (path === "/api/admin/settings" && request.method === "POST") {
        const body = await readBody(request);
        return await handleAdminUpdateSettings(env, userId, body);
      }
    }

    return jsonError(404, "Not found");
  } catch (err) {
    // A handler threw instead of returning a Response: answer JSON rather than
    // letting the runtime emit an opaque 500.
    console.error("Mini App API unhandled error [" + path + "]:", err && err.message);
    return jsonError(500, "Internal error");
  }
}
