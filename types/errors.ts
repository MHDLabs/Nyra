/**
 * Application error taxonomy for Nyra.
 * Prefer structured errors at module boundaries; preserve retryability.
 */
import type { ProviderErrorCategory } from "./domain.js";

export type AppError =
  | {
      kind: "validation";
      message: string;
      field?: string;
    }
  | {
      kind: "authentication";
      message: string;
    }
  | {
      kind: "authorization";
      message: string;
    }
  | {
      kind: "database";
      message: string;
      retryable: boolean;
      cause?: unknown;
    }
  | {
      kind: "network";
      message: string;
      retryable: boolean;
      cause?: unknown;
    }
  | {
      kind: "telegram";
      message: string;
      retryable: boolean;
      statusCode?: number;
      description?: string;
      cause?: unknown;
    }
  | {
      kind: "provider";
      message: string;
      category: ProviderErrorCategory;
      retryable: boolean;
      statusCode?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    }
  | {
      kind: "internal";
      message: string;
      cause?: unknown;
    };

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
