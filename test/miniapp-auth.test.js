import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateInitData } from "../src/miniapp/auth.js";

const BOT_TOKEN = "123456:TEST-bot-token-for-unit-tests";

/**
 * Build a real Telegram `initData` query string, signing it exactly the way
 * Telegram does: HMAC-SHA256 over the newline-joined, key-sorted parameters
 * with the key derived from `HMAC_SHA256("WebAppData", botToken)`.
 */
function buildInitData(opts) {
  const o = opts || {};
  const token = o.botToken || BOT_TOKEN;
  const authDate = o.authDate !== undefined ? o.authDate : Math.floor(Date.now() / 1000);
  const user = o.user !== undefined
    ? o.user
    : { id: 7141112393, first_name: "Mahdi", username: "mahdi", language_code: "fa" };

  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", "AAF_test_query_id");
  if (user !== null) params.set("user", typeof user === "string" ? user : JSON.stringify(user));

  const dataCheckString = Array.from(params.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", o.hash !== undefined ? o.hash : hash);

  return params.toString();
}

test("validateInitData accepts a correctly signed payload", () => {
  const result = validateInitData(buildInitData(), BOT_TOKEN);
  assert.ok(result, "expected a validated payload");
  assert.equal(result.userId, 7141112393);
  assert.equal(result.firstName, "Mahdi");
  assert.equal(result.username, "mahdi");
  assert.equal(result.languageCode, "fa");
  assert.ok(result.authDate > 0);
});

test("validateInitData rejects a tampered hash", () => {
  assert.equal(validateInitData(buildInitData({ hash: "0".repeat(64) }), BOT_TOKEN), null);
});

test("validateInitData rejects a payload signed with a different bot token", () => {
  const foreign = buildInitData({ botToken: "999:someone-elses-bot" });
  assert.equal(validateInitData(foreign, BOT_TOKEN), null);
});

test("validateInitData rejects data mutated after signing", () => {
  // The signature covers `query_id`; changing it must invalidate the payload
  // even though the hash field itself is untouched.
  const signed = buildInitData();
  const tampered = signed.replace("AAF_test_query_id", "AAF_attacker_id");
  assert.notEqual(tampered, signed);
  assert.equal(validateInitData(tampered, BOT_TOKEN), null);
});

test("validateInitData rejects stale auth_date beyond the 1 hour bound", () => {
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  assert.equal(validateInitData(buildInitData({ authDate: twoHoursAgo }), BOT_TOKEN), null);

  // ...and still accepts a timestamp inside the window.
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  assert.ok(validateInitData(buildInitData({ authDate: tenMinutesAgo }), BOT_TOKEN));
});

test("validateInitData rejects missing hash, missing user and empty input", () => {
  const noHash = buildInitData().replace(/&hash=[0-9a-f]+/, "");
  assert.equal(validateInitData(noHash, BOT_TOKEN), null);
  assert.equal(validateInitData(buildInitData({ user: null }), BOT_TOKEN), null);
  assert.equal(validateInitData("", BOT_TOKEN), null);
  assert.equal(validateInitData(null, BOT_TOKEN), null);
  assert.equal(validateInitData(undefined, BOT_TOKEN), null);
});

test("validateInitData returns null when the bot token is absent", () => {
  assert.equal(validateInitData(buildInitData(), ""), null);
  assert.equal(validateInitData(buildInitData(), undefined), null);
});
