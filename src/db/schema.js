// D1 schema bootstrap, versioned migrations and periodic housekeeping.
// Owns the one-shot guarded init path (`ensureSchema` / `maybeInitSchema`).
import { CONTEXT_TTL, DEFAULT_PERSONALITIES, SCHEMA_PROBE_INTERVAL_MS } from "../config.js";
import { now } from "../utils.js";

let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  const statements = [
    "CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, language_code TEXT, preferred_name TEXT, personality_id TEXT DEFAULT 'default', custom_instructions TEXT, memory_mode TEXT DEFAULT 'normal', memory_data TEXT DEFAULT '{}', usage_stats TEXT DEFAULT '{}', fallback_enabled INTEGER DEFAULT 1, msg_counter INTEGER DEFAULT 0, active_connection_id TEXT, active_route_id TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
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
    "CREATE TABLE IF NOT EXISTS routes (route_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, is_default INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_routes_user ON routes(telegram_id, is_default)",
    "CREATE TABLE IF NOT EXISTS route_models (model_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, model TEXT NOT NULL, label TEXT, is_default INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_route_models_route ON route_models(route_id, is_default)",
    "CREATE TABLE IF NOT EXISTS route_tokens (token_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, label TEXT, encrypted_key TEXT NOT NULL, key_iv TEXT NOT NULL, encryption_version INTEGER DEFAULT 2, enabled INTEGER DEFAULT 1, is_primary INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, consecutive_failures INTEGER DEFAULT 0, last_success_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_route_tokens_route ON route_tokens(route_id, is_primary)",
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER)",
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
  ];
  const schemaErrors = [];
  for (let i = 0; i < statements.length; i++) {
    try { await env.DB.prepare(statements[i]).run(); }
    catch (err) { console.error("Schema statement failed:", err.message); schemaErrors.push(err.message); }
  }
  const alters = [
    ["users", "active_connection_id", "TEXT"],
    ["users", "active_route_id", "TEXT"],
    ["users", "fallback_enabled", "INTEGER DEFAULT 1"],
    ["users", "msg_counter", "INTEGER DEFAULT 0"],
    ["users", "coding_mode", "INTEGER DEFAULT 0"],
    ["ai_connections", "is_global", "INTEGER DEFAULT 0"],
    ["ai_connections", "is_default", "INTEGER DEFAULT 0"],
    ["ai_connections", "description", "TEXT"],
    ["ai_connections", "display_order", "INTEGER DEFAULT 100"],
    ["ai_connections", "last_test_diagnostic", "TEXT"],
    ["ai_connections", "is_fast", "INTEGER DEFAULT 0"],
    // Whether the model accepts image input. When enabled, photos the user
    // sends (and the current message's images) are attached to the request as
    // OpenAI-style image_url data URLs; otherwise images are described as text.
    ["ai_connections", "supports_vision", "INTEGER DEFAULT 0"],
    // IANA timezone of the user (e.g. "Asia/Tehran"). Reminder instants are
    // always stored as UTC seconds; this column only preserves the user's
    // wall-clock context so recurrences and confirmations can be rendered and
    // recomputed in their own zone instead of the worker's.
    ["users", "timezone", "TEXT"]
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
  },
  {
    id: 5,
    label: "add reminders and reminder delivery attempts",
    statements: [
      // `start_at` is the user-visible first occurrence (UTC seconds).
      // `next_run_at` is the due instant the scheduler polls — it equals
      // `start_at` until the reminder fires, then advances to the next
      // recurrence. Storing both means a recurring reminder never loses its
      // anchor (so "every month on the 31st" cannot silently drift) and a
      // completed one keeps the time it was created for.
      "CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL, chat_id INTEGER, title TEXT NOT NULL, description TEXT, start_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL, timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', recurrence TEXT, occurrence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claimed_at INTEGER, last_attempt_at INTEGER, last_error TEXT, sent_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      // The due query is `status = 'pending' AND next_run_at <= ?`, so this
      // index must lead with status; `id` is appended to make the row order
      // deterministic when two reminders share a due second.
      "CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, next_run_at, id)",
      // Owner-scoped listing (`/reminders`, Mini App). Ordered by due time so
      // paging can use a stable keyset instead of OFFSET.
      "CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(telegram_id, status, next_run_at, id)",
      "CREATE TABLE IF NOT EXISTS reminder_delivery_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id INTEGER NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_reminder_attempts_reminder ON reminder_delivery_attempts(reminder_id, created_at DESC)"
    ]
  },
  {
    id: 6,
    label: "initialize Workers AI policy disabled",
    statements: [
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES ('workers_ai_policy', 'disabled', CAST(strftime('%s','now') AS INTEGER), NULL)",
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES ('workers_ai_model', '@cf/meta/llama-3.1-8b-instruct', CAST(strftime('%s','now') AS INTEGER), NULL)"
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
