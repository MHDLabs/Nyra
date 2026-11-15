import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  asTelegramId,
  parseLocale,
  parseMemoryMode,
  nonEmptyString,
  parseJsonUnknown,
  parseCallbackParts,
  requireTelegramId,
  requireNonEmptyString
} from "../src/core/validate.ts";
import {
  isRetryableAppError,
  providerAppError,
  fromUnknown,
  errorLogLine,
  databaseError
} from "../src/core/errors.ts";
import { ok, err } from "../types/errors.ts";

describe("domain validators", () => {
  it("asTelegramId accepts safe integers and numeric strings", () => {
    assert.equal(asTelegramId(7141112393), 7141112393);
    assert.equal(asTelegramId("42"), 42);
    assert.equal(asTelegramId("nope"), null);
    assert.equal(asTelegramId(3.14), null);
  });

  it("parseLocale maps fa* to fa-IR and defaults to en-US", () => {
    assert.equal(parseLocale("fa-IR"), "fa-IR");
    assert.equal(parseLocale("fa"), "fa-IR");
    assert.equal(parseLocale("en-US"), "en-US");
    assert.equal(parseLocale(null), "en-US");
  });

  it("parseMemoryMode accepts known modes only", () => {
    assert.equal(parseMemoryMode("minimal"), "minimal");
    assert.equal(parseMemoryMode("weird"), "normal");
  });

  it("nonEmptyString trims and caps length", () => {
    assert.equal(nonEmptyString("  hi  "), "hi");
    assert.equal(nonEmptyString("   "), null);
    assert.equal(nonEmptyString("abcdef", 3), "abc");
  });

  it("parseJsonUnknown never throws", () => {
    const good = parseJsonUnknown("{\"a\":1}");
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.value, { a: 1 });
    const bad = parseJsonUnknown("{");
    assert.equal(bad.ok, false);
  });

  it("parseCallbackParts splits and rejects empty", () => {
    const r = parseCallbackParts("adm:users");
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, ["adm", "users"]);
    assert.equal(parseCallbackParts("").ok, false);
  });

  it("require* helpers return Result", () => {
    assert.equal(requireTelegramId(1).ok, true);
    assert.equal(requireTelegramId("x").ok, false);
    assert.equal(requireNonEmptyString("ok", "name").ok, true);
    assert.equal(requireNonEmptyString("  ", "name").ok, false);
  });
});

describe("AppError helpers", () => {
  it("providerAppError sets retryable from category", () => {
    const e = providerAppError("timeout", "timed out");
    assert.equal(e.kind, "provider");
    assert.equal(isRetryableAppError(e), true);
    const auth = providerAppError("invalid_key", "bad key");
    assert.equal(isRetryableAppError(auth), false);
  });

  it("fromUnknown maps Error and preserves AppError", () => {
    const e = fromUnknown(new Error("boom"));
    assert.equal(e.kind, "internal");
    const original = databaseError("db down", true);
    assert.equal(fromUnknown(original).kind, "database");
  });

  it("errorLogLine is stable and free of secrets", () => {
    const line = errorLogLine(providerAppError("rate_limited", "slow down"));
    assert.match(line, /provider/);
    assert.match(line, /rate_limited/);
    assert.equal(line.includes("sk-"), false);
  });

  it("Result ok/err discriminates", () => {
    const a = ok(1);
    const b = err({ kind: "validation" as const, message: "no" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
  });
});
