// Webhook fast path: decides whether an update can skip the queue entirely.
import { getUser, resolveUserActiveConnection } from "../db.js";

// If the sender's resolved model is marked fast, run the AI pipeline inline from
// the webhook request instead of enqueuing it. This skips the queue consumer's
// batch window (up to max_batch_timeout) plus the extra hop, so a high-speed API
// answers immediately. Falls back to "not fast" on any lookup error.
export async function isFastMessage(env, from) {
  try {
    const user = await getUser(env, from.id);
    if (!user) return false;
    const resolved = await resolveUserActiveConnection(env, user);
    return !!(resolved.connection && resolved.connection.is_fast === 1);
  } catch (err) {
    return false;
  }
}
