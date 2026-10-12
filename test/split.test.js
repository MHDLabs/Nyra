// Tests for splitForTelegram: the core guarantee is that no delivered chunk
// ever exceeds maxLen (Telegram rejects longer messages with HTTP 400 and the
// send path would silently drop the reply).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForTelegram } from "../src/utils.js";

const MAX = 4096;

function stripCounter(part) {
  const m = part.match(/^\[(\d+)\/(\d+)\]\n/);
  return m ? part.slice(m[0].length) : part;
}

function assertAllFit(parts, maxLen) {
  for (const p of parts) {
    assert.ok(p.length <= maxLen, `chunk length ${p.length} exceeds ${maxLen}`);
  }
}

test("empty and short input returned unchanged", () => {
  assert.deepEqual(splitForTelegram("", MAX), [""]);
  assert.deepEqual(splitForTelegram("hello world", MAX), ["hello world"]);
});

test("input of exactly maxLen is returned as-is", () => {
  const text = "y".repeat(MAX);
  assert.deepEqual(splitForTelegram(text, MAX), [text]);
});

test("hard input (no split boundaries) never exceeds maxLen and preserves content", () => {
  const text = "x".repeat(MAX * 3 + 123);
  const parts = splitForTelegram(text, MAX);
  assert.ok(parts.length >= 3);
  assertAllFit(parts, MAX);
  assert.equal(parts.map(stripCounter).join(""), text);
});

test("input one char over maxLen splits into fitting chunks", () => {
  const text = "z".repeat(MAX + 1);
  const parts = splitForTelegram(text, MAX);
  assert.ok(parts.length >= 2);
  assertAllFit(parts, MAX);
  assert.equal(parts.map(stripCounter).join(""), text);
});

test("paragraph boundaries preserved and chunks fit", () => {
  const text = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod. ").repeat(400);
  const parts = splitForTelegram(text, MAX);
  assert.ok(parts.length > 1);
  assertAllFit(parts, MAX);
  assert.equal(parts.map(stripCounter).join(""), text);
});

test("counter prefix present, correct numbering, and fits for 10+ parts", () => {
  const text = "a".repeat(MAX * 12);
  const parts = splitForTelegram(text, MAX);
  assert.ok(parts.length >= 10, `expected 10+ parts, got ${parts.length}`);
  parts.forEach((p, i) => {
    const m = p.match(/^\[(\d+)\/(\d+)\]\n/);
    assert.ok(m, `part ${i} missing counter prefix`);
    assert.equal(Number(m[1]), i + 1);
    assert.equal(Number(m[2]), parts.length);
  });
  assertAllFit(parts, MAX);
});

test("single part gets no counter prefix", () => {
  const parts = splitForTelegram("short", MAX);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], "short");
});

test("code fences crossing a split boundary still fit and stay balanced", () => {
  const code = "Intro\n\n```javascript\n" + "// a line of code\n".repeat(400) + "```\n\nOutro";
  const parts = splitForTelegram(code, MAX);
  assert.ok(parts.length > 1);
  assertAllFit(parts, MAX);
  const fences = parts.reduce((n, p) => n + (p.match(/```/g) || []).length, 0);
  assert.equal(fences % 2, 0, "code fences must stay balanced across chunks");
});

test("whitespace-only input never exceeds maxLen", () => {
  const parts = splitForTelegram(" ".repeat(MAX * 2), MAX);
  assertAllFit(parts, MAX);
});

test("unicode (Persian) content splits without exceeding maxLen", () => {
  const text = "این یک متن آزمایشی است برای بررسی تقسیم پیام. ".repeat(300);
  const parts = splitForTelegram(text, MAX);
  assert.ok(parts.length > 1);
  assertAllFit(parts, MAX);
  assert.equal(parts.map(stripCounter).join(""), text);
});
