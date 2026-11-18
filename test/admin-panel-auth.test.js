import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPanelConfigured,
  verifyPassword,
  readSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  createSession,
  validateSession,
  requireAdminSession
} from "../src/admin-panel/auth.js";

test("isPanelConfigured and verifyPassword", () => {
  assert.equal(isPanelConfigured({}), false);
  assert.equal(isPanelConfigured({ ADMIN_PANEL_PASSWORD: "  " }), false);
  assert.equal(isPanelConfigured({ ADMIN_PANEL_PASSWORD: "secret" }), true);
  assert.equal(verifyPassword({ ADMIN_PANEL_PASSWORD: "secret" }, "secret"), true);
  assert.equal(verifyPassword({ ADMIN_PANEL_PASSWORD: "secret" }, "wrong"), false);
  assert.equal(verifyPassword({ ADMIN_PANEL_PASSWORD: "secret" }, null), false);
});

test("readSessionCookie prefers Cookie then Bearer", () => {
  const fromCookie = new Request("https://example.com/", {
    headers: { Cookie: "nyra_admin_session=" + encodeURIComponent("tok-1") }
  });
  assert.equal(readSessionCookie(fromCookie), "tok-1");
  const fromBearer = new Request("https://example.com/", {
    headers: { Authorization: "Bearer tok-2" }
  });
  assert.equal(readSessionCookie(fromBearer), "tok-2");
  assert.equal(readSessionCookie(new Request("https://example.com/")), "");
});

test("session cookie headers", () => {
  assert.ok(sessionCookieHeader("abc").includes("HttpOnly"));
  assert.ok(sessionCookieHeader("abc").includes("Secure"));
  assert.ok(!sessionCookieHeader("abc", 10, false).includes("Secure"));
  assert.ok(clearSessionCookieHeader().includes("Max-Age=0"));
});

test("createSession and validateSession with KV mock", async () => {
  const store = new Map();
  const env = {
    ADMIN_PANEL_PASSWORD: "secret",
    KV: {
      async put(k, v) {
        store.set(k, v);
      },
      async get(k) {
        return store.has(k) ? store.get(k) : null;
      },
      async delete(k) {
        store.delete(k);
      }
    }
  };
  await assert.rejects(() => createSession({}), /KV_UNAVAILABLE/);
  const token = await createSession(env);
  assert.ok(token.length > 10);
  assert.equal(await validateSession(env, token), true);
  assert.equal(await validateSession(env, "nope"), false);
  const req = new Request("https://example.com/", {
    headers: { Cookie: "nyra_admin_session=" + encodeURIComponent(token) }
  });
  const ok = await requireAdminSession(env, req);
  assert.equal(ok.ok, true);
  const denied = await requireAdminSession({ ADMIN_PANEL_PASSWORD: "secret", KV: env.KV }, new Request("https://example.com/"));
  assert.equal(denied.ok, false);
  assert.equal(denied.response.status, 401);
});
