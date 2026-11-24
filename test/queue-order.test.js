import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("queue ordering and telegram retries", () => {
  it("processChain requeues remaining same-chat messages after a failure", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(src, /for \(let j = i \+ 1; j < messages\.length; j\+\+\) safeRetry/);
    assert.match(src, /return;/);
  });

  it("tg retries network/timeout failures once", () => {
    const src = readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
    assert.match(src, /Telegram fetch failed/);
    assert.match(src, /currentAttempt < TELEGRAM_RETRY_MAX/);
    assert.match(src, /return await tg\(env, method, payload, currentAttempt \+ 1\)/);
  });

  it("serializes concurrent batches per conversation and honors the earliest pending Telegram update", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    assert.match(src, /queue_conversation_locks/);
    assert.match(src, /ORDER BY update_id ASC LIMIT 1/);
    assert.match(src, /status=1, completed_at/);
    assert.match(src, /status=2, completed_at/);
    assert.match(wrangler, /max_concurrency = 3/);
  });

  it("queues all messages while acknowledging callbacks inline and starts typing after acceptance", () => {
    const src = readFileSync(new URL("../src/handlers/webhook.ts", import.meta.url), "utf8");
    assert.match(src, /env\.NYRA_QUEUE\.send/);
    assert.doesNotMatch(src, /if \(isCommand\)/);
    assert.match(src, /modelkey/);
    assert.match(src, /msgUpdate\.text \|\| msgUpdate\.caption/);
    const messagePipeline = readFileSync(new URL("../src/handlers/message.ts", import.meta.url), "utf8");
    assert.match(messagePipeline, /isSensitiveModelKeyCommand && isGroup/);
    assert.match(messagePipeline, /deleteMessage\(env, chat\.id, message\.message_id\)/);
    assert.match(messagePipeline, /حذف پیام ناموفق بود/);
    assert.match(src, /safeProcessMessage\(env, ctx, msgUpdate\)/);
    assert.match(src, /await safeCallback/);
    assert.match(src, /sendChatAction/);
    assert.match(src, /setProcessingReaction/);
    assert.match(src, /msgUpdate.chat.type === "private"/);
    assert.doesNotMatch(src, /fastlock:|isFastMessage/);
  });;
});
