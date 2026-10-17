// Failed-update (dead-letter) inspection and replay. Only useful because the
// queue consumer now actually persists failures — see `logFailedUpdate` in
// src/index.js.
import { listFailedUpdates, replayFailedUpdate } from "../dlq.js";

/**
 * Handle admin failed updates list
 */
export async function handleAdminFailedUpdates(env, page = 0, limit = 50) {
  try {
    const offset = page * limit;
    const result = await listFailedUpdates(env, limit, offset);
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
 * Handle replay failed update
 */
export async function handleReplayFailedUpdate(env, id) {
  try {
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const success = await replayFailedUpdate(env, id);
    if (!success) {
      return new Response(JSON.stringify({ error: "Failed to replay update" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
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
