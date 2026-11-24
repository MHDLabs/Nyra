import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("stream previews do not block model token consumption on Telegram edits", () => {
  const src = readFileSync(new URL("../src/handlers/ai-message.ts", import.meta.url), "utf8");
  const start = src.indexOf("for await (const rawEvent of streamCentralAI");
  const end = src.indexOf("} catch (e) {", start);
  assert.ok(start >= 0 && end > start);
  const streamLoop = src.slice(start, end);
  assert.match(streamLoop, /previewEditPromise = previewEditPromise/);
  assert.match(streamLoop, /\.then\(async \(\) => \{/);
  assert.match(streamLoop, /await editMessage\(env, chatId, placeholderMsgId, preview/);
  assert.match(streamLoop, /ctx\.waitUntil\?\.\(previewEditPromise\)/);
  assert.doesNotMatch(streamLoop, /await previewEditPromise;/);
  assert.match(src, /await previewEditPromise;/);
});

test("stream preview cadence is throttled to reduce Telegram edit traffic", () => {
  const src = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(src, /STREAM_EDIT_THROTTLE_MS = 1500/);
});
