// Routing/connection migrations. Kept in a separate module so the routing
// engineer can extend the data model without touching the core schema file;
// `schema.js` concatenates this list after the core migrations (ids 1-11).
//
// Rules (do not break them):
//  - ids start at 20 and are append-only;
//  - statements must be additive and idempotent (CREATE ... IF NOT EXISTS,
//    INSERT OR IGNORE, ADD COLUMN guarded by the core `alters` list);
//  - never drop a table or column that holds user data.
export const ROUTING_MIGRATIONS = [
  {
    // A connection owns an endpoint + credentials; a model is a name that can be
    // sent to it. Previously the credential lived on the model, so adding a
    // second model to the same endpoint duplicated the key. Existing rows are
    // backfilled below so no current connection loses its single model.
    id: 20,
    label: "add connection_models and backfill the configured model per connection",
    statements: [
      "CREATE TABLE IF NOT EXISTS connection_models (model_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, model TEXT NOT NULL, label TEXT, source TEXT NOT NULL DEFAULT 'manual', enabled INTEGER NOT NULL DEFAULT 1, verify_status TEXT NOT NULL DEFAULT 'unverified', verified_at INTEGER, last_error TEXT, display_order INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(connection_id, model))",
      "CREATE INDEX IF NOT EXISTS idx_connection_models_connection ON connection_models(connection_id, display_order)",
      // Deterministic id ("<connection_id>:<model>") makes the backfill idempotent:
      // INSERT OR IGNORE can never create a second row for the same pair. The
      // model is copied, not moved, and the connection row is never touched, so
      // rolling back to the previous release keeps working.
      "INSERT OR IGNORE INTO connection_models (model_id, connection_id, model, label, source, enabled, verify_status, display_order, created_at, updated_at) SELECT connection_id || ':' || model, connection_id, model, model, 'manual', 1, 'unverified', COALESCE(display_order, 100), created_at, updated_at FROM ai_connections WHERE model IS NOT NULL AND TRIM(model) <> ''"
    ]
  },
  {
    // A routing profile is the user-visible "primary + ordered fallbacks" list.
    // Entries reference a connection/model pair by ordinal priority; the lowest
    // priority is attempted first. Legacy routes (routes/route_models/
    // route_tokens) are intentionally left intact: they keep working for
    // existing data and are only used when no profile is selected or default.
    id: 21,
    label: "add routing profiles and ordered profile entries",
    statements: [
      "CREATE TABLE IF NOT EXISTS routing_profiles (profile_id TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, label TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, cross_source_fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_routing_profiles_user ON routing_profiles(telegram_id, is_default, enabled)",
      "CREATE TABLE IF NOT EXISTS routing_profile_entries (entry_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL, model TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(profile_id, connection_id, model))",
      "CREATE INDEX IF NOT EXISTS idx_routing_entries_profile ON routing_profile_entries(profile_id, priority, created_at)"
    ]
  },
  {
    // Auto-fallback may only cross the personal/shared boundary when the user
    // opted in (per profile) OR the operator explicitly allows it globally.
    // Default 0 keeps the safe behaviour: a personal-key user is never silently
    // charged against the operator's shared credit, and vice versa.
    id: 22,
    label: "add cross-source fallback policy setting (default off)",
    statements: [
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES ('allow_cross_source_fallback', '0', CAST(strftime('%s','now') AS INTEGER), NULL)"
    ]
  }
];
