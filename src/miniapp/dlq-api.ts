// Failed-update (dead-letter) inspection and replay. Only useful because the
// queue consumer now actually persists failures — see `logFailedUpdate`.
import { listFailedUpdates, replayFailedUpdate } from "../dlq.js";
import { jsonOk, jsonError, jsonErrorFromException } from "./respond.js";

type DlqApiEnv = {
  DB: unknown;
  NYRA_QUEUE: unknown;
  ADMIN_IDS?: string | null;
  [key: string]: unknown;
};

const DEFAULT_PAGE = 0;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER;

function parseNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

function parsePositiveId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
    if (!Number.isSafeInteger(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return n;
  }
  return null;
}

/**
 * Handle admin failed updates list.
 * Page is zero-based. Default page 0, default limit 50, max limit 200.
 */
export async function handleAdminFailedUpdates(
  env: DlqApiEnv,
  page: unknown = DEFAULT_PAGE,
  limit: unknown = DEFAULT_LIMIT
): Promise<Response> {
  try {
    const pageNum = parseNonNegativeInt(page, DEFAULT_PAGE);
    const limitNum = parseNonNegativeInt(limit, DEFAULT_LIMIT);
    if (pageNum === null) return jsonError(400, "Invalid page", undefined);
    if (limitNum === null || limitNum < 1) return jsonError(400, "Invalid limit", undefined);
    const safeLimit = limitNum > MAX_LIMIT ? MAX_LIMIT : limitNum;
    if (pageNum > 0 && safeLimit > 0 && pageNum > Math.floor(MAX_SAFE_OFFSET / safeLimit)) {
      return jsonError(400, "Invalid page", undefined);
    }
    const offset = pageNum * safeLimit;
    const result = await listFailedUpdates(env as never, safeLimit, offset);
    return jsonOk(result);
  } catch (err) {
    return jsonErrorFromException(err, 500, "Failed to load failed updates", {
      env: { ADMIN_IDS: env.ADMIN_IDS || undefined }
    });
  }
}

/**
 * Handle replay failed update.
 * Accepts positive integer ids (number or digit string).
 */
export async function handleReplayFailedUpdate(env: DlqApiEnv, id: unknown): Promise<Response> {
  try {
    const recordId = parsePositiveId(id);
    if (recordId === null) return jsonError(400, "Missing id", undefined);

    const success = await replayFailedUpdate(env as never, recordId);
    if (!success) return jsonError(400, "Failed to replay update", undefined);

    return jsonOk({ success: true });
  } catch (err) {
    return jsonErrorFromException(err, 500, "Failed to replay update", {
      env: { ADMIN_IDS: env.ADMIN_IDS || undefined }
    });
  }
}
