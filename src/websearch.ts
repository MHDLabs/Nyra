// Built-in zero-key web search for Nyra.
// Adapted from Yrobot/cloudflare-search (MIT): HTML scraping of DuckDuckGo and Bing.
// No API keys required. Parallel engines with fault tolerance.

const SEARCH_TIMEOUT_MS = 7000;
const MAX_RESULTS = 8;
const MAX_HTML_CHARS = 2_000_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type WebSearchSource = "DuckDuckGo" | "Bing";

export type WebSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source: WebSearchSource;
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchItem[];
  engines: WebSearchSource[];
};

type RawSearchFields = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  description?: unknown;
  content?: unknown;
};

function decodeHtmlEntities(text: unknown): string {
  if (!text) return "";
  let s = String(text);
  // Decode non-amp entities first, then &amp; last, so we never create double-unescape pairs.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#x0*2f;/gi, "/")
    .replace(/&#(\d+);/g, function (_: string, n: string) {
      const code = parseInt(n, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_: string, h: string) {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : "";
    })
    .replace(/&amp;/gi, "&");
  return s;
}

/** Strip HTML tags until stable, then decode entities, then strip again (entity→tag). */
function stripTags(html: unknown): string {
  let s = String(html || "");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/<[^>]*>/g, " ");
  }
  s = decodeHtmlEntities(s);
  prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/<[^>]*>/g, " ");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Prefer Persian region when the query contains Persian/Arabic script. */
function duckDuckGoLocale(query: string): string {
  if (/[\u0600-\u06FF]/.test(query)) return "ir-fa";
  return "wt-wt";
}

/** Allow only http(s) URLs via the URL parser (blocks javascript:, data:, vbscript:, etc.). */
function isSafeHttpUrl(raw: unknown): boolean {
  try {
    const u = new URL(String(raw || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeItem(item: RawSearchFields, source: WebSearchSource): WebSearchItem | null {
  const title = stripTags(item.title || "").slice(0, 200);
  const url = String(item.url || "").trim().slice(0, 1000);
  const snippet = stripTags(item.snippet || item.description || item.content || "").slice(0, 700);
  if (!title || !url || !isSafeHttpUrl(url)) return null;
  return { title, url, snippet, source };
}

/** Read response text with a hard character budget; oversize bodies yield "". */
async function readTextBounded(response: Response, maxChars: number): Promise<string> {
  try {
    if (!response.body) {
      const text = await response.text();
      if (!text || text.length > maxChars) return "";
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (out.length > maxChars) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return "";
        }
      }
      out += decoder.decode();
      if (!out || out.length > maxChars) return "";
      return out;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return "";
  }
}

// ─── DuckDuckGo HTML ─────────────────────────────────────────────────────────

function extractDuckDuckGoResults(html: string): WebSearchItem[] {
  const results: WebSearchItem[] = [];
  const resultRegex =
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<div class="clear"><\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(
      /<h2[^>]*class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
    );
    const title = titleMatch ? stripTags(titleMatch[1]) : "";

    let url = "";
    const uddg = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/i
    );
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
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

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<WebSearchItem[]> {
  const params = new URLSearchParams({
    q: query,
    kl: duckDuckGoLocale(query)
  });
  const url = "https://html.duckduckgo.com/html/?" + params.toString();
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
      Referer: "https://duckduckgo.com/"
    },
    redirect: "follow",
    cache: "no-store"
  });
  if (!response.ok) return [];
  const html = await readTextBounded(response, MAX_HTML_CHARS);
  if (!html) return [];
  return extractDuckDuckGoResults(html);
}

// ─── Bing HTML ───────────────────────────────────────────────────────────────

function extractBingRealUrl(bingUrl: string): string {
  if (!bingUrl.includes("bing.com/ck/a?")) return bingUrl;
  try {
    const decoded = bingUrl.replace(/&amp;/g, "&");
    const u = new URL(decoded);
    const param = u.searchParams.get("u");
    if (!param || !param.startsWith("a1")) return bingUrl;
    const b64 = param.slice(2);
    const raw = atob(b64);
    if (/^https?:\/\//i.test(raw)) return raw;
  } catch {
    /* keep original */
  }
  return bingUrl;
}

function extractBingResults(html: string): WebSearchItem[] {
  const results: WebSearchItem[] = [];
  const resultRegex =
    /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null) {
    const url = extractBingRealUrl(match[1]);
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3]);
    const item = normalizeItem({ title, url, snippet }, "Bing");
    if (item) results.push(item);
  }
  return results;
}

async function searchBing(query: string, signal: AbortSignal): Promise<WebSearchItem[]> {
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(query) +
    "&form=QBLH&sp=-1&lq=0&sc=0-0&qs=n&sk=";
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fa;q=0.8"
    },
    redirect: "follow",
    cache: "no-store"
  });
  if (!response.ok) return [];
  const html = await readTextBounded(response, MAX_HTML_CHARS);
  if (!html) return [];
  return extractBingResults(html);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Zero-key web search. Tries DuckDuckGo and Bing in parallel; merges unique URLs.
 */
export async function searchWeb(query: unknown): Promise<WebSearchResponse> {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) throw new Error("Search query is empty");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const settled = await Promise.allSettled([
      searchDuckDuckGo(q, controller.signal),
      searchBing(q, controller.signal)
    ]);

    const seen = new Set<string>();
    const results: WebSearchItem[] = [];
    const engines: WebSearchSource[] = [];

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
      engines
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Always available — no API key required. */
export function isWebSearchAvailable(): boolean {
  return true;
}

// Test-only exports (used by deterministic unit tests; not part of the AI tool contract).
export const __websearchTest = {
  stripTags,
  decodeHtmlEntities,
  isSafeHttpUrl,
  normalizeItem,
  extractDuckDuckGoResults,
  extractBingResults,
  extractBingRealUrl,
  MAX_HTML_CHARS,
  MAX_RESULTS
};
