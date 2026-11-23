// Fresh-install schema bootstrap regression test.
// Exercises the real ensureSchema path against an in-memory SQLite D1 adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema, SCHEMA_MIGRATIONS } from "../src/db/schema.js";

function makeD1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          const result = db.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes || 0) } };
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        }
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

test("fresh ensureSchema applies all migrations and leaves only the simplified schema", async () => {
  const db = new DatabaseSync(":memory:");
  const env = {
    DB: makeD1(db),
    KV: {
      async get() { return null; },
      async put() {}
    }
  };

  await ensureSchema(env);

  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map(row => row.id)
  );
  for (const migration of SCHEMA_MIGRATIONS) {
    assert.ok(applied.has(migration.id), "fresh database missed migration " + migration.id);
  }

  const retiredTables = [
    "continuation_states", "ai_connections", "connection_models", "connection_usage",
    "routes", "route_models", "route_tokens",
    "routing_profiles", "routing_profile_entries",
    "shared_service_usage", "voice_transcripts",
    "reminders", "reminder_delivery_attempts",
    "schedules", "schedule_delivery_attempts", "proactive_delivery_attempts"
  ];
  for (const table of retiredTables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.equal(row, undefined, "fresh schema retained retired table: " + table);
  }

  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map(row => row.name));
  for (const column of [
    "active_connection_id", "active_route_id", "fallback_enabled", "active_profile_id",
    "last_inbound_at", "proactive_enabled", "proactive_threshold_hours",
    "proactive_quiet_start", "proactive_quiet_end", "proactive_last_sent_at",
    "proactive_episode_key"
  ]) {
    assert.equal(columns.has(column), false, "fresh schema retained retired user column: " + column);
  }

  for (const table of ["users", "chats", "thread_messages", "app_settings", "custom_personalities", "chat_logs", "broadcasts", "broadcast_recipients", "blocked_users", "failed_updates"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.ok(row, "fresh schema omitted retained table: " + table);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personalities WHERE personality_id = 'default'").get().count, 1);
});
