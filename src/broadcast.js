// Broadcast campaign system
import { now, escapeHtml, isAdmin, checkRateLimit } from "./utils.js";
import { sendMessage } from "./telegram.js";
import { getUser } from "./db.js";

const BROADCAST_RATE_LIMIT_PER_SEC = 20; // Telegram limit: 30 msg/sec, use 20 for safety
const BROADCAST_BATCH_SIZE = 50;

/**
 * Create a new broadcast campaign
 */
export async function createBroadcast(env, adminId, message, targetType, targetFilter = null) {
  if (!isAdmin(env, adminId)) {
    throw new Error("Unauthorized");
  }

  const broadcastId = crypto.randomUUID();
  const createdAt = now();

  await env.DB.prepare(`
    INSERT INTO broadcasts (
      broadcast_id, created_by, message, target_type, target_filter,
      status, total_count, sent_count, failed_count,
      created_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', 0, 0, 0, ?, NULL, NULL)
  `).bind(
    broadcastId,
    adminId,
    message,
    targetType,
    targetFilter,
    createdAt
  ).run();

  return { broadcastId: broadcastId };
}

/**
 * Get broadcast details
 */
export async function getBroadcast(env, broadcastId) {
  return await env.DB.prepare(`
    SELECT * FROM broadcasts WHERE broadcast_id = ?
  `).bind(broadcastId).first();
}

/**
 * Calculate target recipients for a broadcast
 */
export async function calculateBroadcastTargets(env, targetType, targetFilter) {
  let query;
  let params = [];

  if (targetType === "all_users") {
    query = "SELECT telegram_id FROM users WHERE enabled = 1";
  } else if (targetType === "all_chats") {
    query = "SELECT chat_id FROM chats WHERE enabled = 1 AND (chat_type = 'group' OR chat_type = 'supergroup')";
  } else if (targetType === "active_users") {
    // Users who sent a message in last 30 days
    const cutoff = now() - (30 * 24 * 60 * 60 * 1000);
    query = "SELECT DISTINCT telegram_id FROM users WHERE enabled = 1 AND updated_at > ?";
    params = [cutoff];
  } else {
    throw new Error("Invalid target type");
  }

  const result = await env.DB.prepare(query).bind(...params).all();
  return result.results || [];
}

/**
 * Start a broadcast campaign
 */
export async function startBroadcast(env, ctx, broadcastId, adminId) {
  if (!isAdmin(env, adminId)) {
    throw new Error("Unauthorized");
  }

  const broadcast = await getBroadcast(env, broadcastId);
  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  if (broadcast.status !== "draft") {
    throw new Error("Broadcast already started");
  }

  // Calculate targets
  const targets = await calculateBroadcastTargets(env, broadcast.target_type, broadcast.target_filter);
  const totalCount = targets.length;

  if (totalCount === 0) {
    throw new Error("No recipients found");
  }

  // Update status and insert recipients
  await env.DB.prepare(`
    UPDATE broadcasts 
    SET status = 'running', total_count = ?, started_at = ?
    WHERE broadcast_id = ?
  `).bind(totalCount, now(), broadcastId).run();

  // Insert recipients
  const stmt = env.DB.prepare(`
    INSERT INTO broadcast_recipients (
      broadcast_id, recipient_id, status, created_at
    ) VALUES (?, ?, 'pending', ?)
  `);

  // Insert recipients in chunks of 100 (D1 batch limit)
  const D1_BATCH_LIMIT = 100;
  for (let i = 0; i < targets.length; i += D1_BATCH_LIMIT) {
    const chunk = targets.slice(i, i + D1_BATCH_LIMIT);
    const batch = [];
    for (const target of chunk) {
      const recipientId = target.telegram_id || target.chat_id;
      batch.push(stmt.bind(broadcastId, recipientId, now()));
    }
    await env.DB.batch(batch);
  }

  // Start async processing
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(processBroadcast(env, broadcastId));
  } else {
    // For testing or when ctx not available
    processBroadcast(env, broadcastId).catch(err => {
      console.error("Broadcast processing failed:", err.message);
    });
  }

  return { totalCount: totalCount };
}

/**
 * Process broadcast campaign (async)
 */
async function processBroadcast(env, broadcastId) {
  try {
    while (true) {
      const broadcast = await getBroadcast(env, broadcastId);
      if (!broadcast) break;
      
      if (broadcast.status === "paused" || broadcast.status === "cancelled") {
        break;
      }

      // Get next batch of pending recipients
      const recipients = await env.DB.prepare(`
        SELECT recipient_id 
        FROM broadcast_recipients 
        WHERE broadcast_id = ? AND status = 'pending'
        LIMIT ?
      `).bind(broadcastId, BROADCAST_BATCH_SIZE).all();

      if (!recipients.results || recipients.results.length === 0) {
        // All sent, mark as completed
        await env.DB.prepare(`
          UPDATE broadcasts 
          SET status = 'completed', completed_at = ?
          WHERE broadcast_id = ?
        `).bind(now(), broadcastId).run();
        break;
      }

      // Send to each recipient with rate limiting
      for (const recipient of recipients.results) {
        const recipientId = recipient.recipient_id;
        
        try {
          // Rate limit check
          const rateOk = await checkRateLimit(env, "broadcast:send", BROADCAST_RATE_LIMIT_PER_SEC, 1);
          if (!rateOk) {
            // Wait and skip this iteration - will be picked up in next batch
            await new Promise(resolve => setTimeout(resolve, 50));
            break;
          }

          // Send message
          const result = await sendMessage(env, recipientId, broadcast.message, { parse_mode: "HTML" });
          
          if (result && result.ok) {
            // Mark as sent
            await env.DB.prepare(`
              UPDATE broadcast_recipients 
              SET status = 'sent', sent_at = ?
              WHERE broadcast_id = ? AND recipient_id = ?
            `).bind(now(), broadcastId, recipientId).run();

            await env.DB.prepare(`
              UPDATE broadcasts 
              SET sent_count = sent_count + 1
              WHERE broadcast_id = ?
            `).bind(broadcastId).run();
          } else {
            throw new Error("Send failed");
          }
        } catch (err) {
          // Mark as failed
          await env.DB.prepare(`
            UPDATE broadcast_recipients 
            SET status = 'failed', error_message = ?, sent_at = ?
            WHERE broadcast_id = ? AND recipient_id = ?
          `).bind(err.message, now(), broadcastId, recipientId).run();

          await env.DB.prepare(`
            UPDATE broadcasts 
            SET failed_count = failed_count + 1
            WHERE broadcast_id = ?
          `).bind(broadcastId).run();
        }
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (err) {
    console.error("Broadcast processing error:", err.message);
    
    // Mark broadcast as failed
    await env.DB.prepare(`
      UPDATE broadcasts 
      SET status = 'failed', completed_at = ?
      WHERE broadcast_id = ?
    `).bind(now(), broadcastId).run();
  }
}

/**
 * Pause a broadcast campaign
 */
export async function pauseBroadcast(env, broadcastId, adminId) {
  if (!isAdmin(env, adminId)) {
    throw new Error("Unauthorized");
  }

  const broadcast = await getBroadcast(env, broadcastId);
  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  if (broadcast.status !== "running") {
    throw new Error("Broadcast is not running");
  }

  await env.DB.prepare(`
    UPDATE broadcasts 
    SET status = 'paused'
    WHERE broadcast_id = ?
  `).bind(broadcastId).run();

  return { success: true };
}

/**
 * Resume a paused broadcast campaign
 */
export async function resumeBroadcast(env, ctx, broadcastId, adminId) {
  if (!isAdmin(env, adminId)) {
    throw new Error("Unauthorized");
  }

  const broadcast = await getBroadcast(env, broadcastId);
  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  if (broadcast.status !== "paused") {
    throw new Error("Broadcast is not paused");
  }

  await env.DB.prepare(`
    UPDATE broadcasts 
    SET status = 'running'
    WHERE broadcast_id = ?
  `).bind(broadcastId).run();

  // Resume processing
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(processBroadcast(env, broadcastId));
  }

  return { success: true };
}

/**
 * Cancel a broadcast campaign
 */
export async function cancelBroadcast(env, broadcastId, adminId) {
  if (!isAdmin(env, adminId)) {
    throw new Error("Unauthorized");
  }

  const broadcast = await getBroadcast(env, broadcastId);
  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  if (broadcast.status === "completed" || broadcast.status === "cancelled") {
    throw new Error("Broadcast already finished");
  }

  await env.DB.prepare(`
    UPDATE broadcasts 
    SET status = 'cancelled', completed_at = ?
    WHERE broadcast_id = ?
  `).bind(now(), broadcastId).run();

  return { success: true };
}

/**
 * List broadcasts with pagination
 */
export async function listBroadcasts(env, page = 0, limit = 20) {
  const offset = page * limit;
  
  const broadcasts = await env.DB.prepare(`
    SELECT 
      broadcast_id, created_by, message, target_type,
      status, total_count, sent_count, failed_count,
      created_at, started_at, completed_at
    FROM broadcasts 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM broadcasts").first();

  return {
    broadcasts: broadcasts.results || [],
    total: total?.count || 0,
    page: page,
    hasMore: (offset + limit) < (total?.count || 0)
  };
}

/**
 * Get broadcast statistics
 */
export async function getBroadcastStats(env, broadcastId) {
  const broadcast = await getBroadcast(env, broadcastId);
  if (!broadcast) {
    throw new Error("Broadcast not found");
  }

  const statusCounts = await env.DB.prepare(`
    SELECT status, COUNT(*) as count 
    FROM broadcast_recipients 
    WHERE broadcast_id = ?
    GROUP BY status
  `).bind(broadcastId).all();

  const stats = {
    total: broadcast.total_count,
    sent: broadcast.sent_count,
    failed: broadcast.failed_count,
    pending: 0
  };

  for (const row of (statusCounts.results || [])) {
    if (row.status === "pending") stats.pending = row.count;
  }

  return stats;
}
