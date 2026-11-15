/**
 * Boundary validators for untrusted input (Telegram, JSON, callbacks).
 * Return typed values or throw/return null — callers choose the style.
 */
import type { LocaleCode, MemoryMode, TelegramId } from "../../types/domain.js";
import type { AppError, Result } from "../../types/errors.js";
import { err, ok } from "../../types/errors.js";

const LOCALE_SET = new Set<string>(["fa-IR", "en-US"]);
const MEMORY_MODE_SET = new Set<string>(["normal", "minimal", "none"]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asTelegramId(value: unknown): TelegramId | null {
  if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

export function requireTelegramId(value: unknown, field = "telegram_id"): Result<TelegramId> {
  const id = asTelegramId(value);
  if (id === null) {
    return err({ kind: "validation", message: "Invalid Telegram id", field });
  }
  return ok(id);
}

export function parseLocale(value: unknown): LocaleCode {
  if (typeof value === "string" && LOCALE_SET.has(value)) {
    return value as LocaleCode;
  }
  if (typeof value === "string" && value.toLowerCase().startsWith("fa")) {
    return "fa-IR";
  }
  return "en-US";
}

export function parseMemoryMode(value: unknown): MemoryMode {
  if (typeof value === "string" && MEMORY_MODE_SET.has(value)) {
    return value as MemoryMode;
  }
  return "normal";
}

export function nonEmptyString(value: unknown, maxLen = 4096): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function requireNonEmptyString(
  value: unknown,
  field: string,
  maxLen = 4096
): Result<string> {
  const s = nonEmptyString(value, maxLen);
  if (s === null) {
    return err({ kind: "validation", message: "Expected non-empty string", field });
  }
  return ok(s);
}

/** Safe JSON.parse — never throws; returns unknown. */
export function parseJsonUnknown(raw: unknown): Result<unknown> {
  if (typeof raw !== "string") {
    return err({ kind: "validation", message: "JSON source must be a string", field: "json" });
  }
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch (cause) {
    return err({
      kind: "validation",
      message: "Invalid JSON",
      field: "json"
    });
  }
}

/**
 * Split Telegram callback_data "a:b:c" into parts (max 8, each ≤ 64 chars).
 */
export function parseCallbackParts(data: unknown): Result<string[]> {
  if (typeof data !== "string" || !data) {
    return err({ kind: "validation", message: "Empty callback data", field: "callback_data" });
  }
  if (data.length > 64) {
    return err({ kind: "validation", message: "callback_data too long", field: "callback_data" });
  }
  const parts = data.split(":").map((p) => p.slice(0, 64)).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return err({ kind: "validation", message: "No callback parts", field: "callback_data" });
  }
  if (parts.length > 8) {
    return err({ kind: "validation", message: "Too many callback parts", field: "callback_data" });
  }
  return ok(parts);
}

export function validationError(message: string, field?: string): AppError {
  return { kind: "validation", message, field };
}
