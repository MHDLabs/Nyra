import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMiniAppStreamOptions } from "../src/miniapp/user.js";
import { AI_STREAM_TOTAL_BUDGET_MS, AI_STREAM_STALL_TIMEOUT_MS, FAST_STREAM_BUDGET_MS, FAST_STALL_TIMEOUT_MS } from "../src/config.js";

test("Mini App sends the same generation parameters as Telegram", () => {
  assert.deepEqual(buildMiniAppStreamOptions({ is_fast: 0 }), {
    max_tokens: 2048,
    temperature: 0.7,
    totalBudgetMs: AI_STREAM_TOTAL_BUDGET_MS,
    stallTimeoutMs: AI_STREAM_STALL_TIMEOUT_MS
  });
});

test("Mini App applies the inline execution budget only to fast connections", () => {
  assert.deepEqual(buildMiniAppStreamOptions({ is_fast: 1 }), {
    max_tokens: 2048,
    temperature: 0.7,
    totalBudgetMs: FAST_STREAM_BUDGET_MS,
    stallTimeoutMs: FAST_STALL_TIMEOUT_MS
  });
  assert.deepEqual(buildMiniAppStreamOptions(null), {
    max_tokens: 2048,
    temperature: 0.7,
    totalBudgetMs: AI_STREAM_TOTAL_BUDGET_MS,
    stallTimeoutMs: AI_STREAM_STALL_TIMEOUT_MS
  });
});
