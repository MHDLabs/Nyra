// Built-in zero-key web search for Nyra.
// Adapted from Yrobot/cloudflare-search (MIT): HTML scraping of DuckDuckGo and Bing.
// No API keys required. Parallel engines with fault tolerance.

const SEARCH_TIMEOUT_MS = 7000;
const MAX_RESULTS = 8;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeHtmlEntities(text) {
  if (!text) return "";
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** Prefer Persian region when the query contains Persian/Arabic script. */
function duckDuckGoLocale(query) {
  if (/[\u0600-\u06FF]/.test(query)) return "ir-fa";
  return "wt-wt";
}

function normalizeItem(item, source) {
  const title = stripTags(item.title || "").slice(0, 200);
  const url = String(item.url || "").trim().slice(0, 1000);
  const snippet = stripTags(item.snippet || item.description || item.content || "").slice(0, 700);
  if (!title || !url || !/^https?:\/\//i.test(url) || url.startsWith("javascript:")) return null;
  return { title, url, snippet, source };
}

// ─── DuckDuckGo HTML ─────────────────────────────────────────────────────────

function extractDuckDuckGoResults(html) {
  const results = [];
  // html.duckduckgo.com result blocks
  const resultRegex =
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<div class="clear"><\/div>/gi;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(
      /<h2[^>]*class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
    );
    const title = titleMatch ? stripTags(titleMatch[1]) : "";

    // Redirect form: //duckduckgo.com/l/?uddg=<encoded>
    let url = "";
    const uddg = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/i
    );
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch (_) {
        url = "";
      }
    }
    if (!url) {
      const plain = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i);
      if (plain) url = plain[1];
    }

    const snipMatch = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i
    );
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";

    const item = normalizeItem({ title, url, snippet }, "DuckDuckGo");
    if (item) results.push(item);
  }
  return results;
}

async function searchDuckDuckGo(query, signal) {
  const params = new URLSearchParams({
    q: query,
    kl: duckDuckGoLocale(query),
  });
  const url = "https://html.duckduckgo.com/html/?" + params.toString();
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
      Referer: "https://duckduckgo.com/",
    },
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const html = await response.text();
  if (!html || html.length > 2_000_000) return [];
  return extractDuckDuckGoResults(html);
}

// ─── Bing HTML ───────────────────────────────────────────────────────────────

function extractBingRealUrl(bingUrl) {
  if (!bingUrl.includes("bing.com/ck/a?")) return bingUrl;
  try {
    const decoded = bingUrl.replace(/&amp;/g, "&");
    const u = new URL(decoded);
    const param = u.searchParams.get("u");
    if (!param || !param.startsWith("a1")) return bingUrl;
    const b64 = param.slice(2);
    // Workers support atob
    const raw = atob(b64);
    if (/^https?:\/\//i.test(raw)) return raw;
  } catch (_) {
    /* keep original */
  }
  return bingUrl;
}

function extractBingResults(html) {
  const results = [];
  const resultRegex =
    /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    const url = extractBingRealUrl(match[1]);
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3]);
    const item = normalizeItem({ title, url, snippet }, "Bing");
    if (item) results.push(item);
  }
  return results;
}

async function searchBing(query, signal) {
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(query) +
    "&form=QBLH&sp=-1&lq=0&sc=0-0&qs=n&sk=";
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
    },
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const html = await response.text();
  if (!html || html.length > 2_000_000) return [];
  return extractBingResults(html);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Zero-key web search. Tries DuckDuckGo and Bing in parallel; merges unique URLs.
 * @param {string} query
 * @returns {Promise<{ query: string, results: Array<{title,url,snippet,source}>, engines: string[] }>}
 */
export async function searchWeb(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) throw new Error("Search query is empty");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const settled = await Promise.allSettled([
      searchDuckDuckGo(q, controller.signal),
      searchBing(q, controller.signal),
    ]);

    const seen = new Set();
    const results = [];
    const engines = [];

    for (const outcome of settled) {
      if (outcome.status !== "fulfilled" || !Array.isArray(outcome.value)) continue;
      for (const item of outcome.value) {
        if (!item || seen.has(item.url)) continue;
        seen.add(item.url);
        results.push(item);
        if (!engines.includes(item.source)) engines.push(item.source);
      }
    }

    return {
      query: q,
      results: results.slice(0, MAX_RESULTS),
      engines,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Always available — no API key required. */
export function isWebSearchAvailable() {
  return true;
}
