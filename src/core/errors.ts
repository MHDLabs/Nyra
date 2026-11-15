/**
 * Error construction and normalization helpers (TypeScript foundation).
 * Does not replace src/providers/errors.js yet — that migrates in Task 6.
 */
import type { ProviderErrorCategory } from "../../types/domain.js";
import type { AppError } from "../../types/errors.js";

const RETRYABLE_PROVIDER: ReadonlySet<ProviderErrorCategory> = new Set([
  "timeout",
  "network_error",
  "server_error",
  "provider_overloaded",
  "rate_limited",
  "unexpected_format",
  "empty_response"
]);

export function isRetryableAppError(error: AppError): boolean {
  switch (error.kind) {
    case "database":
    case "network":
    case "telegram":
    case "provider":
      return error.retryable;
    default:
      return false;
  }
}

export function providerAppError(
  category: ProviderErrorCategory,
  message: string,
  opts?: { statusCode?: number; retryAfterSeconds?: number; cause?: unknown }
): AppError {
  return {
    kind: "provider",
    category,
    message,
    retryable: RETRYABLE_PROVIDER.has(category),
    statusCode: opts?.statusCode,
    retryAfterSeconds: opts?.retryAfterSeconds,
    cause: opts?.cause
  };
}

export function internalError(message: string, cause?: unknown): AppError {
  return { kind: "internal", message, cause };
}

export function databaseError(message: string, retryable = true, cause?: unknown): AppError {
  return { kind: "database", message, retryable, cause };
}

/**
 * Map unknown catch values to AppError without leaking secrets.
 */
export function fromUnknown(cause: unknown, fallbackMessage = "Unexpected error"): AppError {
  if (cause && typeof cause === "object" && "kind" in cause) {
    const maybe = cause as AppError;
    if (typeof maybe.kind === "string" && typeof (maybe as { message?: unknown }).message === "string") {
      return maybe;
    }
  }
  if (cause instanceof Error) {
    return internalError(cause.message || fallbackMessage, cause);
  }
  return internalError(fallbackMessage, cause);
}

/** Safe log line — never includes tokens or raw credentials. */
export function errorLogLine(error: AppError): string {
  const base = error.kind + ": " + error.message;
  if (error.kind === "provider") {
    return base + " [" + error.category + "]" + (error.retryable ? " retryable" : "");
  }
  if ("retryable" in error) {
    return base + (error.retryable ? " retryable" : " terminal");
  }
  return base;
}
