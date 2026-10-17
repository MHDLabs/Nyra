// Broadcast management over the admin API: create, list, pause/resume,
// cancel, per-broadcast delivery stats, and a recipient-count preview so an
// admin can see the blast radius before starting a campaign.
import { createBroadcast, startBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast, listBroadcasts, getBroadcast, getBroadcastStats, calculateBroadcastTargets } from "../broadcast.js";
import { jsonOk, jsonError } from "./respond.js";

const TARGET_TYPES = ["all_users", "all_chats", "active_users"];

/** Handle broadcast list. */
export async function handleAdminBroadcasts(env, page = 0) {
  try {
    const result = await listBroadcasts(env, page, 20);
    return jsonOk(result);
  } catch (err) {
    console.error("handleAdminBroadcasts failed:", err.message);
    return jsonError(500, "Failed to load broadcasts");
  }
}

/** Handle create broadcast. */
export async function handleCreateBroadcast(env, userId, body) {
  try {
    const message = body ? body.message : "";
    const targetType = body ? body.targetType : "";
    const targetFilter = body ? body.targetFilter : null;
    if (!message || !targetType) return jsonError(400, "Missing required fields");
    if (TARGET_TYPES.indexOf(targetType) === -1) return jsonError(400, "Invalid target type");
    if (String(message).length > 4096) return jsonError(400, "Message too long (max 4096 characters)");

    const result = await createBroadcast(env, userId, message, targetType, targetFilter);
    return jsonOk(result);
  } catch (err) {
    console.error("handleCreateBroadcast failed:", err.message);
    // `createBroadcast` throws "Unauthorized" for non-admins.
    const status = err.message === "Unauthorized" ? 403 : 500;
    return jsonError(status, err.message || "Failed to create broadcast");
  }
}

/** How many recipients a target selection would reach. */
export async function handleBroadcastPreview(env, body) {
  try {
    const targetType = body ? body.targetType : "";
    if (TARGET_TYPES.indexOf(targetType) === -1) return jsonError(400, "Invalid target type");
    const targets = await calculateBroadcastTargets(env, targetType, body ? body.targetFilter : null);
    return jsonOk({ count: targets.length });
  } catch (err) {
    console.error("handleBroadcastPreview failed:", err.message);
    return jsonError(500, "Failed to count recipients");
  }
}

/** Handle broadcast action (start/pause/resume/cancel). */
export async function handleBroadcastAction(env, ctx, broadcastId, action, userId) {
  try {
    let result;
    if (action === "start") {
      result = await startBroadcast(env, ctx, broadcastId, userId);
    } else if (action === "pause") {
      result = await pauseBroadcast(env, broadcastId, userId);
    } else if (action === "resume") {
      result = await resumeBroadcast(env, ctx, broadcastId, userId);
    } else if (action === "cancel") {
      result = await cancelBroadcast(env, broadcastId, userId);
    } else {
      return jsonError(400, "Invalid action");
    }
    return jsonOk(result);
  } catch (err) {
    console.error("handleBroadcastAction failed:", err.message);
    const status = err.message === "Unauthorized" ? 403
      : err.message === "Broadcast not found" ? 404
      : 400;
    return jsonError(status, err.message || "Broadcast action failed");
  }
}

/** Handle get broadcast details. */
export async function handleGetBroadcast(env, broadcastId) {
  try {
    const broadcast = await getBroadcast(env, broadcastId);
    if (!broadcast) return jsonError(404, "Broadcast not found");
    const stats = await getBroadcastStats(env, broadcastId);
    return jsonOk({ broadcast, stats });
  } catch (err) {
    console.error("handleGetBroadcast failed:", err.message);
    return jsonError(500, "Failed to load broadcast");
  }
}
