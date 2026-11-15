// Deterministic security/parser tests for src/websearch.ts.
// Live network coverage is gated behind NYRA_WEBSEARCH_LIVE=1.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  searchWeb,
  isWebSearchAvailable,
  __websearchTest as T
} from "../src/websearch.js";
import { isWebSearchConfigured, configuredToolDefinitions } from "../src/tools.js";

const originalFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("web search is always available without any API key", () => {
  assert.equal(isWebSearchAvailable(), true);
  assert.equal(isWebSearchConfigured({}), true);
  assert.equal(isWebSearchConfigured(null), true);
  const tools = configuredToolDefinitions("openai-compatible", {});
  assert.ok(tools.some((t) => t.function && t.function.name === "web_search"));
});

test("searchWeb rejects empty query", async () => {
  await assert.rejects(() => searchWeb(""), /empty/i);
  await assert.rejects(() => searchWeb("   "), /empty/i);
});

// ─── URL validation ──────────────────────────────────────────────────────────

test("isSafeHttpUrl accepts only http(s)", () => {
  assert.equal(T.isSafeHttpUrl("https://example.com/a"), true);
  assert.equal(T.isSafeHttpUrl("http://example.com"), true);
  assert.equal(T.isSafeHttpUrl(""), false);
  assert.equal(T.isSafeHttpUrl("   "), false);
  assert.equal(T.isSafeHttpUrl("not a url"), false);
  assert.equal(T.isSafeHttpUrl("//example.com"), false);
  assert.equal(T.isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(T.isSafeHttpUrl("data:text/html,hi"), false);
  assert.equal(T.isSafeHttpUrl("vbscript:msgbox"), false);
  assert.equal(T.isSafeHttpUrl("file:///etc/passwd"), false);
  assert.equal(T.isSafeHttpUrl("blob:https://x"), false);
  assert.equal(T.isSafeHttpUrl("ftp://files.example.com"), false);
  assert.equal(T.isSafeHttpUrl("https://example.com/" + "a".repeat(2000)), true);
});

// ─── HTML entity / stripTags ─────────────────────────────────────────────────

test("stripTags removes markup and decodes entities", () => {
  assert.equal(T.stripTags("<b>hi</b>"), "hi");
  assert.equal(T.stripTags("a &amp; b"), "a & b");
  assert.equal(T.stripTags("&#39;x&#x27;"), "'x'");
  assert.equal(T.stripTags("&lt;script&gt;"), "");
  assert.equal(T.stripTags("<a>nested <b>x</b></a>"), "nested x");
  assert.ok(T.stripTags("سلام <em>دنیا</em>").includes("سلام"));
});

test("normalizeItem rejects unsafe schemes and empty titles", () => {
  assert.equal(T.normalizeItem({ title: "t", url: "javascript:evil" }, "Bing"), null);
  assert.equal(T.normalizeItem({ title: "", url: "https://ok.com" }, "Bing"), null);
  const ok = T.normalizeItem(
    { title: "<b>Title</b>", url: "https://ok.com/path", snippet: "<i>snip</i>" },
    "DuckDuckGo"
  );
  assert.equal(ok.title, "Title");
  assert.equal(ok.snippet, "snip");
  assert.equal(ok.source, "DuckDuckGo");
});

// ─── DuckDuckGo fixtures ─────────────────────────────────────────────────────

test("extractDuckDuckGoResults parses uddg and plain https", () => {
  const encoded = encodeURIComponent("https://example.com/page");
  const html = `
<div class="result results_links">
  <h2 class="result__title"><a>Example <b>Title</b></a></h2>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=${encoded}">link</a>
  <a class="result__snippet">Hello &amp; world</a>
<div class="clear"></div>
<div class="result results_links">
  <h2 class="result__title"><a>Direct</a></h2>
  <a class="result__a" href="https://direct.example/">d</a>
  <a class="result__snippet">snip</a>
<div class="clear"></div>
<div class="result results_links">
  <h2 class="result__title"><a>Bad</a></h2>
  <a class="result__a" href="javascript:alert(1)">x</a>
  <a class="result__snippet">nope</a>
<div class="clear"></div>`;
  const items = T.extractDuckDuckGoResults(html);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://example.com/page");
  assert.equal(items[0].title, "Example Title");
  assert.ok(items[0].snippet.includes("Hello"));
  assert.equal(items[1].url, "https://direct.example/");
});

test("extractDuckDuckGoResults ignores invalid percent encoding in uddg", () => {
  const html = `
<div class="result results_links">
  <h2 class="result__title"><a>Broken</a></h2>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=%E0%A4%A">x</a>
  <a class="result__snippet">s</a>
<div class="clear"></div>`;
  // Invalid encoding → empty url → dropped
  const items = T.extractDuckDuckGoResults(html);
  assert.equal(items.length, 0);
});

// ─── Bing fixtures ───────────────────────────────────────────────────────────

test("extractBingRealUrl decodes a1 base64 destinations", () => {
  const dest = "https://news.example/story";
  const b64 = Buffer.from(dest, "utf8").toString("base64");
  const bing = "https://www.bing.com/ck/a?u=a1" + b64;
  assert.equal(T.extractBingRealUrl(bing), dest);
  assert.equal(T.extractBingRealUrl("https://plain.example/"), "https://plain.example/");
  // invalid base64 keeps original; may still pass isSafeHttpUrl as bing.com link
  const bad = "https://www.bing.com/ck/a?u=a1!!!";
  assert.equal(T.extractBingRealUrl(bad), bad);
});

test("extractBingResults parses b_algo blocks and drops unsafe urls", () => {
  const html = `
<li class="b_algo"><h2><a href="https://bing-result.example/a">Title A</a></h2>
<div class="b_caption"><p>Snippet &lt;ok&gt;</p></div></li>
<li class="b_algo"><h2><a href="javascript:evil">Bad</a></h2>
<div class="b_caption"><p>nope</p></div></li>`;
  const items = T.extractBingResults(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://bing-result.example/a");
  assert.equal(items[0].title, "Title A");
  assert.ok(!items[0].snippet.includes("<"));
});

// ─── Mocked parallel search ──────────────────────────────────────────────────

function ddgHtml(title, href, snip) {
  return `<div class="result results_links">
  <h2 class="result__title"><a>${title}</a></h2>
  <a class="result__a" href="${href}">l</a>
  <a class="result__snippet">${snip}</a>
<div class="clear"></div>`;
}

test("searchWeb merges engines, dedupes URLs, and tolerates one failure", async () => {
  const ddgBody =
    ddgHtml("DDG One", "https://shared.example/page", "a") +
    ddgHtml("DDG Two", "https://ddg-only.example/", "b");
  const bingBody = `
<li class="b_algo"><h2><a href="https://shared.example/page">Bing Shared</a></h2>
<div class="b_caption"><p>shared</p></div></li>
<li class="b_algo"><h2><a href="https://bing-only.example/">Bing Only</a></h2>
<div class="b_caption"><p>only</p></div></li>`;

  globalThis.fetch = async (input) => {
    const u = String(input);
    if (u.includes("duckduckgo")) {
      return new Response(ddgBody, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (u.includes("bing.com")) {
      return new Response(bingBody, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const data = await searchWeb("cloudflare");
    assert.equal(data.query, "cloudflare");
    assert.ok(data.results.length >= 2);
    assert.ok(data.results.length <= T.MAX_RESULTS);
    const urls = data.results.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(data.engines.includes("DuckDuckGo") || data.engines.includes("Bing"));
  } finally {
    restoreFetch();
  }
});

test("searchWeb returns Bing results when DuckDuckGo fails", async () => {
  globalThis.fetch = async (input) => {
    const u = String(input);
    if (u.includes("duckduckgo")) throw new Error("network");
    if (u.includes("bing.com")) {
      const body = `<li class="b_algo"><h2><a href="https://only-bing.example/">B</a></h2>
<div class="b_caption"><p>ok</p></div></li>`;
      return new Response(body, { status: 200 });
    }
    return new Response("", { status: 500 });
  };
  try {
    const data = await searchWeb("test");
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].source, "Bing");
    assert.deepEqual(data.engines, ["Bing"]);
  } finally {
    restoreFetch();
  }
});

test("searchWeb returns empty results when both engines fail", async () => {
  globalThis.fetch = async () => {
    throw new Error("down");
  };
  try {
    const data = await searchWeb("test");
    assert.deepEqual(data.results, []);
    assert.deepEqual(data.engines, []);
  } finally {
    restoreFetch();
  }
});

test("searchWeb discards oversize HTML bodies", async () => {
  const huge = "x".repeat(T.MAX_HTML_CHARS + 10);
  globalThis.fetch = async () => new Response(huge, { status: 200 });
  try {
    const data = await searchWeb("big");
    assert.deepEqual(data.results, []);
  } finally {
    restoreFetch();
  }
});

// Live integration (optional)
test(
  "searchWeb returns structured results for a live query",
  { skip: process.env.NYRA_WEBSEARCH_LIVE !== "1" },
  async () => {
    const data = await searchWeb("Cloudflare Workers");
    assert.equal(data.query, "Cloudflare Workers");
    assert.ok(Array.isArray(data.results));
    assert.ok(Array.isArray(data.engines));
    if (data.results.length > 0) {
      const r = data.results[0];
      assert.ok(r.title);
      assert.match(r.url, /^https?:\/\//);
      assert.ok(r.source === "DuckDuckGo" || r.source === "Bing");
    }
  }
);
