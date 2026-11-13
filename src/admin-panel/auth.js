// Admin panel password auth. Session tokens live in KV (12h).
import { constantTimeEqual, bytesToBase64 } from "../utils.js";

const SESSION_TTL_SEC = 12 * 60 * 60;
const COOKIE_NAME = "nyra_admin_session";

export function isPanelConfigured(env) {
  return Boolean(env && String(env.ADMIN_PANEL_PASSWORD || "").trim());
}

export function getPanelPassword(env) {
  return String(env && env.ADMIN_PANEL_PASSWORD ? env.ADMIN_PANEL_PASSWORD : "").trim();
}

function sessionKey(token) {
  return "admin_sess:" + token;
}

async function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/[+/=]/g, function (c) {
    return c === "+" ? "-" : c === "/" ? "_" : "";
  });
}

export async function createSession(env) {
  if (!env.KV) throw new Error("KV_UNAVAILABLE");
  const token = await randomToken();
  await env.KV.put(sessionKey(token), JSON.stringify({ created: Date.now() }), {
    expirationTtl: SESSION_TTL_SEC
  });
  return token;
}

export async function destroySession(env, token) {
  if (!token || !env.KV) return;
  try { await env.KV.delete(sessionKey(token)); } catch (e) {}
}

export async function validateSession(env, token) {
  if (!token || !env.KV) return false;
  try {
    const raw = await env.KV.get(sessionKey(token));
    return !!raw;
  } catch (e) {
    return false;
  }
}

export function readSessionCookie(request) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.startsWith(COOKIE_NAME + "=")) {
      return decodeURIComponent(p.slice(COOKIE_NAME.length + 1));
    }
  }
  // Also accept Authorization: Bearer
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

export function sessionCookieHeader(token, maxAge, secure) {
  const age = maxAge != null ? maxAge : SESSION_TTL_SEC;
  return COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + age +
    (secure === false ? "" : "; Secure");
}

export function clearSessionCookieHeader(secure) {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" +
    (secure === false ? "" : "; Secure");
}

export function verifyPassword(env, password) {
  const expected = getPanelPassword(env);
  if (!expected) return false;
  return constantTimeEqual(String(password || ""), expected);
}

export async function requireAdminSession(env, request) {
  if (!isPanelConfigured(env)) {
    return { ok: false, response: json(503, { error: "ADMIN_PANEL_PASSWORD is not configured" }) };
  }
  const token = readSessionCookie(request);
  if (!token || !(await validateSession(env, token))) {
    return { ok: false, response: json(401, { error: "unauthorized" }) };
  }
  return { ok: true, token: token };
}

export function json(status, data, extraHeaders) {
  const headers = Object.assign({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }, extraHeaders || {});
  return new Response(JSON.stringify(data), { status: status, headers: headers });
}
