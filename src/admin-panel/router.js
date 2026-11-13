// Admin panel HTTP API — password-gated, separate from Mini App.
import { now } from "../utils.js";
import { sendMessageReturn } from "../telegram.js";
import { tg } from "../telegram.js";
import {
  isPanelConfigured, verifyPassword, createSession, destroySession,
  requireAdminSession, sessionCookieHeader, clearSessionCookieHeader,
  readSessionCookie, json
} from "./auth.js";
import {
  listPrivateChatUsers, listGroupChats, listChatMessages, logChatMessage
} from "../db/chat-logs.js";
import { blockUser, unblockUser } from "../db/users.js";
import { checkMemoryRate } from "../utils.js";

function panelHtmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer"
    }
  });
}

async function serveAsset(env, path) {
  if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
    try {
      const res = await env.ASSETS.fetch(new Request("https://panel.local" + path));
      if (res && res.status !== 404) {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "no-store");
        return new Response(res.body, { status: res.status, headers: headers });
      }
    } catch (e) {}
  }
  return null;
}

export async function routeAdminPanel(env, ctx, request, pathname) {
  const url = new URL(request.url);
  const path = pathname || url.pathname;

  // Static shell
  if (request.method === "GET" && (path === "/admin-panel" || path === "/admin-panel/" || path === "/admin-panel/index.html")) {
    const asset = await serveAsset(env, "/admin-panel/index.html");
    if (asset) return asset;
    return panelHtmlResponse("<!doctype html><title>Admin</title><p>admin-panel assets missing</p>");
  }
  if (request.method === "GET" && (path === "/admin-panel/app.js" || path === "/admin-panel/styles.css")) {
    const asset = await serveAsset(env, path);
    if (asset) return asset;
    return new Response("Not found", { status: 404 });
  }

  if (!path.startsWith("/admin-api/")) {
    return new Response("Not Found", { status: 404 });
  }

  // Auth endpoints
  if (path === "/admin-api/login" && request.method === "POST") {
    if (!isPanelConfigured(env)) return json(503, { error: "ADMIN_PANEL_PASSWORD is not configured" });
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkMemoryRate("admin_login:" + ip, 5, 60000)) return json(429, { error: "rate_limited" });
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: "invalid_json" }); }
    if (!verifyPassword(env, body && body.password)) return json(401, { error: "invalid_password" });
    try {
      const token = await createSession(env);
      const secure = url.protocol === "https:";
      return json(200, { ok: true }, { "set-cookie": sessionCookieHeader(token, null, secure) });
    } catch (e) {
      return json(503, { error: "session_store_unavailable" });
    }
  }

  if (path === "/admin-api/logout" && request.method === "POST") {
    const token = readSessionCookie(request);
    await destroySession(env, token);
    return json(200, { ok: true }, { "set-cookie": clearSessionCookieHeader() });
  }

  if (path === "/admin-api/status" && request.method === "GET") {
    return json(200, { configured: isPanelConfigured(env) });
  }

  const auth = await requireAdminSession(env, request);
  if (!auth.ok) return auth.response;

  // GET /admin-api/me
  if (path === "/admin-api/me" && request.method === "GET") {
    return json(200, { ok: true, role: "admin" });
  }

  // GET /admin-api/users
  if (path === "/admin-api/users" && request.method === "GET") {
    const rows = await listPrivateChatUsers(env, {
      q: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    return json(200, { users: rows });
  }

  // GET /admin-api/users/:id
  const userMatch = path.match(/^\/admin-api\/users\/(-?\d+)$/);
  if (userMatch && request.method === "GET") {
    const id = Number(userMatch[1]);
    const row = await env.DB.prepare(
      "SELECT telegram_id, first_name, last_name, username, preferred_name, language_code, locale, personality_id, " +
      "memory_mode, memory_data, custom_instructions, usage_stats, fallback_enabled, msg_counter, active_connection_id, " +
      "active_route_id, timezone, onboarding_completed, created_at, last_seen_at, last_inbound_at, updated_at, " +
      "proactive_enabled, proactive_threshold_hours FROM users WHERE telegram_id = ?"
    ).bind(id).first();
    if (!row) return json(404, { error: "not_found" });
    let blocked = false;
    try {
      const b = await env.DB.prepare("SELECT 1 AS x FROM blocked_users WHERE telegram_id = ?").bind(id).first();
      blocked = !!(b && b.x);
    } catch (e) {}
    let connection = null;
    if (row.active_connection_id) {
      try {
        connection = await env.DB.prepare(
          "SELECT connection_id, label, provider, model, base_url, enabled, is_global, is_default FROM ai_connections WHERE connection_id = ?"
        ).bind(row.active_connection_id).first();
      } catch (e) {}
    }
    // Never expose encrypted API keys
    return json(200, {
      user: row,
      blocked: blocked,
      connection: connection,
      memory: safeParse(row.memory_data),
      usage: safeParse(row.usage_stats)
    });
  }

  // PATCH /admin-api/users/:id
  if (userMatch && request.method === "PATCH") {
    const id = Number(userMatch[1]);
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: "invalid_json" }); }
    const sets = [];
    const binds = [];
    function setCol(col, val) { sets.push(col + " = ?"); binds.push(val); }
    if (body.preferred_name !== undefined) setCol("preferred_name", String(body.preferred_name || "").slice(0, 64));
    if (body.locale !== undefined) setCol("locale", String(body.locale || "").slice(0, 16));
    if (body.personality_id !== undefined) setCol("personality_id", String(body.personality_id || "default").slice(0, 64));
    if (body.memory_mode !== undefined) setCol("memory_mode", String(body.memory_mode || "normal").slice(0, 16));
    if (body.active_connection_id !== undefined) setCol("active_connection_id", body.active_connection_id ? String(body.active_connection_id).slice(0, 64) : null);
    if (body.timezone !== undefined) setCol("timezone", body.timezone ? String(body.timezone).slice(0, 64) : null);
    if (body.proactive_enabled !== undefined) setCol("proactive_enabled", body.proactive_enabled ? 1 : 0);
    if (body.proactive_threshold_hours !== undefined) setCol("proactive_threshold_hours", Math.min(Math.max(Number(body.proactive_threshold_hours) || 24, 1), 168));
    if (body.custom_instructions !== undefined) setCol("custom_instructions", body.custom_instructions ? String(body.custom_instructions).slice(0, 2000) : null);
    if (sets.length) {
      sets.push("updated_at = ?");
      binds.push(now());
      binds.push(id);
      await env.DB.prepare("UPDATE users SET " + sets.join(", ") + " WHERE telegram_id = ?").bind(...binds).run();
    }
    if (body.blocked === true) {
      await blockUser(env, id, 0, "admin panel");
    } else if (body.blocked === false) {
      await unblockUser(env, id);
    }
    return json(200, { ok: true });
  }

  // GET /admin-api/users/:id/messages  (private chat archive)
  const userMsgs = path.match(/^\/admin-api\/users\/(-?\d+)\/messages$/);
  if (userMsgs && request.method === "GET") {
    const id = Number(userMsgs[1]);
    const messages = await listChatMessages(env, id, {
      limit: url.searchParams.get("limit"),
      before_id: url.searchParams.get("before_id")
    });
    return json(200, { chat_id: id, chat_type: "private", messages: messages });
  }

  // GET /admin-api/users/:id/avatar
  const avatarMatch = path.match(/^\/admin-api\/users\/(-?\d+)\/avatar$/);
  if (avatarMatch && request.method === "GET") {
    const id = Number(avatarMatch[1]);
    try {
      const photos = await tg(env, "getUserProfilePhotos", { user_id: id, limit: 1 });
      if (!photos || !photos.ok || !photos.result || !photos.result.total_count) {
        return new Response(null, { status: 404 });
      }
      const sizes = photos.result.photos[0];
      const best = sizes[sizes.length - 1];
      const file = await tg(env, "getFile", { file_id: best.file_id });
      if (!file || !file.ok || !file.result || !file.result.file_path) {
        return new Response(null, { status: 404 });
      }
      const filePath = file.result.file_path;
      const tgUrl = "https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath;
      const img = await fetch(tgUrl);
      if (!img.ok) return new Response(null, { status: 404 });
      return new Response(img.body, {
        status: 200,
        headers: {
          "content-type": img.headers.get("content-type") || "image/jpeg",
          "cache-control": "private, max-age=300"
        }
      });
    } catch (e) {
      return new Response(null, { status: 404 });
    }
  }

  // GET /admin-api/groups
  if (path === "/admin-api/groups" && request.method === "GET") {
    const groups = await listGroupChats(env, {
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    return json(200, { groups: groups });
  }

  // GET /admin-api/chats/:id/messages
  const chatMsgs = path.match(/^\/admin-api\/chats\/(-?\d+)\/messages$/);
  if (chatMsgs && request.method === "GET") {
    const chatId = Number(chatMsgs[1]);
    const messages = await listChatMessages(env, chatId, {
      limit: url.searchParams.get("limit"),
      before_id: url.searchParams.get("before_id")
    });
    return json(200, { chat_id: chatId, messages: messages });
  }

  // GET /admin-api/models
  if (path === "/admin-api/models" && request.method === "GET") {
    try {
      const res = await env.DB.prepare(
        "SELECT connection_id, label, provider, model, base_url, enabled, is_global, is_default, " +
        "last_test_status, last_test_at, consecutive_failures FROM ai_connections ORDER BY is_default DESC, label ASC"
      ).all();
      return json(200, { models: res.results || [] });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // POST /admin-api/send
  if (path === "/admin-api/send" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: "invalid_json" }); }
    const text = String(body && body.text ? body.text : "").trim();
    if (!text || text.length > 4000) return json(400, { error: "invalid_text" });

    if (body.all === true) {
      // shortcut: sync fan-out capped at 50 for free-plan CPU; upgrade: reuse broadcast.js jobs
      const res = await env.DB.prepare(
        "SELECT telegram_id FROM users WHERE telegram_id NOT IN (SELECT telegram_id FROM blocked_users) LIMIT 50"
      ).all();
      const ids = (res.results || []).map(function (r) { return r.telegram_id; });
      let sent = 0, failed = 0;
      for (let i = 0; i < ids.length; i++) {
        const r = await sendMessageReturn(env, ids[i], text, { parse_mode: body.parse_mode || undefined });
        if (r && r.ok) {
          sent++;
          ctx.waitUntil(logChatMessage(env, {
            chat_id: ids[i], chat_type: "private", message_id: r.result && r.result.message_id,
            user_id: null, role: "assistant", content: text, created_at: now()
          }));
        } else {
          failed++;
          if (r && r.parameters && r.parameters.retry_after) {
            await new Promise(function (resolve) { setTimeout(resolve, Math.min(Number(r.parameters.retry_after) || 1, 5) * 1000); });
          }
        }
      }
      return json(200, { ok: true, sent: sent, failed: failed, total: ids.length, capped: true });
    }

    const target = body.telegram_id != null ? Number(body.telegram_id)
      : body.chat_id != null ? Number(body.chat_id) : NaN;
    if (!Number.isFinite(target)) return json(400, { error: "missing_target" });
    const r = await sendMessageReturn(env, target, text, { parse_mode: body.parse_mode || undefined });
    if (!r || !r.ok) return json(502, { error: "send_failed", detail: r && r.description });
    const chatType = body.chat_type === "group" || body.chat_type === "supergroup" ? body.chat_type : "private";
    await logChatMessage(env, {
      chat_id: target, chat_type: chatType, message_id: r.result && r.result.message_id,
      user_id: null, role: "assistant", content: text, created_at: now()
    });
    return json(200, { ok: true, message_id: r.result && r.result.message_id });
  }

  // GET /admin-api/stats
  if (path === "/admin-api/stats" && request.method === "GET") {
    try {
      const users = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
      const logs = await env.DB.prepare("SELECT COUNT(*) AS c FROM chat_logs").first();
      const models = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections WHERE enabled = 1").first();
      return json(200, {
        users: users && users.c || 0,
        chat_logs: logs && logs.c || 0,
        models: models && models.c || 0
      });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  return json(404, { error: "not_found" });
}

function safeParse(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
