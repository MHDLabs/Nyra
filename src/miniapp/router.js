// The Mini App's HTTP surface: one flat route table over `pathname`, with a
// single authentication gate (and a separate admin gate) applied before any
// handler runs. Kept as one table so the API contract is readable in one
// place — the handlers themselves are grouped by domain in sibling files.
import { isAdmin } from "../utils.js";
import { extractInitData, handleAuth } from "./auth.js";
import { handleUserProfile, handleUserStats, handleChatMessage, handleUserConnections, handleSetActiveConnection, handleToggleCodingMode } from "./user.js";
import { handlePersonalModels, handleCreatePersonalModel, handleDeletePersonalModel } from "./personal.js";
import { handleUserRoutes, handleAdminCreateRoute, handleAdminDeleteRoute, handleAdminRouteAction } from "./routes.js";
import { handleAdminStats, handleAdminUsers, handleAdminChats, handleAdminSettings, handleAdminUpdateSettings, handleAdminConnectionUsage } from "./admin.js";
import { handleAdminBroadcasts, handleCreateBroadcast, handleBroadcastAction, handleGetBroadcast } from "./broadcast-api.js";
import { handleAdminFailedUpdates, handleReplayFailedUpdate } from "./dlq-api.js";

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
