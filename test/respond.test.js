// Response envelope regression tests. Use fake credentials only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  jsonOk,
  jsonError,
  safeErrorMessage,
  jsonErrorFromException
} from "../src/miniapp/respond.js";

const FAKE_API_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV";
const FAKE_ADMIN_ID = "7141112393";

test("safeErrorMessage uses status defaults for empty and non-public values", () => {
  assert.equal(safeErrorMessage("", 400), "Bad request");
  assert.equal(safeErrorMessage(null, 401), "Unauthorized");
  assert.equal(safeErrorMessage({ message: "private" }, 403), "Forbidden");
  assert.equal(safeErrorMessage(() => "private", 404), "Not found");
});

test("safeErrorMessage normalizes invalid status values", () => {
  assert.equal(safeErrorMessage("failure", 99), "failure");
  assert.equal(safeErrorMessage("", Symbol("status")), "Internal error");
});

test("safeErrorMessage strips control characters and trims text", () => {
  assert.equal(safeErrorMessage("  bad\nrequest\u0000  ", 400), "bad request");
});

test("safeErrorMessage hides internal errors and stack details", () => {
  assert.equal(safeErrorMessage("D1_ERROR: no such table users", 500), "Internal error");
  assert.equal(safeErrorMessage("TypeError: failed\n    at handler", 400), "Bad request");
});

test("safeErrorMessage redacts credentials and caps public messages", () => {
  const safe = safeErrorMessage("Provider rejected " + FAKE_API_KEY, 502);
  assert.ok(!safe.includes(FAKE_API_KEY));
  assert.ok(safe.includes("[REDACTED]"));
  // Spaced words avoid matching the long-token redaction rules.
  const long = safeErrorMessage("ordinary words ".repeat(30), 400);
  assert.equal(long.length, MAX_ERROR_MESSAGE_LENGTH);
  assert.ok(long.endsWith("…"));
});

test("jsonOk preserves JSON response shape and status", async () => {
  const response = jsonOk({ ok: true }, 201);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});

test("jsonError preserves the public error envelope and normalizes status", async () => {
  const response = jsonError(700, "service unavailable");
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), { error: "service unavailable" });
});

test("jsonErrorFromException redacts logs and returns only the public message", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = jsonErrorFromException(
      new Error("upstream " + FAKE_API_KEY + " admin=" + FAKE_ADMIN_ID),
      500,
      "The request could not be completed",
      { context: "respond test", adminIds: [FAKE_ADMIN_ID] }
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "The request could not be completed" });
  } finally {
    console.error = originalError;
  }

  const line = logged.join("\n");
  assert.ok(line.includes("respond test"));
  assert.ok(!line.includes(FAKE_API_KEY));
  assert.ok(!line.includes(FAKE_ADMIN_ID));
});
