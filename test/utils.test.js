import { test } from "node:test";
import assert from "node:assert/strict";
import { containsPhrase, constantTimeEqual, safeCallbackId, escapeHtml, truncate } from "../src/utils.js";

test("containsPhrase matches at word boundaries only", () => {
  assert.equal(containsPhrase("I love art", "art"), true);
  assert.equal(containsPhrase("ART is fun", "art"), true);
  assert.equal(containsPhrase("party tonight", "art"), false);
  assert.equal(containsPhrase("start now", "art"), false);
  assert.equal(containsPhrase("artist", "art"), false);
  assert.equal(containsPhrase("the art, then leave", "art"), true);
});

test("containsPhrase works for Persian (Unicode-aware boundaries)", () => {
  assert.equal(containsPhrase("من عاشق نیرا هستم", "نیرا"), true);
  assert.equal(containsPhrase("نیرازاده آمد", "نیرا"), false);
  assert.equal(containsPhrase("نیرا", "نیرا"), true);
});

test("containsPhrase edge inputs", () => {
  assert.equal(containsPhrase("", "art"), false);
  assert.equal(containsPhrase("art", ""), false);
  assert.equal(containsPhrase(null, "art"), false);
  assert.equal(containsPhrase("art", "art"), true);
});

test("constantTimeEqual semantics", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual(null, "x"), false);
  assert.equal(constantTimeEqual("x", undefined), false);
});

test("safeCallbackId: short ids pass through, long ids are hashed deterministically", () => {
  const short = "conn-abc";
  assert.equal(safeCallbackId(short), short);
  const long = "connection-with-a-very-long-identifier-" + "x".repeat(80);
  const a = safeCallbackId(long);
  const b = safeCallbackId(long);
  assert.equal(a, b);
  assert.notEqual(a, long);
  assert.ok(a.length <= 64);
});

test("escapeHtml escapes markup characters", () => {
  assert.equal(escapeHtml('<b attr="x">&</b>'), "&lt;b attr=&quot;x&quot;&gt;&amp;&lt;/b&gt;");
  assert.equal(escapeHtml(null), "");
});

test("truncate respects the limit", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("abcdef", 4), "a...");
  assert.equal(truncate(null, 5), "");
});
