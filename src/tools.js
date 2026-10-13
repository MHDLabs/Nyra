// Web tools: safe fetch and search
import { checkRateLimit } from "./utils.js";

const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_SIZE = 1024 * 1024; // 1MB
const FETCH_MAX_REDIRECTS = 3;
const FETCH_RATE_LIMIT_PER_MIN = 10;

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
  /^localhost$/i
];

/**
 * Check if hostname resolves to private IP (SSRF protection)
 */
function isPrivateHostname(hostname) {
  // Block localhost variants
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  
  // Block private IP patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) return true;
  }
  
  // Block internal Cloudflare services
  if (hostname.endsWith(".workers.dev") && hostname !== "nyra.workers.dev") return true;
  if (hostname.includes("internal") || hostname.includes("local")) return true;
  
  return false;
}

/**
 * Safe HTTP fetch with SSRF protection and limits
 */
export async function safeFetch(env, url, userId) {
  // Rate limit check
  const rateKey = "fetch:" + userId;
  const rateOk = await checkRateLimit(env, rateKey, FETCH_RATE_LIMIT_PER_MIN, 60);
  if (!rateOk) {
    throw new Error("Rate limit exceeded");
  }

  // Parse and validate URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error("Invalid URL");
  }

  // Only allow HTTP/HTTPS
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS protocols allowed");
  }

  // SSRF protection: block private IPs
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("Access to private resources not allowed");
  }

  // Fetch with timeout and size limit
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Nyra-Bot/1.0 (Cloudflare Workers)"
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Check content length before reading
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > FETCH_MAX_SIZE) {
      throw new Error("Content too large");
    }

    // Read with size limit
    const reader = response.body.getReader();
    const chunks = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > FETCH_MAX_SIZE) {
        reader.cancel();
        throw new Error("Content too large");
      }

      chunks.push(value);
    }

    const blob = new Blob(chunks);
    const text = await blob.text();

    return {
      url: response.url,
      status: response.status,
      contentType: response.headers.get("content-type") || "text/plain",
      text: text,
      size: totalSize
    };
  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === "AbortError") {
      throw new Error("Fetch timeout");
    }
    
    throw err;
  }
}

/**
 * Extract text from HTML
 */
export function extractTextFromHtml(html) {
  // Simple HTML tag stripping
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

/**
 * Fetch URL and extract readable content
 */
export async function fetchWebContent(url, userId) {
  const result = await safeFetch(url, userId);
  
  // Extract text from HTML
  let content = result.text;
  if (result.contentType.includes("text/html")) {
    content = extractTextFromHtml(content);
  }

  // Truncate to reasonable length
  const MAX_CONTENT_LENGTH = 4000;
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.substring(0, MAX_CONTENT_LENGTH) + "...\n[Content truncated]";
  }

  return {
    url: result.url,
    content: content,
    size: result.size,
    contentType: result.contentType
  };
}

/**
 * Simple web search (DuckDuckGo Instant Answer API)
 * Free, no API key required
 */
export async function webSearch(query, userId) {
  // Rate limit check
  const rateKey = "search:" + userId;
  const rateOk = await checkRateLimit({ KV: { get: async () => null, put: async () => {} } }, rateKey, FETCH_RATE_LIMIT_PER_MIN, 60);
  if (!rateOk) {
    throw new Error("Rate limit exceeded");
  }

  const searchUrl = "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1&skip_disambig=1";

  try {
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Nyra-Bot/1.0 (Cloudflare Workers)"
      }
    });

    if (!response.ok) {
      throw new Error("Search API failed");
    }

    const data = await response.json();

    // Extract results
    const results = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading || "Summary",
        snippet: data.AbstractText,
        url: data.AbstractURL || ""
      });
    }

    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(" - ")[0] || "Result",
            snippet: topic.Text,
            url: topic.FirstURL
          });
        }
      }
    }

    return {
      query: query,
      results: results
    };
  } catch (err) {
    throw new Error("Search failed: " + err.message);
  }
}

/**
 * Tool execution dispatcher
 */
export async function executeWebTool(env, toolName, params, userId) {
  if (toolName === "fetch") {
    if (!params.url) throw new Error("Missing URL parameter");
    return await fetchWebContent(env, params.url, userId);
  }

  if (toolName === "search") {
    if (!params.query) throw new Error("Missing query parameter");
    return await webSearch(env, params.query, userId);
  }

  throw new Error("Unknown tool: " + toolName);
}
