export function isOpenRouterUrl(baseUrl: unknown): boolean {
  if (!baseUrl) return false;
  return String(baseUrl).toLowerCase().indexOf("openrouter.ai") !== -1;
}

const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/messages", "/models"];

export function normalizeBaseUrl(provider: string, raw: unknown): string {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  } catch {
    return "";
  }
  let path = url.pathname.replace(/\/+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    const lower = path.toLowerCase();
    for (let i = 0; i < ENDPOINT_SUFFIXES.length; i++) {
      const suffix = ENDPOINT_SUFFIXES[i]!;
      if (lower.endsWith(suffix)) {
        path = path.slice(0, path.length - suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  if (!path && provider === "anthropic") path = "/v1";
  url.pathname = path || "/";
  url.search = "";
  url.hash = "";
  let out = url.toString();
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
