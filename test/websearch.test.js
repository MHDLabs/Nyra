import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWeb, isWebSearchAvailable } from "../src/websearch.js";
import { isWebSearchConfigured, configuredToolDefinitions } from "../src/tools.js";

test("web search is always available without any API key", () => {
  assert.equal(isWebSearchAvailable(), true);
  assert.equal(isWebSearchConfigured({}), true);
  assert.equal(isWebSearchConfigured(null), true);
  const tools = configuredToolDefinitions("openai-compatible", {});
  assert.ok(tools.some(t => t.function && t.function.name === "web_search"));
});

test("searchWeb rejects empty query", async () => {
  await assert.rejects(() => searchWeb(""), /empty/i);
  await assert.rejects(() => searchWeb("   "), /empty/i);
});

test("searchWeb returns structured results for a live query", async () => {
  const data = await searchWeb("Cloudflare Workers");
  assert.equal(data.query, "Cloudflare Workers");
  assert.ok(Array.isArray(data.results));
  assert.ok(Array.isArray(data.engines));
  // At least one engine should succeed in a healthy network environment
  if (data.results.length > 0) {
    const r = data.results[0];
    assert.ok(r.title);
    assert.match(r.url, /^https?:\/\//);
    assert.ok(r.source === "DuckDuckGo" || r.source === "Bing");
  }
}, { timeout: 15000 });
