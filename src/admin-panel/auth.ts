// Admin panel password auth. Session tokens live in KV (12h).
import type { NyraEnv } from "../../types/env.js";
import { constantTimeEqual, bytesToBase64 } from "../utils.js";

const SESSION_TTL_SEC = 12 * 60 * 60;
const COOKIE_NAME = "nyra_admin_session";

type AdminAuthEnv = NyraEnv & {
  KV?: {
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> | void;
    get(key: string): Promise<string | null> | string | null;
    delete(key: string): Promise<void> | void;
  };
  ADMIN_PANEL_PASSWORD?: string;
};

export function isPanelConfigured(env: AdminAuthEnv | null | undefined): boolean {
  return Boolean(env && String(env.ADMIN_PANEL_PASSWORD || "").trim());
}

export function getPanelPassword(env: AdminAuthEnv | null | undefined): string {
  return String(env && env.ADMIN_PANEL_PASSWORD ? env.ADMIN_PANEL_PASSWORD : "").trim();
}

function sessionKey(token: string): string {
  return "admin_sess:" + token;
}

async function randomToken(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/[+/=]/g, function (c) {
    return c === "+" ? "-" : c === "/" ? "_" : "";
  });
}

export async function createSession(env: AdminAuthEnv): Promise<string> {
  if (!env.KV) throw new Error("KV_UNAVAILABLE");
  const token = await randomToken();
  await env.KV.put(sessionKey(token), JSON.stringify({ created: Date.now() }), {
    expirationTtl: SESSION_TTL_SEC
  });
  return token;
}

export async function destroySession(env: AdminAuthEnv, token: string | null | undefined): Promise<void> {
  if (!token || !env.KV) return;
  try {
    await env.KV.delete(sessionKey(token));
  } catch {
    /* ignore */
  }
}

export async function validateSession(env: AdminAuthEnv, token: string | null | undefined): Promise<boolean> {
  if (!token || !env.KV) return false;
  try {
    const raw = await env.KV.get(sessionKey(token));
    return !!raw;
  } catch {
    return false;
  }
}

export function readSessionCookie(request: Request): string {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.startsWith(COOKIE_NAME + "=")) {
      return decodeURIComponent(p.slice(COOKIE_NAME.length + 1));
    }
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

export function sessionCookieHeader(token: string, maxAge?: number | null, secure?: boolean): string {
  const age = maxAge != null ? maxAge : SESSION_TTL_SEC;
  return (
    COOKIE_NAME +
    "=" +
    encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
    age +
    (secure === false ? "" : "; Secure")
  );
}

export function clearSessionCookieHeader(secure?: boolean): string {
  return (
    COOKIE_NAME +
    "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" +
    (secure === false ? "" : "; Secure")
  );
}

export function verifyPassword(env: AdminAuthEnv, password: unknown): boolean {
  const expected = getPanelPassword(env);
  if (!expected) return false;
  return constantTimeEqual(String(password || ""), expected);
}

export type AdminSessionOk = { ok: true; token: string };
export type AdminSessionDenied = { ok: false; response: Response };
export type AdminSessionResult = AdminSessionOk | AdminSessionDenied;

export async function requireAdminSession(env: AdminAuthEnv, request: Request): Promise<AdminSessionResult> {
  if (!isPanelConfigured(env)) {
    return { ok: false, response: json(503, { error: "ADMIN_PANEL_PASSWORD is not configured" }) };
  }
  const token = readSessionCookie(request);
  if (!token || !(await validateSession(env, token))) {
    return { ok: false, response: json(401, { error: "unauthorized" }) };
  }
  return { ok: true, token: token };
}

export function json(
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>
): Response {
  const headers = Object.assign(
    {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    extraHeaders || {}
  );
  return new Response(JSON.stringify(data), { status: status, headers: headers });
}
