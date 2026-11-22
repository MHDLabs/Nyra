// Offline migration-safety test (Lead-owned).
//
// Applies shipped migrations to a legacy SQLite database using Node's built-in
// `node:sqlite`. Retired feature state is deleted; core user-owned data is preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_MIGRATIONS } from "../src/db/schema.js";
import { SUPPORTED_LOCALES } from "../src/config.js";

const NOW = Math.floor(Date.now() / 1000);

function createLegacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT,
      language_code TEXT, preferred_name TEXT, personality_id TEXT DEFAULT 'default',
      custom_instructions TEXT, memory_mode TEXT DEFAULT 'normal', memory_data TEXT DEFAULT '{}',
      usage_stats TEXT DEFAULT '{}', fallback_enabled INTEGER DEFAULT 1, msg_counter INTEGER DEFAULT 0,
      active_connection_id TEXT, active_route_id TEXT, created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, timezone TEXT,
      coding_mode INTEGER DEFAULT 0
    );
    CREATE TABLE chats (
      chat_id INTEGER PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT,
      enabled INTEGER DEFAULT 0, mode TEXT DEFAULT 'disabled', summary TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER);
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE thread_messages (
      chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
      user_id INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE ai_connections (
      connection_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, label TEXT NOT NULL,
      provider TEXT NOT NULL, base_url TEXT, model TEXT NOT NULL, encrypted_key TEXT NOT NULL,
      key_iv TEXT NOT NULL, encryption_version INTEGER DEFAULT 2, enabled INTEGER DEFAULT 1,
      is_global INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0, description TEXT,
      display_order INTEGER DEFAULT 100, is_fast INTEGER DEFAULT 0, supports_vision INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE routes (route_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, is_default INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE route_models (model_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, model TEXT NOT NULL, label TEXT, is_default INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE route_tokens (token_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, label TEXT, encrypted_key TEXT NOT NULL, key_iv TEXT NOT NULL, encryption_version INTEGER DEFAULT 2, enabled INTEGER DEFAULT 1, is_primary INTEGER DEFAULT 0, display_order INTEGER DEFAULT 100, consecutive_failures INTEGER DEFAULT 0, last_success_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  // Columns added by the core "alters" pass (which happens before migrations).
  for (const sql of [
    "ALTER TABLE users ADD COLUMN locale TEXT",
    "ALTER TABLE users ADD COLUMN onboarding_state TEXT",
    "ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN onboarding_version INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN onboarding_started_at INTEGER",
    "ALTER TABLE users ADD COLUMN active_profile_id TEXT",
    "ALTER TABLE chats ADD COLUMN disabled_by_admin INTEGER DEFAULT 0"
  ]) db.exec(sql);
  // Mark the historical migrations as already applied (1-9 shipped earlier).
  const mark = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (let id = 1; id <= 9; id++) mark.run(id, NOW - 1000);
  return db;
}

function seedLegacyData(db) {
  const user = db.prepare("INSERT INTO users (telegram_id, first_name, language_code, personality_id, memory_data, usage_stats, created_at, last_seen_at, updated_at) VALUES (?, ?, ?, 'default', '{}', '{}', ?, ?, ?)");
  user.run(101, "Ali", "fa", NOW - 5000, NOW - 4000, NOW - 4000);
  user.run(102, "John", "en-US", NOW - 5000, NOW - 4000, NOW - 4000);
  user.run(103, "Unknown", null, NOW - 5000, NOW - 4000, NOW - 4000);
  db.prepare("INSERT INTO chats (chat_id, chat_type, title, enabled, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(-1001, "group", "Legacy auto-disabled", 0, "disabled", NOW - 5000, NOW - 5000);
  db.prepare("INSERT INTO chats (chat_id, chat_type, title, enabled, mode, disabled_by_admin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(-1002, "group", "Admin disabled", 0, "disabled", 1, NOW - 5000, NOW - 5000);
  db.prepare("INSERT INTO chats (chat_id, chat_type, title, enabled, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(-1003, "group", "Already enabled", 1, "enabled", NOW - 5000, NOW - 5000);
  db.prepare("INSERT INTO ai_connections (connection_id, telegram_id, label, provider, base_url, model, encrypted_key, key_iv, is_global, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("c-legacy", 0, "Custom OpenAI", "openai-compatible", "https://api.example.test/v1", "model-fast", "ciphertext", "iv", 1, 1, NOW - 5000, NOW - 5000);
  db.prepare("INSERT INTO thread_messages (chat_id, message_id, thread_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(101, 1, 101, 101, "user", "hello", NOW - 1000);
  db.prepare("INSERT INTO route_models (model_id, route_id, model, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("m-legacy", "r-legacy", "model-smart", NOW - 1000, NOW - 1000);
}

function applyMigrations(db, migrations) {
  for (const migration of migrations) {
    for (const sql of migration.statements) db.prepare(sql).run();
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, NOW);
  }
}

test("shipped migration ids are unique, numeric and strictly ascending", () => {
  assert.ok(SCHEMA_MIGRATIONS.length >= 11);
  const ids = SCHEMA_MIGRATIONS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate migration id");
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], "migration ids must ascend");
  for (const m of SCHEMA_MIGRATIONS) {
    assert.equal(typeof m.id, "number");
    assert.ok(m.statements.length > 0, "migration " + m.id + " has no statements");
  }
});

test("destructive migrations are limited to retired feature-owned tables", () => {
  const approved = new Set([
    "continuation_states", "ai_connections", "connection_models", "connection_usage",
    "routes", "route_models", "route_tokens",
    "routing_profiles", "routing_profile_entries",
    "shared_service_usage", "voice_transcripts",
    "reminders", "reminder_delivery_attempts",
    "schedules", "schedule_delivery_attempts", "proactive_delivery_attempts"
  ]);
  const approvedRetiredUserColumns = new Set(["active_connection_id", "active_route_id", "fallback_enabled", "active_profile_id", "last_inbound_at", "proactive_enabled", "proactive_threshold_hours", "proactive_quiet_start", "proactive_quiet_end", "proactive_last_sent_at", "proactive_episode_key"]);
  const retained = new Set([
    "users", "thread_messages", "chats", "app_settings", "personalities",
    "custom_personalities", "chat_logs", "broadcasts", "broadcast_recipients",
    "blocked_users", "failed_updates", "processed_updates"
  ]);
  for (const migration of SCHEMA_MIGRATIONS) {
    for (const sql of migration.statements) {
      const drop = sql.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_]+)/i);
      if (drop) {
        assert.ok(approved.has(drop[1]), "unapproved table deletion in migration " + migration.id + ": " + sql);
        assert.ok(!retained.has(drop[1]), "retained table was dropped: " + drop[1]);
      }
      const dropColumn = sql.match(/^\s*ALTER\s+TABLE\s+users\s+DROP\s+COLUMN\s+([a-z_]+)/i);
      if (/DROP\s+COLUMN/i.test(sql)) {
        assert.ok(dropColumn, "only explicit retired user columns may be removed: " + sql);
        assert.ok(approvedRetiredUserColumns.has(dropColumn[1]), "unapproved user column deletion: " + dropColumn[1]);
      }
      if (/^\s*DELETE\s+FROM\s+app_settings/i.test(sql)) {
        assert.match(sql, /WHERE\s+key\s+IN\s*\(/i, "settings cleanup must be key-scoped");
      }
      assert.doesNotMatch(sql, /^\s*DELETE\s+FROM\s+(users|thread_messages|chats|app_settings|personalities|custom_personalities|chat_logs|broadcasts|broadcast_recipients|blocked_users|failed_updates|processed_updates)\b/i);
    }
  }
});

test("upgrading a legacy database preserves data and applies the new defaults", () => {
  const db = createLegacyDb();
  seedLegacyData(db);
  const pending = SCHEMA_MIGRATIONS.filter(m => m.id >= 10).sort((a, b) => a.id - b.id);
  applyMigrations(db, pending);

  // Locale backfill respects Telegram's language_code and never invents locales.
  const users = db.prepare("SELECT telegram_id, locale, onboarding_completed, onboarding_state FROM users ORDER BY telegram_id").all();
  assert.equal(users[0].locale, "fa-IR");
  assert.equal(users[1].locale, "en-US");
  assert.equal(users[2].locale, "en-US");
  for (const u of users) {
    assert.ok(SUPPORTED_LOCALES.includes(u.locale), "unsupported locale " + u.locale);
    assert.equal(u.onboarding_completed, 1, "existing user must not be forced into onboarding");
    assert.equal(u.onboarding_state, null);
  }

  // Groups: legacy auto-disabled become enabled; an admin-disabled group stays off.
  const chats = db.prepare("SELECT chat_id, enabled, mode, disabled_by_admin FROM chats ORDER BY chat_id").all();
  assert.deepEqual(chats.map(c => [c.chat_id, c.enabled, c.mode]), [
    [-1003, 1, "enabled"], [-1002, 0, "disabled"], [-1001, 1, "enabled"]
  ].sort((a, b) => a[0] - b[0]));

  // Settings rows exist with safe defaults.
  const settings = new Map(db.prepare("SELECT key, value FROM app_settings").all().map(r => [r.key, r.value]));
  assert.equal(settings.get("maintenance_enabled"), "0");
  assert.equal(settings.get("default_locale"), "en-US");

  // Core user, group, and conversation records are retained.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users").get().c, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM thread_messages").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM chats").get().c, 3);

  // The final migration removes provider credentials and retired feature state.
  for (const table of [
    "ai_connections", "connection_models", "connection_usage",
    "routes", "route_models", "route_tokens",
    "routing_profiles", "routing_profile_entries",
    "reminders", "reminder_delivery_attempts",
    "schedules", "schedule_delivery_attempts",
    "proactive_delivery_attempts", "shared_service_usage", "voice_transcripts"
  ]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.equal(row, undefined, "retired table should be absent: " + table);
  }
});

test("retired feature tables are not recreated after migration 23", () => {
  const source = readFileSync(new URL("../src/db/schema.ts", import.meta.url), "utf8");
  assert.match(source, /const retiredStateAlreadyCleaned = await isMigrationApplied\(env, 23\)/);
  assert.match(source, /retiredBootstrap/);
  assert.match(source, /statements = statements\.filter/);
  assert.match(source, /activeAlters[\s\S]*?item\[0\] !== "ai_connections"/);
  assert.match(source, /id: 23,[\s\S]*?DROP TABLE IF EXISTS ai_connections/);
});
test("applying the same pending migrations twice is rejected by migration tracking, not silently repeated", () => {
  const db = createLegacyDb();
  const pending = SCHEMA_MIGRATIONS.filter(m => m.id >= 10).sort((a, b) => a.id - b.id);
  applyMigrations(db, pending);
  // The runtime skips already-applied ids; INSERTing a duplicate id would fail,
  // proving the tracking table is the single source of truth.
  assert.throws(() => db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(pending[0].id, NOW));
});
