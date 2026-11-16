// Shared Mini App response envelopes. Every endpoint answers JSON, so the
// two constructors live in one place instead of being repeated per handler.
//
// Error safety is part of the contract:
//   - `jsonError` only ever emits the public message, never a stack, a D1/SQLite
//     detail or a provider body: a caught exception's .message is sanitized and
//     server-error internals collapse to a generic message;
//   - `jsonErrorFromException` is the helper handlers should use in `catch`:
//     it logs a redacted one-line diagnostic and returns only a safe public
//     message;
//   - the public shape stays exactly `{ error: "..." }` — the Mini App frontend
//     and existing tests depend on it.
import { redactSecrets, formatErrorForLog } from "../redact.js";
import type { RedactionOptions } from "../redact.js";

export const MAX_ERROR_MESSAGE_LENGTH = 300;

// Markers that reveal internals. A 5xx body must never contain them.
const INTERNAL_MARKERS =
  /(?:D1_ERROR|SQLITE_|no such table|no such column|syntax error|constraint failed|TypeError|ReferenceError|SyntaxError|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket hang up|\bat\s+[A-Za-z_$][\w$]*\s*\(|\n\s+at\s)/i;

type MiniAppErrorOptions = RedactionOptions & {
  context?: string;
};

function defaultMessageFor(status: number): string {
  if (status === 400) return "Bad request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 429) return "Too many requests. Please slow down.";
  if (status === 503) return "Service temporarily unavailable";
  return "Internal error";
}

function normalizeStatus(status: unknown): number {
  let value: number;
  try {
    value = Number(status);
  } catch {
    return 500;
  }
  if (!Number.isInteger(value) || value < 100 || value > 599) return 500;
  return value;
}

/**
 * Make an arbitrary error message safe for a response body:
 * strings only, trimmed, no control characters, capped, secrets redacted, and
 * server-error internals replaced by the generic message for that status.
 * Never throws.
 */
export function safeErrorMessage(
  message: unknown,
  status: unknown,
  opts?: RedactionOptions | null
): string {
  const code = normalizeStatus(status);
  let text: string;
  if (typeof message === "string") text = message;
  else if (message === null || message === undefined) text = "";
  else if (typeof message === "object" || typeof message === "function") text = "";
  else text = String(message);

  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return defaultMessageFor(code);
  if (code >= 500 && (INTERNAL_MARKERS.test(text) || text.length > MAX_ERROR_MESSAGE_LENGTH)) {
    return defaultMessageFor(code);
  }
  // A stack trace in a 4xx message is still an internal leak.
  if (INTERNAL_MARKERS.test(text)) return defaultMessageFor(code);
  text = redactSecrets(text, opts);
  if (text.length > MAX_ERROR_MESSAGE_LENGTH) text = text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + "…";
  return text;
}

export function jsonOk(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * JSON error response. The body is always `{ error: "..." }`; the message is
 * sanitized (see `safeErrorMessage`), so passing `err.message` here can no
 * longer leak a SQL string, stack frame or credential into the client.
 */
export function jsonError(
  status: unknown,
  message: unknown,
  opts?: RedactionOptions | null
): Response {
  const code = normalizeStatus(status);
  return new Response(JSON.stringify({ error: safeErrorMessage(message, code, opts) }), {
    status: code,
    headers: { "Content-Type": "application/json" }
  });
}

/** Log a caught error as a redacted one-liner (no stack, no secret, no admin id). */
export function logSafeError(
  context: unknown,
  err: unknown,
  opts?: RedactionOptions | null
): void {
  try {
    console.error(formatErrorForLog(context, err, opts));
  } catch {
    console.error("logSafeError failed");
  }
}

/**
 * The catch-block helper: redacted server log + safe JSON body. Handlers should
 * prefer this over `jsonError(500, err.message)`.
 */
export function jsonErrorFromException(
  err: unknown,
  status?: number,
  publicMessage?: string,
  opts?: MiniAppErrorOptions | null
): Response {
  const options = opts || {};
  logSafeError(options.context || "Mini App API error", err, options);
  return jsonError(status === undefined ? 500 : status, publicMessage, options);
}

/** Safe structured detail for admin-only diagnostics (no stack/raw body). */
export { safeErrorDetail } from "../redact.js";
