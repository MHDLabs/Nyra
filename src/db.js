// Nyra — storage: D1 schema, users/chats/threads, flow state, connections, usage stats.
import { MAX_CONTEXT_MESSAGES, CONTEXT_TTL, USER_LAST_SEEN_INTERVAL, BOT_IDENTITY_TTL, BOT_IDENTITY_NEGATIVE_TTL, FLOW_TTL, CONNECTION_CACHE_TTL_MS, DEFAULT_PERSONALITIES, SCHEMA_PROBE_INTERVAL_MS } from "./config.js";
import { now, truncate, escapeRegex, generateShortId, containsNyraWord, isAdmin } from "./utils.js";
import { encryptCredential } from "./crypto.js";
import { tg } from "./telegram.js";

let schemaReady = false;
let userConnectionsCache = new Map();
let botIdentityCache = { id: null, username: null, expiresAt: 0 };

export async function ensureSchema(env) {
  if (schemaReady) return;
  const statements = [
    "CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, language_code TEXT, preferred_name TEXT, personality_id TEXT DEFAULT 'default', custom_instructions TEXT, memory_mode TEXT DEFAULT 'normal', memory_data TEXT DEFAULT '{}', usage_stats TEXT DEFAULT '{}', fallback_enabled INTEGER DEFAULT 1, msg_counter INTEGER DEFAULT 0, active_connection_id TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)",
    "CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT, enabled INTEGER DEFAULT 0, mode TEXT DEFAULT 'disabled', summary TEXT DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_chats_enabled ON chats(enabled)",
    "CREATE TABLE IF NOT EXISTS personalities (personality_id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER DEFAULT 1, is_builtin INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS custom_personalities (personality_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, prompt TEXT NOT NULL, enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_cpers_user ON custom_personalities(telegram_id)",
    "CREATE TABLE IF NOT EXISTS ai_connections (connection_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, model TEXT NOT NULL, encrypted_key TEXT NOT NULL, key_iv TEXT NOT NULL, encryption_version INTEGER DEFAULT 2, enabled INTEGER DEFAULT 1, is_global INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0, description TEXT, display_order INTEGER DEFAULT 100, last_test_at INTEGER, last_test_status TEXT, last_test_error TEXT, last_test_latency_ms INTEGER, last_test_diagnostic TEXT, consecutive_failures INTEGER DEFAULT 0, last_success_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_conn_user ON ai_connections(telegram_id, enabled)",
    "CREATE INDEX IF NOT EXISTS idx_conn_global ON ai_connections(is_global, enabled, is_default)",
    "CREATE TABLE IF NOT EXISTS thread_messages (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, user_id INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id))",
    "CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(chat_id, thread_id, created_at)",
    "CREATE TABLE IF NOT EXISTS blocked_users (telegram_id INTEGER PRIMARY KEY, reason TEXT, blocked_at INTEGER NOT NULL, blocked_by INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_processed_updates_received ON processed_updates(received_at)",
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
  ];
  const schemaErrors = [];
  for (let i = 0; i < statements.length; i++) {
    try { await env.DB.prepare(statements[i]).run(); }
    catch (err) { console.error("Schema statement failed:", err.message); schemaErrors.push(err.message); }
  }
  const alters = [
    ["users", "active_connection_id", "TEXT"],
    ["users", "fallback_enabled", "INTEGER DEFAULT 1"],
    ["users", "msg_counter", "INTEGER DEFAULT 0"],
    ["users", "coding_mode", "INTEGER DEFAULT 0"],
    ["ai_connections", "is_global", "INTEGER DEFAULT 0"],
    ["ai_connections", "is_default", "INTEGER DEFAULT 0"],
    ["ai_connections", "description", "TEXT"],
    ["ai_connections", "display_order", "INTEGER DEFAULT 100"],
    ["ai_connections", "last_test_diagnostic", "TEXT"]
  ];
  for (let i = 0; i < alters.length; i++) {
    const table = alters[i][0];
    const column = alters[i][1];
    const def = alters[i][2];
    try {
      const cols = await env.DB.prepare("PRAGMA table_info(" + table + ")").all();
      const hasCol = (cols.results || []).some(function (c) { return c.name === column; });
      if (!hasCol) await env.DB.prepare("ALTER TABLE " + table + " ADD COLUMN " + column + " " + def).run();
    } catch (err) {
      // A concurrent isolate may have added the same column first — benign.
      if (String(err.message || "").toLowerCase().indexOf("duplicate column") !== -1) continue;
      console.error("Alter " + table + "." + column + " failed:", err.message);
      schemaErrors.push(err.message);
    }
  }
  if (schemaErrors.length > 0) {
    throw new Error("Schema initialization failed: " + schemaErrors.join("; "));
  }
  await runPendingMigrations(env);
  const ts = now();
  for (let i = 0; i < DEFAULT_PERSONALITIES.length; i++) {
    const p = DEFAULT_PERSONALITIES[i];
    try {
      await env.DB.prepare("INSERT INTO personalities (personality_id, name, prompt, enabled, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?) ON CONFLICT(personality_id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, updated_at = excluded.updated_at WHERE personalities.is_builtin = 1")
        .bind(p.id, p.name, p.prompt, ts, ts).run();
    } catch (err) {
      try {
        await env.DB.prepare("INSERT OR IGNORE INTO personalities (personality_id, name, prompt, enabled, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)")
          .bind(p.id, p.name, p.prompt, ts, ts).run();
      } catch (e2) { console.error("Seed personality failed:", e2.message); }
    }
  }
  await runMaintenance(env);
  schemaReady = true;
}

// One-time, versioned schema/data migrations. Destructive statements live here —
// they run exactly once (tracked in schema_migrations) instead of on every cold
// start, and failures propagate instead of being swallowed.
const MIGRATIONS = [
  {
    id: 1,
    label: "drop legacy continuation_states; retire builtin coder/personality ids",
    statements: [
      "DROP TABLE IF EXISTS continuation_states",
      "DELETE FROM personalities WHERE personality_id IN ('coder','professional') AND is_builtin = 1",
      "UPDATE users SET personality_id = 'default', updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE personality_id IN ('coder','professional')"
    ]
  },
  {
    id: 2,
    label: "add broadcast tables for admin mass-messaging",
    statements: [
      "CREATE TABLE IF NOT EXISTS broadcasts (broadcast_id TEXT PRIMARY KEY, created_by INTEGER NOT NULL, message TEXT NOT NULL, target_type TEXT NOT NULL, target_filter TEXT, status TEXT DEFAULT 'draft', total_count INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, created_at)",
      "CREATE TABLE IF NOT EXISTS broadcast_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id TEXT NOT NULL, recipient_id INTEGER NOT NULL, status TEXT DEFAULT 'pending', error_message TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE(broadcast_id, recipient_id))",
      "CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_status ON broadcast_recipients(broadcast_id, status)"
    ]
  },
  {
    id: 3,
    label: "add connection usage tracking table",
    statements: [
      "CREATE TABLE IF NOT EXISTS connection_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, telegram_id INTEGER NOT NULL, tokens_used INTEGER DEFAULT 0, requests_count INTEGER DEFAULT 0, date TEXT NOT NULL, UNIQUE(connection_id, telegram_id, date))",
      "CREATE INDEX IF NOT EXISTS idx_connection_usage_conn ON connection_usage(connection_id, date)",
      "CREATE INDEX IF NOT EXISTS idx_connection_usage_user ON connection_usage(telegram_id, date)"
    ]
  },
  {
    id: 4,
    label: "add failed_updates table for DLQ logging",
    statements: [
      "CREATE TABLE IF NOT EXISTS failed_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, update_id INTEGER NOT NULL, user_id INTEGER, chat_id INTEGER, message_text TEXT, error_info TEXT, created_at INTEGER NOT NULL, replayed_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_failed_updates_created ON failed_updates(created_at DESC)"
    ]
  }
];

async function runPendingMigrations(env) {
  let appliedIds;
  try {
    const res = await env.DB.prepare("SELECT id FROM schema_migrations").all();
    appliedIds = new Set((res.results || []).map(function (r) { return r.id; }));
  } catch (err) {
    console.error("schema_migrations read failed:", err.message);
    throw err;
  }
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (appliedIds.has(m.id)) continue;
    const batch = m.statements.map(function (sql) { return env.DB.prepare(sql); });
    batch.push(env.DB.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, now()));
    try {
      await env.DB.batch(batch);
      console.log("Applied schema migration " + m.id + ": " + m.label);
    } catch (err) {
      console.error("Schema migration " + m.id + " failed:", err.message);
      throw err;
    }
  }
}

// Periodic, non-critical housekeeping. Runs at most once per day (KV marker),
// marker written before the deletes so a failing delete does not hammer D1 on
// every request. Failures are logged, never fatal to request handling.
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_DEDUP_RETENTION_S = 7 * 24 * 60 * 60;

async function runMaintenance(env) {
  try {
    const marker = await env.KV.get("nyra:purge:last_run");
    const last = marker ? parseInt(marker, 10) : 0;
    const t = Date.now();
    if (Number.isFinite(last) && t - last < PURGE_INTERVAL_MS) return;
    await env.KV.put("nyra:purge:last_run", String(t), { expirationTtl: 172800 });
    await env.DB.prepare("DELETE FROM thread_messages WHERE created_at < ?").bind(now() - (CONTEXT_TTL * 2)).run();
    await env.DB.prepare("DELETE FROM processed_updates WHERE received_at < ?").bind(Math.floor(Date.now() / 1000) - UPDATE_DEDUP_RETENTION_S).run();
    console.log("Maintenance purge completed.");
  } catch (err) {
    console.error("Maintenance purge failed:", err.message);
  }
}
/**
 * Track connection usage (tokens and requests)
 */
export async function trackConnectionUsage(env, connectionId, telegramId, tokensUsed = 0) {
  try {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    await env.DB.prepare(`
      INSERT INTO connection_usage (connection_id, telegram_id, tokens_used, requests_count, date)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(connection_id, telegram_id, date)
      DO UPDATE SET 
        tokens_used = tokens_used + excluded.tokens_used,
        requests_count = requests_count + excluded.requests_count
    `).bind(connectionId, telegramId, tokensUsed, date).run();
  } catch (err) {
    console.error("Connection usage tracking failed:", err.message);
  }
}

/**
 * Get connection usage stats by connection
 */
export async function getConnectionUsageStats(env, connectionId, days = 7) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().split("T")[0];

    const result = await env.DB.prepare(`
      SELECT 
        connection_id,
        SUM(tokens_used) as total_tokens,
        SUM(requests_count) as total_requests,
        COUNT(DISTINCT telegram_id) as unique_users,
        COUNT(DISTINCT date) as active_days
      FROM connection_usage
      WHERE connection_id = ? AND date >= ?
      GROUP BY connection_id
    `).bind(connectionId, cutoff).first();

    return result || { total_tokens: 0, total_requests: 0, unique_users: 0, active_days: 0 };
  } catch (err) {
    console.error("Get connection usage stats failed:", err.message);
    return { total_tokens: 0, total_requests: 0, unique_users: 0, active_days: 0 };
  }
}

/**
 * Get all connection usage summary for admin
 */
export async function getAllConnectionUsageStats(env, days = 7) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().split("T")[0];

    const result = await env.DB.prepare(`
      SELECT 
        cu.connection_id,
        ac.label,
        ac.provider,
        ac.model,
        SUM(cu.tokens_used) as total_tokens,
        SUM(cu.requests_count) as total_requests,
        COUNT(DISTINCT cu.telegram_id) as unique_users,
        COUNT(DISTINCT cu.date) as active_days
      FROM connection_usage cu
      LEFT JOIN ai_connections ac ON cu.connection_id = ac.connection_id
      WHERE cu.date >= ?
      GROUP BY cu.connection_id, ac.label, ac.provider, ac.model
      ORDER BY total_requests DESC
    `).bind(cutoff).all();

    return result.results || [];
  } catch (err) {
    console.error("Get all connection usage stats failed:", err.message);
    return [];
  }
}
// KV-gated schema bootstrap for the zero-config path (status page + cron).
// Marker written BEFORE ensureSchema — same discipline as the purge marker —
// so a failing schema build cannot hammer D1 on every invocation.
const SCHEMA_CHECK_KEY = "nyra:schema:checked_at";

export async function maybeInitSchema(env) {
  try {
    const last = parseInt((await env.KV.get(SCHEMA_CHECK_KEY)) || "0", 10);
    if (Number.isFinite(last) && Date.now() - last < SCHEMA_PROBE_INTERVAL_MS) return;
    await env.KV.put(SCHEMA_CHECK_KEY, String(Date.now()), { expirationTtl: 86400 });
    await ensureSchema(env);
  } catch (err) {
    console.error("Schema initialisation failed:", err.message);
  }
}

export async function getBotIdentity(env) {
  if (botIdentityCache.expiresAt > Date.now()) return botIdentityCache;
  if (env.TELEGRAM_BOT_ID && env.TELEGRAM_BOT_USERNAME) {
    const parsedId = parseInt(env.TELEGRAM_BOT_ID, 10);
    if (!isNaN(parsedId) && parsedId > 0) {
      botIdentityCache = { id: parsedId, username: env.TELEGRAM_BOT_USERNAME, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      try { await env.KV.put("bot:identity", JSON.stringify({ id: parsedId, username: env.TELEGRAM_BOT_USERNAME }), { expirationTtl: 86400 }); } catch (err) {}
      return botIdentityCache;
    }
  }
  try {
    const cached = await env.KV.get("bot:identity", "json");
    if (cached && typeof cached.id === "number" && cached.id > 0) {
      botIdentityCache = { id: cached.id, username: cached.username || null, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      return botIdentityCache;
    }
  } catch (err) {}
  try {
    const me = await tg(env, "getMe", {});
    if (me && me.ok && me.result && typeof me.result.id === "number") {
      botIdentityCache = { id: me.result.id, username: me.result.username || null, expiresAt: Date.now() + BOT_IDENTITY_TTL };
      try { await env.KV.put("bot:identity", JSON.stringify({ id: me.result.id, username: me.result.username || null }), { expirationTtl: 86400 }); } catch (err) {}
      return botIdentityCache;
    }
  } catch (err) {}
  botIdentityCache = { id: null, username: null, expiresAt: Date.now() + BOT_IDENTITY_NEGATIVE_TTL };
  return botIdentityCache;
}

export async function getUser(env, userId) {
  try { return await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(userId).first(); }
  catch (err) { console.error("getUser failed:", err.message); return null; }
}

export async function upsertUser(env, from) {
  const ts = now();
  const existing = await getUser(env, from.id);
  if (!existing) {
    try {
      await env.DB.prepare("INSERT INTO users (telegram_id, first_name, last_name, username, language_code, personality_id, memory_mode, memory_data, usage_stats, fallback_enabled, msg_counter, active_connection_id, created_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 'default', 'normal', '{}', '{}', 1, 0, NULL, ?, ?, ?) ON CONFLICT(telegram_id) DO NOTHING")
        .bind(from.id, from.first_name || "", from.last_name || "", from.username || "", from.language_code || "", ts, ts, ts).run();
    } catch (err) { console.error("upsertUser insert failed:", err.message); }
    return await getUser(env, from.id);
  }
  const nameChanged = existing.first_name !== (from.first_name || "") || existing.last_name !== (from.last_name || "") || existing.username !== (from.username || "") || existing.language_code !== (from.language_code || "");
  const lastSeenOld = (ts - (existing.last_seen_at || 0)) > USER_LAST_SEEN_INTERVAL;
  if (!nameChanged && !lastSeenOld) return existing;
  try {
    if (nameChanged) {
      await env.DB.prepare("UPDATE users SET first_name = ?, last_name = ?, username = ?, language_code = ?, last_seen_at = ?, updated_at = ? WHERE telegram_id = ?")
        .bind(from.first_name || "", from.last_name || "", from.username || "", from.language_code || "", ts, ts, from.id).run();
    } else {
      await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE telegram_id = ?").bind(ts, from.id).run();
    }
  } catch (err) {}
  return await getUser(env, from.id);
}

export async function getChat(env, chatId) {
  try { return await env.DB.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(chatId).first(); }
  catch (err) { return null; }
}

export async function recordGroupChatAndCheckAccess(env, chat, userId) {
  const ts = now();
  const existing = await getChat(env, chat.id);
  if (!existing) {
    try {
      await env.DB.prepare("INSERT INTO chats (chat_id, chat_type, title, enabled, mode, summary, created_at, updated_at) VALUES (?, ?, ?, 0, 'disabled', '', ?, ?) ON CONFLICT(chat_id) DO NOTHING")
        .bind(chat.id, chat.type || "group", chat.title || "", ts, ts).run();
    } catch (err) {}
    return false;
  }
  if (existing.title !== (chat.title || "")) {
    try { await env.DB.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE chat_id = ?").bind(chat.title || "", ts, chat.id).run(); } catch (err) {}
  }
  const mode = existing.mode || (existing.enabled === 1 ? "enabled" : "disabled");
  if (mode === "disabled") return false;
  if (mode === "admin_only") return isAdmin(env, userId);
  return mode === "enabled";
}

export async function isUserBlocked(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT telegram_id FROM blocked_users WHERE telegram_id = ?").bind(userId).first();
    return !!row;
  } catch (err) { return false; }
}

export async function saveThreadMessage(env, chatId, threadId, messageId, userId, role, content) {
  try {
    await env.DB.prepare(
      "INSERT INTO thread_messages (chat_id, message_id, thread_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET thread_id = excluded.thread_id, content = excluded.content"
    ).bind(chatId, messageId, threadId, userId || null, role, truncate(content || "", 2000), now()).run();
  } catch (err) { console.error("saveThreadMessage failed:", err.message); }
}

export async function getThreadContext(env, chatId, threadId) {
  try {
    const result = await env.DB.prepare(
      "SELECT role, content FROM thread_messages WHERE chat_id = ? AND thread_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?"
    ).bind(chatId, threadId, MAX_CONTEXT_MESSAGES).all();
    const rows = result.results || [];
    return rows.reverse();
  } catch (err) { return []; }
}

function isReplyToBot(message, identity) {
  if (!message || !message.reply_to_message) return false;
  if (!message.reply_to_message.from) return false;
  if (!identity || !identity.id) return false;
  return message.reply_to_message.from.id === identity.id;
}

export function isGroupTrigger(message, identity) {
  if (!message) return { trigger: false, mode: null };
  if (isReplyToBot(message, identity)) {
    return { trigger: true, mode: "reply" };
  }
  const text = (message.text || message.caption || "");
  if (!text) return { trigger: false, mode: null };
  if (containsNyraWord(text)) return { trigger: true, mode: "call" };
  if (identity && identity.username) {
    const pattern = new RegExp("@" + escapeRegex(identity.username), "i");
    if (pattern.test(text)) return { trigger: true, mode: "call" };
  }
  return { trigger: false, mode: null };
}

export async function determineThreadId(env, chatId, message, identity, triggerMode) {
  if (triggerMode === "reply" && isReplyToBot(message, identity)) {
    const replyMsgId = message.reply_to_message.message_id;
    try {
      const row = await env.DB.prepare("SELECT thread_id FROM thread_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, replyMsgId).first();
      if (row && row.thread_id) return row.thread_id;
    } catch (err) {}
    return replyMsgId;
  }
  return message.message_id;
}

export async function getFlowState(env, userId) {
  try { return await env.KV.get("flow:" + userId, "json"); } catch (err) { return null; }
}

export async function setFlowState(env, userId, state) {
  try { await env.KV.put("flow:" + userId, JSON.stringify(state), { expirationTtl: FLOW_TTL }); }
  catch (err) { console.error("setFlowState failed:", err.message); }
}

export async function clearFlowState(env, userId) {
  try { await env.KV.delete("flow:" + userId); } catch (err) {}
}

function invalidateUserConnectionsCache(userId) {
  if (userId) userConnectionsCache.delete(String(userId));
  else userConnectionsCache.clear();
}

export async function getUserConnections(env, userId, forceRefresh) {
  const key = String(userId);
  const cached = userConnectionsCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.connections;
  try {
    const result = await env.DB.prepare("SELECT * FROM ai_connections WHERE (telegram_id = ? AND is_global = 0) OR is_global = 1 ORDER BY is_global DESC, display_order ASC, created_at ASC").bind(userId).all();
    const list = result.results || [];
    userConnectionsCache.set(key, { connections: list, expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS });
    return list;
  } catch (err) {
    console.error("getUserConnections failed:", err.message);
    return [];
  }
}

export async function getEnabledUserConnections(env, userId) {
  const all = await getUserConnections(env, userId);
  return all.filter(function (c) { return c.enabled === 1; });
}

export async function getUserConnectionById(env, userId, connectionId) {
  try {
    return await env.DB.prepare("SELECT * FROM ai_connections WHERE connection_id = ? AND ((telegram_id = ? AND is_global = 0) OR is_global = 1)").bind(connectionId, userId).first();
  } catch (err) { return null; }
}

export async function saveGlobalConnection(env, adminId, params) {
  const ts = now();
  const encrypted = await encryptCredential(env, adminId, params.api_key);
  const connectionId = generateShortId();
  let maxOrder = 100;
  try {
    const row = await env.DB.prepare("SELECT MAX(display_order) AS m FROM ai_connections WHERE is_global = 1").first();
    if (row && row.m !== null && row.m !== undefined) maxOrder = row.m + 10;
  } catch (err) {}
  await env.DB.prepare(
    "INSERT INTO ai_connections (connection_id, telegram_id, label, provider, base_url, model, encrypted_key, key_iv, encryption_version, enabled, is_global, is_default, description, display_order, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 1, 1, 0, ?, ?, 0, ?, ?)"
  ).bind(connectionId, adminId, params.label, params.provider, params.base_url, params.model, encrypted.ct, encrypted.iv, params.description || "", maxOrder, ts, ts).run();
  invalidateUserConnectionsCache(null);
  return connectionId;
}

export async function updateUserConnection(env, userId, connectionId, updates) {
  const ts = now();
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  const fields = [];
  const values = [];
  if (updates.label !== undefined) { fields.push("label = ?"); values.push(updates.label); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.base_url !== undefined) { fields.push("base_url = ?"); values.push(updates.base_url); }
  if (updates.model !== undefined) { fields.push("model = ?"); values.push(updates.model); }
  if (updates.provider !== undefined) { fields.push("provider = ?"); values.push(updates.provider); }
  if (updates.encrypted_key !== undefined && updates.key_iv !== undefined) {
    fields.push("encrypted_key = ?"); values.push(updates.encrypted_key);
    fields.push("key_iv = ?"); values.push(updates.key_iv);
  }
  if (fields.length === 0) return true;
  fields.push("updated_at = ?"); values.push(ts);
  values.push(connectionId);
  try {
    await env.DB.prepare("UPDATE ai_connections SET " + fields.join(", ") + " WHERE connection_id = ?").bind.apply(null, values).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("updateUserConnection failed:", err.message); return false; }
}

export async function deleteUserConnection(env, userId, connectionId) {
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  try {
    await env.DB.prepare("DELETE FROM ai_connections WHERE connection_id = ?").bind(connectionId).run();
    invalidateUserConnectionsCache(null);
    try { await env.DB.prepare("UPDATE users SET active_connection_id = NULL, updated_at = ? WHERE active_connection_id = ?").bind(now(), connectionId).run(); } catch (e) {}
    return true;
  } catch (err) { console.error("deleteUserConnection failed:", err.message); return false; }
}

export async function toggleUserConnection(env, userId, connectionId) {
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) return false;
  if (conn.is_global === 1 && !isAdmin(env, userId)) return false;
  if (conn.is_global === 0 && conn.telegram_id !== userId) return false;
  try {
    const newState = conn.enabled === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE ai_connections SET enabled = ?, updated_at = ? WHERE connection_id = ?").bind(newState, now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { return false; }
}

export async function setDefaultConnection(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return false;
  try {
    await env.DB.prepare("UPDATE ai_connections SET is_default = 0 WHERE is_global = 1").run();
    await env.DB.prepare("UPDATE ai_connections SET is_default = 1, updated_at = ? WHERE connection_id = ? AND is_global = 1").bind(now(), connectionId).run();
    invalidateUserConnectionsCache(null);
    return true;
  } catch (err) { console.error("setDefaultConnection failed:", err.message); return false; }
}

export async function updateUserConnectionTest(env, userId, connectionId, status, error, latencyMs, diagnostic) {
  const ts = now();
  try {
    if (status === "success") {
      await env.DB.prepare("UPDATE ai_connections SET last_test_at = ?, last_test_status = ?, last_test_error = NULL, last_test_latency_ms = ?, last_test_diagnostic = NULL, consecutive_failures = 0, last_success_at = ?, updated_at = ? WHERE connection_id = ?")
        .bind(ts, status, latencyMs || null, ts, ts, connectionId).run();
    } else {
      await env.DB.prepare("UPDATE ai_connections SET last_test_at = ?, last_test_status = ?, last_test_error = ?, last_test_latency_ms = ?, last_test_diagnostic = ?, updated_at = ? WHERE connection_id = ?")
        .bind(ts, status, error || null, latencyMs || null, diagnostic || null, ts, connectionId).run();
    }
    invalidateUserConnectionsCache(null);
  } catch (err) { console.error("updateUserConnectionTest failed:", err.message); }
}

export async function recordConnectionFailure(env, connectionId) {
  try {
    await env.DB.prepare("UPDATE ai_connections SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE connection_id = ?").bind(now(), connectionId).run();
    invalidateUserConnectionsCache(null);
  } catch (err) {}
}

export async function recordConnectionSuccess(env, connectionId) {
  try {
    await env.DB.prepare("UPDATE ai_connections SET consecutive_failures = 0, last_success_at = ?, updated_at = ? WHERE connection_id = ?").bind(now(), now(), connectionId).run();
    invalidateUserConnectionsCache(null);
  } catch (err) {}
}

export function parseUsageStats(raw) {
  const empty = { total: 0, success: 0, fail: 0, last_at: 0, last_error: null, in_tokens: 0, out_tokens: 0, cost_usd: 0, token_source: "unavailable" };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    return {
      total: parsed.total || 0, success: parsed.success || 0, fail: parsed.fail || 0,
      last_at: parsed.last_at || 0, last_error: parsed.last_error || null,
      in_tokens: parsed.in_tokens || 0, out_tokens: parsed.out_tokens || 0,
      cost_usd: parsed.cost_usd || 0, token_source: parsed.token_source || "unavailable"
    };
  } catch (err) { return empty; }
}

async function updateUsageStats(env, userId, success, errorCategory, usage) {
  const user = await getUser(env, userId);
  if (!user) return;
  const stats = parseUsageStats(user.usage_stats);
  stats.total += 1;
  if (success) { stats.success += 1; stats.last_error = null; }
  else { stats.fail += 1; stats.last_error = errorCategory || "unknown"; }
  stats.last_at = now();
  if (usage && usage.source === "provider_reported") {
    stats.in_tokens = (stats.in_tokens || 0) + (usage.in || 0);
    stats.out_tokens = (stats.out_tokens || 0) + (usage.out || 0);
    stats.token_source = "provider_reported";
  }
  if (usage && usage.cost && typeof usage.cost === "number" && usage.cost > 0) {
    stats.cost_usd = (stats.cost_usd || 0) + usage.cost;
  }
  try { await env.DB.prepare("UPDATE users SET usage_stats = ? WHERE telegram_id = ?").bind(JSON.stringify(stats), userId).run(); }
  catch (err) { console.error("updateUsageStats failed:", err.message); }
}

export function updateUsageStatsAsync(env, ctx, userId, success, errorCategory, usage) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(updateUsageStats(env, userId, success, errorCategory, usage));
  else updateUsageStats(env, userId, success, errorCategory, usage).catch(function () {});
}

export async function resolveUserActiveConnection(env, user) {
  const conns = await getEnabledUserConnections(env, user.telegram_id);
  if (conns.length === 0) return { connection: null, switched: false, previousMissing: false };
  let conn = null;
  if (user && user.active_connection_id) {
    for (let i = 0; i < conns.length; i++) if (conns[i].connection_id === user.active_connection_id) { conn = conns[i]; break; }
  }
  if (!conn) {
    let target = null;
    for (let i = 0; i < conns.length; i++) if (conns[i].is_global === 1 && conns[i].is_default === 1) { target = conns[i]; break; }
    if (!target) target = conns[0];
    try { await env.DB.prepare("UPDATE users SET active_connection_id = ?, updated_at = ? WHERE telegram_id = ?").bind(target.connection_id, now(), user.telegram_id).run(); } catch (err) {}
    return { connection: target, switched: true, previousMissing: !!(user && user.active_connection_id) };
  }
  return { connection: conn, switched: false, previousMissing: false };
}
