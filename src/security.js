// Nyra — SSRF-safe URL validation and URL privacy helpers.
//
// Every user/admin-supplied Base URL ("endpoint") is a potential SSRF vector:
// the Worker will make authenticated outbound requests to it, and on Cloudflare
// the request can also reach internal services or cloud metadata endpoints.
// This module is the single place that decides whether a Base URL is acceptable.
// It has no imports and touches no bindings, so it is safe to use from any
// module (routing, Mini App validation) and from tests.
//
// Design rules:
//  - only absolute http(s) URLs are considered at all (a scheme-less string is
//    rejected instead of guessed; ftp/file/ws/gopher/data/javascript are out);
//  - https is required by default; `{ allowHttp: true }` exists for callers that
//    must accept a legacy http base (still subject to every host check);
//  - embedded credentials (`user:pass@`) are always rejected — a credential in a
//    URL is both a log leak and a spoofing trick;
//  - loopback, private, link-local, CGNAT, multicast, reserved and cloud
//    metadata hosts are rejected, including their IPv4/IPv6 encoded forms
//    (WHATWG URL already canonicalises decimal/octal/hex IPv4 and IPv6);
//  - single-label hostnames are rejected: on the public edge they are internal
//    names, not providers;
//  - the returned URL is normalised (lowercase canonical host, no credentials,
//    no query string, no fragment, no trailing slash) so downstream adapters
//    append their path to a stable root.
export const MAX_URL_LENGTH = 2048;

// Upper bound for the normalised URL we hand back to callers/logs.
export const MAX_LOGGED_URL_LENGTH = 300;

// Hostnames that resolve to cloud-internal metadata/control planes rather than
// to an AI provider. Matched after lowercase + trailing-dot stripping.
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc"
]);

// Suffixes used only for internal names. None is a public ICANN TLD.
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp"
];

function isDigitsOnly(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

/** Parse a canonical dotted-quad string into 4 numbers, or null. */
function parseIPv4(host) {
  if (!isDigitsOnly(host.replace(/\./g, ""))) return null;
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (let i = 0; i < 4; i++) {
    if (!isDigitsOnly(parts[i]) || parts[i].length === 0 || parts[i].length > 3) return null;
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIPv4(host) {
  const n = parseIPv4(host);
  if (!n) return false;
  const [a, b] = n;
  if (a === 0) return true;                          // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 0) return true;             // 192.0.0.0/24 + 192.0.2.0/24 docs
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51) return true;            // 198.51.100.0/24 docs
  if (a === 203 && b === 0) return true;             // 203.0.113.0/24 docs
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

/** Expand an IPv6 literal ("::ffff:7f00:1", "fd00:ec2::254") to 8 groups. */
function parseIPv6(groups) {
  const parts = groups.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 2) {
    if (head.length + tail.length > 7) return null;
  } else if (head.length !== 8) {
    return null;
  }
  const filled = [];
  for (let i = 0; i < head.length; i++) filled.push(head[i]);
  for (let i = 0; i < (8 - head.length - tail.length); i++) filled.push("0");
  for (let i = 0; i < tail.length; i++) filled.push(tail[i]);
  if (filled.length !== 8) return null;
  const nums = [];
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(filled[i])) return null;
    nums.push(parseInt(filled[i], 16));
  }
  return nums;
}

function isPrivateIPv6(host) {
  const g = parseIPv6(host);
  if (!g) return false;
  // :: (unspecified) and ::1 (loopback)
  let allZero = true;
  for (let i = 0; i < 8; i++) if (g[i] !== 0) { allZero = false; break; }
  if (allZero) return true;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
  // fc00::/7 unique local (AWS IMDS IPv6 fd00:ec2::254 is included)
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g[0] & 0xff00) === 0xff00) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    return isPrivateIPv4(v4);
  }
  // IPv4-compatible ::a.b.c.d (deprecated but still routable on some stacks)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    return isPrivateIPv4(v4);
  }
  // NAT64 64:ff9b::/96 maps an embedded IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    return isPrivateIPv4(v4);
  }
  return false;
}

function normalizeHostname(raw) {
  let host = String(raw || "").trim().toLowerCase();
  while (host.length > 1 && host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
  return host;
}

/**
 * True when the hostname can only resolve to loopback/private/link-local/
 * metadata space. Accepts a URL `hostname` (IPv6 literals keep their brackets).
 */
export function isPrivateHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") {
    return isPrivateIPv6(host.slice(1, -1));
  }
  if (isDigitsOnly(host.replace(/\./g, "")) && host.indexOf(".") !== -1) {
    return isPrivateIPv4(host);
  }
  if (METADATA_HOSTS.has(host)) return true;
  if (host === "localhost") return true;
  for (let i = 0; i < PRIVATE_SUFFIXES.length; i++) {
    const suffix = PRIVATE_SUFFIXES[i];
    if (host.length > suffix.length && host.slice(-suffix.length) === suffix) return true;
  }
  // A single-label name ("intranet", "redis", "metadata") never names a public
  // AI provider; on the edge it is internal DNS. Reject it.
  if (host.indexOf(".") === -1) return true;
  return false;
}

function isValidScheme(protocol) {
  return protocol === "https:" || protocol === "http:";
}

/**
 * Validate and normalise a Base URL.
 *
 * @param {string} raw  user-supplied URL
 * @param {{ allowHttp?: boolean }} [options]  allowHttp:false by default
 * @returns {string|null} normalised absolute URL, or null when unusable/unsafe
 *
 * Sync, dependency-free. The return value is a string so callers can write
 * `const base = validateBaseUrl(input); if (!base) reject;`.
 */
export function validateBaseUrl(raw, options) {
  const result = validateBaseUrlDetailed(raw, options);
  return result.ok ? result.url : null;
}

/**
 * Same checks as `validateBaseUrl` but returns a reason, for UI error text.
 * The reason is a stable machine token (`private_host`, `credentials`, ...),
 * never a fragment of the input, so it cannot echo a pasted secret.
 *
 * @returns {{ ok: boolean, url: string|null, reason: string|null }}
 */
export function validateBaseUrlDetailed(raw, options) {
  const opts = options || {};
  if (raw === null || raw === undefined) return { ok: false, url: null, reason: "empty" };
  const text = String(raw).trim();
  if (!text) return { ok: false, url: null, reason: "empty" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, url: null, reason: "too_long" };
  // Reject raw whitespace/control characters before URL parsing: the parser
  // would silently percent-encode some of them, hiding intent.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, url: null, reason: "invalid_url" };

  let url;
  try { url = new URL(text); } catch (err) { return { ok: false, url: null, reason: "invalid_url" }; }

  if (!isValidScheme(url.protocol)) {
    return { ok: false, url: null, reason: "unsupported_scheme" };
  }
  if (url.protocol === "http:" && opts.allowHttp !== true) {
    return { ok: false, url: null, reason: "https_required" };
  }
  if (url.username || url.password) {
    return { ok: false, url: null, reason: "credentials" };
  }
  if (!url.hostname) return { ok: false, url: null, reason: "invalid_host" };
  if (isPrivateHost(url.hostname)) {
    // Distinguish metadata for diagnostics/messages without echoing the host.
    const host = normalizeHostname(url.hostname);
    return { ok: false, url: null, reason: METADATA_HOSTS.has(host) ? "metadata_host" : "private_host" };
  }
  if (url.port === "0") return { ok: false, url: null, reason: "invalid_url" };
  if (/%00|%0d|%0a/i.test(url.pathname)) return { ok: false, url: null, reason: "invalid_url" };

  // Normalise: keep origin + path only; drop query/fragment/credentials and a
  // trailing slash so adapters append to a stable root.
  let path = url.pathname.replace(/\/{2,}/g, "/");
  path = path.replace(/\/+$/, "");
  const normalized = url.protocol + "//" + url.host + (path && path !== "/" ? path : "");
  if (normalized.length > MAX_URL_LENGTH) return { ok: false, url: null, reason: "too_long" };
  return { ok: true, url: normalized, reason: null };
}

/**
 * Produce a log-safe rendering of a URL: scheme + host + path only, length
 * capped. Credentials, query strings and fragments are dropped so an API key
 * pasted into a URL can never end up in logs. Never throws.
 */
export function safeUrlForLog(raw, maxLength) {
  const cap = typeof maxLength === "number" && maxLength > 0 ? maxLength : MAX_LOGGED_URL_LENGTH;
  try {
    const url = new URL(String(raw === null || raw === undefined ? "" : raw).trim());
    let out = url.origin + (url.pathname || "");
    out = out.replace(/\/{2,}/g, "/").replace(":/", "://");
    if (out.length > cap) out = out.slice(0, cap) + "…";
    return out;
  } catch (err) {
    return "[invalid-url]";
  }
}
