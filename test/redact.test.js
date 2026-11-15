// Security regression tests for src/redact.ts.
// Fixtures use FAKE credentials only — never real project secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED,
  MAX_DETAIL_LENGTH,
  redactSecrets,
  redactValue,
  safeErrorDetail,
  formatErrorForLog,
  detectSecretKinds,
  containsSecret
} from "../src/redact.js";

const FAKE_BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const FAKE_OPENAI = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV";
const FAKE_ANTHROPIC = "sk-ant-api03-ABCDEFGHIJKLMNOP";
const FAKE_GROQ = "gsk_ABCDEFGHIJKLMNOPQRSTUV";
const FAKE_GOOGLE = "AIzaSyA-fakeGoogleKey0123456789";
const FAKE_SLACK = "xoxb-1234567890-ABCDEFGHIJ";
const FAKE_HF = "hf_abcdefghijklmnopqrstuvwxyz12";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart";
const FAKE_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij012345="; // 40+
const FAKE_HEX = "a".repeat(40);

test("redactSecrets: Telegram bot token", () => {
  const out = redactSecrets("token=" + FAKE_BOT);
  assert.ok(!out.includes(FAKE_BOT));
  assert.ok(out.includes(REDACTED));
  assert.ok(detectSecretKinds(FAKE_BOT).includes("bot_token"));
});

test("redactSecrets: authorization header and bearer", () => {
  const a = redactSecrets('Authorization: Bearer abcdefghijklmnop');
  assert.match(a, /Authorization:\s*\[REDACTED\]/i);
  const b = redactSecrets("Bearer abcdefghijklmnop");
  assert.equal(b, "Bearer " + REDACTED);
});

test("redactSecrets: init_data and x-init-data", () => {
  const a = redactSecrets("x-init-data: query_id=AA&hash=xyz");
  assert.ok(a.includes(REDACTED));
  const b = redactSecrets('initData: "user=%7B%22id%22%3A1%7D"');
  assert.ok(b.includes(REDACTED));
});

test("redactSecrets: env secret assignments", () => {
  const out = redactSecrets("TELEGRAM_SECRET=supersecretvalue123");
  assert.ok(out.includes("TELEGRAM_SECRET"));
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes("supersecretvalue123"));
});

test("redactSecrets: provider API key prefixes", () => {
  for (const key of [FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_GROQ, FAKE_GOOGLE, FAKE_SLACK, FAKE_HF]) {
    const out = redactSecrets("key=" + key);
    assert.ok(!out.includes(key), "should redact " + key.slice(0, 8));
    assert.ok(containsSecret(key));
  }
});

test("redactSecrets: JWT, long base64, long hex", () => {
  assert.ok(!redactSecrets(FAKE_JWT).includes(FAKE_JWT.split(".")[0] + "."));
  assert.ok(redactSecrets(FAKE_B64).includes(REDACTED));
  assert.ok(redactSecrets(FAKE_HEX).includes(REDACTED));
});

test("redactSecrets: admin id boundary matching", () => {
  const opts = { adminIds: ["7141112393"] };
  assert.ok(redactSecrets("user 7141112393 active", opts).includes(REDACTED));
  // Longer number containing the id as substring must not match
  const longer = "97141112393";
  assert.equal(redactSecrets("id=" + longer, opts).includes(REDACTED), false);
});

test("redactSecrets: null/undefined and non-throwing", () => {
  assert.equal(redactSecrets(null), "");
  assert.equal(redactSecrets(undefined), "");
  assert.equal(typeof redactSecrets(42), "string");
});

test("redactValue: nested object and sensitive keys", () => {
  const input = {
    user: "alice",
    api_key: FAKE_OPENAI,
    nested: { password: "secret", note: "ok" },
    list: [FAKE_BOT, 1]
  };
  const copy = JSON.parse(JSON.stringify(input));
  const out = redactValue(input);
  assert.deepEqual(input, copy); // immutability
  assert.equal(out.api_key, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.note, "ok");
  assert.ok(!JSON.stringify(out).includes(FAKE_BOT));
  assert.ok(!JSON.stringify(out).includes(FAKE_OPENAI));
});

test("redactValue: Error instances and primitives", () => {
  const err = new Error("fail with " + FAKE_BOT);
  err.category = "provider";
  err.status = 429;
  const out = redactValue(err);
  assert.equal(out.status, 429);
  assert.ok(!out.message.includes(FAKE_BOT));
  assert.equal(redactValue(true), true);
  assert.equal(redactValue(7), 7);
  assert.equal(redactValue(10n), "10");
});

test("redactValue: depth limit and array size bound", () => {
  let deep = { v: FAKE_OPENAI };
  for (let i = 0; i < 10; i++) deep = { child: deep };
  const out = redactValue(deep);
  assert.ok(JSON.stringify(out).includes("depth-limit") || !JSON.stringify(out).includes(FAKE_OPENAI));
  const arr = Array.from({ length: 120 }, (_, i) => (i === 0 ? FAKE_BOT : i));
  const red = redactValue(arr);
  assert.ok(Array.isArray(red));
  assert.ok(red.length <= 100);
});

test("redactValue: throwing getters do not leak", () => {
  const obj = {};
  Object.defineProperty(obj, "x", {
    enumerable: true,
    get() {
      throw new Error("boom " + FAKE_BOT);
    }
  });
  const out = redactValue(obj);
  assert.ok(out === REDACTED || (out && !JSON.stringify(out).includes(FAKE_BOT)));
});

test("safeErrorDetail: no stack or raw secrets", () => {
  const err = {
    message: "provider said " + FAKE_OPENAI,
    category: "rate_limit",
    status: 429,
    providerType: "openai",
    providerCode: "rate_limit_exceeded",
    stack: "Error: secret\n    at x"
  };
  const d = safeErrorDetail(err);
  assert.equal(d.category, "rate_limit");
  assert.equal(d.status, 429);
  assert.ok(!d.redactedMessage.includes(FAKE_OPENAI));
  assert.ok(d.redactedMessage.length <= MAX_DETAIL_LENGTH);
  assert.equal(d.stack, undefined);
  const badStatus = safeErrorDetail({ status: 999, message: "x" });
  assert.equal(badStatus.status, null);
});

test("formatErrorForLog: single line and non-throwing", () => {
  const line = formatErrorForLog("ai", { message: FAKE_BOT, category: "fatal", status: 500 });
  assert.ok(!line.includes(FAKE_BOT));
  assert.match(line, /fatal/);
  assert.equal(typeof formatErrorForLog(null, null), "string");
});

test("detectSecretKinds and containsSecret", () => {
  const kinds = detectSecretKinds("Bearer abcdefgh + " + FAKE_BOT);
  assert.ok(kinds.includes("bot_token") || kinds.includes("bearer_token"));
  assert.equal(containsSecret("hello world"), false);
  assert.equal(detectSecretKinds(null).length, 0);
});

test("multiple overlapping secrets in one string", () => {
  const mixed = `bot ${FAKE_BOT} key ${FAKE_OPENAI} auth Bearer tokentoken12`;
  const out = redactSecrets(mixed);
  assert.ok(!out.includes(FAKE_BOT));
  assert.ok(!out.includes(FAKE_OPENAI));
  assert.ok(!out.includes("tokentoken12"));
});
