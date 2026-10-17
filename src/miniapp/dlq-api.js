// Failed-update (dead-letter) inspection and replay. Only useful because the
// queue consumer now actually persists failures — see `logFailedUpdate` in
// src/index.js.
import { listFailedUpdates, replayFailedUpdate } from "../dlq.js";
import { jsonOk, jsonError } from "./respond.js";

/**
 * Handle admin failed updates list
 */
export async function handleAdminFailedUpdates(env, page = 0, limit = 50) {
  try {
    const offset = page * limit;
    const result = await listFailedUpdates(env, limit, offset);
    return jsonOk(result);
  } catch (err) {
    return jsonError(500, err.message || "Failed to load failed updates");
  }
}

/**
 * Handle replay failed update
 */
export async function handleReplayFailedUpdate(env, id) {
  try {
    if (!id) return jsonError(400, "Missing id");

    const success = await replayFailedUpdate(env, id);
    if (!success) return jsonError(400, "Failed to replay update");

    return jsonOk({ success: true });
  } catch (err) {
    return jsonError(500, err.message || "Failed to replay update");
  }
}
