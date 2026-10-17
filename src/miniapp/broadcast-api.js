// Broadcast management over the admin API: create, list, pause/resume,
// cancel, and per-broadcast delivery stats.
import { createBroadcast, startBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast, listBroadcasts, getBroadcast, getBroadcastStats } from "../broadcast.js";

/**
 * Handle broadcast list
 */
export async function handleAdminBroadcasts(env, page = 0) {
  const result = await listBroadcasts(env, page, 20);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Handle create broadcast
 */
export async function handleCreateBroadcast(env, userId, body) {
  try {
    const { message, targetType, targetFilter } = body;
    if (!message || !targetType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const result = await createBroadcast(env, userId, message, targetType, targetFilter);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle broadcast action (start/pause/resume/cancel)
 */
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
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle get broadcast details
 */
export async function handleGetBroadcast(env, broadcastId) {
  try {
    const broadcast = await getBroadcast(env, broadcastId);
    if (!broadcast) {
      return new Response(JSON.stringify({ error: "Broadcast not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const stats = await getBroadcastStats(env, broadcastId);
    return new Response(JSON.stringify({ broadcast, stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
