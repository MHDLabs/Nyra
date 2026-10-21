import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForSpeech, synthesizeSpeech, isTtsEnabled } from "../src/voice/tts.js";
import { EDGE_TTS_MAX_CHARS } from "../src/config.js";

test("sanitizeForSpeech strips Markdown so it is not read aloud", () => {
  assert.equal(sanitizeForSpeech("**bold** and _italic_"), "bold and italic");
  assert.equal(sanitizeForSpeech("`code`"), "");
  assert.equal(sanitizeForSpeech("```\nblock\n```"), "");
  assert.equal(sanitizeForSpeech("[label](https://example.com)"), "label");
  assert.equal(sanitizeForSpeech("# Heading\n> quote"), "Heading quote");
  assert.equal(sanitizeForSpeech("  lots   of \n space  "), "lots of space");
  assert.equal(sanitizeForSpeech(null), "");
  assert.equal(sanitizeForSpeech(undefined), "");
});

test("sanitizeForSpeech removes control characters and caps the length", () => {
  assert.equal(sanitizeForSpeech("a\u0000b\u0007c\td"), "a b c d");
  const long = "x".repeat(EDGE_TTS_MAX_CHARS + 500);
  assert.equal(sanitizeForSpeech(long).length, EDGE_TTS_MAX_CHARS);
});

test("synthesizeSpeech refuses empty text without touching the network", async () => {
  const res = await synthesizeSpeech({}, "```\n```");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "empty_text");
});

test("synthesizeSpeech reports unsupported when WebSocket is unavailable", async () => {
  const original = globalThis.WebSocket;
  // eslint-disable-next-line no-undefined
  globalThis.WebSocket = undefined;
  try {
    const res = await synthesizeSpeech({}, "hello");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unsupported");
  } finally {
    globalThis.WebSocket = original;
  }
});

test("synthesizeSpeech never throws when the socket cannot be opened", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = function () { throw new Error("blocked"); };
  try {
    const res = await synthesizeSpeech({}, "hello");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "socket_unavailable");
  } finally {
    globalThis.WebSocket = original;
  }
});

test("synthesizeSpeech reports timeout instead of hanging", async () => {
  const original = globalThis.WebSocket;
  const originalTimeout = Date.now;
  globalThis.WebSocket = function () {
    return {
      addEventListener() {}, // never opens, never errors
      send() {},
      close() {}
    };
  };
  try {
    // Collapse the 15s ceiling so the test stays fast.
    const start = Date.now();
    Date.now = () => start + 60000;
    const res = await synthesizeSpeech({}, "hello");
    Date.now = originalTimeout;
    assert.equal(res.ok, false);
    assert.equal(res.reason, "timeout");
  } finally {
    globalThis.WebSocket = original;
    Date.now = originalTimeout;
  }
});

test("isTtsEnabled is false unless the admin explicitly turned it on", async () => {
  const make = value => ({
    DB: {
      prepare() {
        return { bind() { return this; }, async first() { return value === null ? null : { value }; } };
      }
    }
  });
  assert.equal(await isTtsEnabled(make(null)), false, "default off");
  assert.equal(await isTtsEnabled(make("0")), false);
  assert.equal(await isTtsEnabled(make("true")), true);
  assert.equal(await isTtsEnabled(make("1")), true);
});
