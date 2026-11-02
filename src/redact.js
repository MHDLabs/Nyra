// Nyra — secret redaction for logs and diagnostics.
//
// Nothing in this module is allowed to depend on bindings, other modules or the
// network: it is imported by request handlers, error paths and tests alike.
//
// The contract:
//   redactSecrets(text, opts?)      -> a string safe to log (never throws)
//   redactValue(value, opts?)       -> a deep, redacted copy of a log payload
//   safeErrorDetail(err, opts?)     -> { category, status, providerType,
//                                       providerCode, redactedMessage }
//   detectSecretKinds(text, opts?)  -> ["bot_token", ...] (for tests/assertions)
//   containsSecret(text, opts?)     -> boolean
//
// Redaction is intentionally over-approximate: losing part of a log line is
// always cheaper than writing a credential or an admin Telegram ID somewhere it
// can be read. The replacement is always the literal "[REDACTED]".
export const REDACTED = "[REDACTED]";
export const MAX_DETAIL_LENGTH = 300;

// Ordered: specific credential shapes first, then generic long tokens. The
// header/env rules run before the generic long-token rule so the key name is
// preserved in the redacted output ("Authorization: [REDACTED]").
const RULES = [
  // Telegram bot token: 123456789:AA... (25+ chars after the colon).
  { kind: "bot_token", re: /\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, replace: REDACTED },

  // Authorization header / JSON field, "Bearer <token>", and common secret
  // environment assignments. The value is replaced wholesale.
  {
    kind: "authorization_header",
    re: /(\bauthorization\b\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:(?:Bearer|Basic|Token)\s+)?[^\s,;]+)/gi,
    replace: "$1" + REDACTED
  },
  {
    kind: "bearer_token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "Bearer " + REDACTED
  },
  {
    kind: "init_data",
    re: /(\bx-init-data\b\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: "$1" + REDACTED
  },
  {
    kind: "init_data",
    re: /(\binit_?data\b\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: "$1" + REDACTED
  },
  {
    kind: "env_secret",
    re: /(\b(?:TELEGRAM_BOT_TOKEN|TELEGRAM_SECRET|ENCRYPTION_KEY|ADMIN_IDS|API_KEY|APIKEY|SECRET|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|PRIVATE_KEY|SESSION_TOKEN)\b\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: "$1" + REDACTED
  },

  // Provider/cloud key prefixes.
  { kind: "api_key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { kind: "api_key", re: /\bgsk_[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { kind: "api_key", re: /\bAIza[0-9A-Za-z_-]{10,}/g, replace: REDACTED },
  { kind: "api_key", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, replace: REDACTED },
  { kind: "api_key", re: /\bxapp-[A-Za-z0-9-]{8,}/g, replace: REDACTED },
  { kind: "api_key", re: /\bhf_[A-Za-z0-9]{20,}/g, replace: REDACTED },

  // JSON Web Tokens.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replace: REDACTED },

  // Long base64 (ENCRYPTION_KEY is 44 chars) and long hex (HMAC-SHA256 hex is
  // 64 chars). 40+ keeps short ids/fingerprints readable.
  { kind: "base64_secret", re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replace: REDACTED },
  { kind: "hex_secret", re: /\b[0-9a-fA-F]{40,}\b/g, replace: REDACTED }
];

function adminIdsFrom(opts) {
  const o = opts || {};
  let ids = [];
  if (Array.isArray(o.adminIds)) ids = o.adminIds;
  else if (o.env && o.env.ADMIN_IDS) ids = String(o.env.ADMIN_IDS).split(",");
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = String(ids[i] === null || ids[i] === undefined ? "" : ids[i]).trim();
    if (/^\d{1,20}$/.test(raw)) out.push(raw);
  }
  return out;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub secrets from a string. Never throws: a non-string is stringified, and
 * any internal failure returns a fully redacted placeholder rather than the raw
 * input.
 *
 * @param {*} text
 * @param {{ adminIds?: Array<string|number>, env?: object }} [opts]
 * @returns {string}
 */
export function redactSecrets(text, opts) {
  try {
    if (text === null || text === undefined) return "";
    let out = typeof text === "string" ? text : String(text);
    for (let i = 0; i < RULES.length; i++) {
      out = out.replace(RULES[i].re, RULES[i].replace);
    }
    const adminIds = adminIdsFrom(opts);
    for (let i = 0; i < adminIds.length; i++) {
      const pattern = new RegExp("(?<!\\d)" + escapeRegex(adminIds[i]) + "(?!\\d)", "g");
      out = out.replace(pattern, REDACTED);
    }
    return out;
  } catch (err) {
    return REDACTED;
  }
}

const SENSITIVE_KEY_RE = /^(?:password|passwd|secret|client_secret|api_?key|apikey|access_?token|refresh_?token|session_?token|authorization|bearer|cookie|set-cookie|encrypted_key|key_iv|private_?key|init_?data|x-init-data|telegram_bot_token|telegram_secret|encryption_key|admin_ids)$/i;

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ""));
}

/**
 * Deep-redact an object/array/value for logging. Plain objects and arrays are
 * copied (never mutated); sensitive keys have their value replaced wholesale;
 * Errors become { name, message, category?, status? } with the message redacted.
 * Depth is bounded so a cyclic/absurd payload cannot hang a request.
 */
export function redactValue(value, opts, depth) {
  const level = typeof depth === "number" ? depth : 0;
  if (level > 6) return "[depth-limit]";
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactSecrets(value, opts);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (value instanceof Error) {
      return {
        name: redactSecrets(value.name || "Error", opts),
        message: redactSecrets(value.message || "", opts),
        category: value.category ? redactSecrets(String(value.category), opts) : undefined,
        status: Number.isFinite(Number(value.status)) ? Number(value.status) : undefined
      };
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length && i < 100; i++) out.push(redactValue(value[i], opts, level + 1));
      return out;
    }
    if (typeof value === "object") {
      const out = {};
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length && i < 100; i++) {
        const key = keys[i];
        out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value[key], opts, level + 1);
      }
      return out;
    }
    return redactSecrets(String(value), opts);
  } catch (err) {
    return REDACTED;
  }
}

function safeToken(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(text)) return null;
  return text;
}

/**
 * The only shape error detail may take in a log or an admin diagnostic. It
 * deliberately carries no stack, no raw provider body, no request URL and no
 * credential; the message is redacted and truncated.
 *
 * @returns {{category: string, status: number|null, providerType: string|null,
 *            providerCode: string|null, redactedMessage: string}}
 */
export function safeErrorDetail(err, opts) {
  const category = (err && safeToken(err.category)) || (err && safeToken(err.code)) || "unknown";
  const statusNum = err ? Number(err.status) : NaN;
  const status = Number.isFinite(statusNum) && statusNum >= 100 && statusNum <= 599 ? Math.trunc(statusNum) : null;
  const providerType = (err && safeToken(err.providerType)) || null;
  const providerCode = (err && safeToken(err.providerCode)) || null;
  let rawMessage = "";
  if (err) {
    if (typeof err === "string") rawMessage = err;
    else if (err.providerMessage !== null && err.providerMessage !== undefined) rawMessage = String(err.providerMessage);
    else if (err.message !== null && err.message !== undefined) rawMessage = String(err.message);
  }
  const redactedMessage = redactSecrets(rawMessage, opts).slice(0, MAX_DETAIL_LENGTH);
  return { category: category, status: status, providerType: providerType, providerCode: providerCode, redactedMessage: redactedMessage };
}

/** One-line, log-safe rendering of a caught error. Never throws. */
export function formatErrorForLog(context, err, opts) {
  try {
    const detail = safeErrorDetail(err, opts);
    const bits = [String(context || "error"), detail.category];
    if (detail.status !== null) bits.push("status=" + detail.status);
    if (detail.providerType) bits.push("type=" + detail.providerType);
    if (detail.providerCode) bits.push("code=" + detail.providerCode);
    const head = bits.join(" ");
    return detail.redactedMessage ? head + " — " + detail.redactedMessage : head;
  } catch (err2) {
    return REDACTED;
  }
}

/** Names of the secret shapes present in a string (empty when clean). */
export function detectSecretKinds(text, opts) {
  const found = [];
  if (text === null || text === undefined) return found;
  const source = typeof text === "string" ? text : String(text);
  for (let i = 0; i < RULES.length; i++) {
    const re = new RegExp(RULES[i].re.source, RULES[i].re.flags);
    if (re.test(source) && found.indexOf(RULES[i].kind) === -1) found.push(RULES[i].kind);
  }
  const adminIds = adminIdsFrom(opts);
  for (let i = 0; i < adminIds.length; i++) {
    const pattern = new RegExp("(?<!\\d)" + escapeRegex(adminIds[i]) + "(?!\\d)");
    if (pattern.test(source)) { found.push("admin_id"); break; }
  }
  return found;
}

/** True when redactSecrets would change the string. */
export function containsSecret(text, opts) {
  return detectSecretKinds(text, opts).length > 0;
}
