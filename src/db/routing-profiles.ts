import type { NyraEnv } from "../../types/env.js";
import type { TelegramId } from "../../types/domain.js";
// Routing profiles: a user-owned, ordered "primary + fallbacks" list.
//
// A profile is a named list of routing_profile_entries. Each entry points at a
// (connection, model) pair and carries an ordinal priority: the lowest priority
// is the primary, the rest are fallbacks in order. Profiles are scoped to their
// owner (telegram_id) so a profile can never reference another user's personal
// connection; the JOIN below is also constrained to the owner's personal rows
// or shared (is_global = 1) rows.
//
// Legacy routes (routes/route_models/route_tokens) stay untouched: they keep
// working for existing data and are only consulted when no profile is selected.
import { generateShortId, now } from "../utils.js";
import { MAX_LABEL_LENGTH, MAX_ROUTE_LABEL_LENGTH, MAX_ROUTE_MODELS } from "../config.js";

const ENTRY_SELECT = "SELECT e.entry_id, e.profile_id, e.connection_id, e.model, e.priority, e.enabled AS entry_enabled, e.created_at AS entry_created_at, e.updated_at AS entry_updated_at, c.label AS connection_label, c.provider, c.base_url, c.encrypted_key, c.key_iv, c.telegram_id AS owner_telegram_id, c.enabled AS connection_enabled, c.is_global, c.is_fast, c.supports_vision, c.consecutive_failures, cm.model_id AS model_row_id, cm.label AS model_label, cm.enabled AS model_enabled, cm.verify_status, cm.source AS model_source FROM routing_profile_entries e JOIN routing_profiles p ON p.profile_id = e.profile_id JOIN ai_connections c ON c.connection_id = e.connection_id LEFT JOIN connection_models cm ON cm.connection_id = e.connection_id AND cm.model = e.model WHERE e.profile_id = ? AND p.telegram_id = ? AND (c.is_global = 1 OR c.telegram_id = ?) ORDER BY e.priority ASC, e.created_at ASC";

export async function listRoutingProfiles(env: NyraEnv, userId) {
  try {
    const res = await env.DB.prepare("SELECT * FROM routing_profiles WHERE telegram_id = ? ORDER BY is_default DESC, created_at ASC").bind(userId).all();
    return res.results || [];
  } catch (err) {
    // Pre-migration database / minimal test stub: no profiles, fall back to
    // the legacy route + connection paths.
    return [];
  }
}

export async function countRoutingProfiles(env: NyraEnv, userId) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM routing_profiles WHERE telegram_id = ?").bind(userId).first();
    return row ? row.c : 0;
  } catch (err) { return 0; }
}

export async function getRoutingProfileById(env: NyraEnv, userId, profileId) {
  try {
    return await env.DB.prepare("SELECT * FROM routing_profiles WHERE profile_id = ? AND telegram_id = ?").bind(profileId, userId).first();
  } catch (err) { return null; }
}

export async function getDefaultRoutingProfile(env: NyraEnv, userId) {
  try {
    return await env.DB.prepare("SELECT * FROM routing_profiles WHERE telegram_id = ? AND is_default = 1 AND enabled = 1 ORDER BY created_at ASC").bind(userId).first();
  } catch (err) { return null; }
}

export async function getRoutingProfileEntries(env: NyraEnv, profileId) {
  try {
    const res = await env.DB.prepare("SELECT * FROM routing_profile_entries WHERE profile_id = ? ORDER BY priority ASC, created_at ASC").bind(profileId).all();
    return res.results || [];
  } catch (err) { return []; }
}

/** Entries joined with their connection + model row, owner-scoped. */
export async function getRoutingEntriesWithConnections(env: NyraEnv, userId, profileId) {
  try {
    const res = await env.DB.prepare(ENTRY_SELECT).bind(profileId, userId, userId).all();
    return res.results || [];
  } catch (err) {
    console.error("getRoutingEntriesWithConnections failed:", (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

export async function getRoutingProfileBundle(env: NyraEnv, userId, profileId) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return null;
  const entries = await getRoutingProfileEntries(env, profileId);
  return { profile: profile, entries: entries };
}

export async function getRoutingEntryById(env: NyraEnv, profileId, entryId) {
  try {
    return await env.DB.prepare("SELECT * FROM routing_profile_entries WHERE entry_id = ? AND profile_id = ?").bind(entryId, profileId).first();
  } catch (err) { return null; }
}

export async function createRoutingProfile(env: NyraEnv, userId, params) {
  const p = params || {};
  const label = String(p.label === undefined || p.label === null ? "" : p.label).trim();
  if (!label) return { ok: false, error: "label_required" };
  if (label.length > Math.min(MAX_LABEL_LENGTH, MAX_ROUTE_LABEL_LENGTH)) return { ok: false, error: "label_too_long" };
  const ts = now();
  const profileId = generateShortId();
  let isDefault = p.is_default ? 1 : 0;
  try {
    if (!isDefault) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM routing_profiles WHERE telegram_id = ?").bind(userId).first();
      if (row && row.c === 0) isDefault = 1;
    }
    await env.DB.prepare("INSERT INTO routing_profiles (profile_id, telegram_id, label, is_default, enabled, cross_source_fallback, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
      .bind(profileId, userId, label, isDefault, p.cross_source_fallback ? 1 : 0, ts, ts).run();
    return { ok: true, profileId: profileId };
  } catch (err) {
    console.error("createRoutingProfile failed:", (err instanceof Error ? err.message : String(err)));
    return { ok: false, error: "create_failed" };
  }
}

export async function updateRoutingProfile(env: NyraEnv, userId, profileId, updates) {
  const u = updates || {};
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return { ok: false, error: "not_found" };
  const fields: string[] = [];
  const values: unknown[] = [];
  if (u.label !== undefined) {
    const label = String(u.label).trim();
    if (!label) return { ok: false, error: "label_required" };
    fields.push("label = ?"); values.push(label.slice(0, Math.min(MAX_LABEL_LENGTH, MAX_ROUTE_LABEL_LENGTH)));
  }
  if (u.enabled !== undefined) { fields.push("enabled = ?"); values.push(u.enabled ? 1 : 0); }
  if (u.cross_source_fallback !== undefined) { fields.push("cross_source_fallback = ?"); values.push(u.cross_source_fallback ? 1 : 0); }
  if (fields.length === 0) return { ok: true };
  fields.push("updated_at = ?"); values.push(now());
  values.push(profileId, userId);
  try {
    await env.DB.prepare("UPDATE routing_profiles SET " + fields.join(", ") + " WHERE profile_id = ? AND telegram_id = ?").bind.apply(null, values).run();
    return { ok: true };
  } catch (err) {
    console.error("updateRoutingProfile failed:", (err instanceof Error ? err.message : String(err)));
    return { ok: false, error: "update_failed" };
  }
}

export async function deleteRoutingProfile(env: NyraEnv, userId, profileId) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM routing_profile_entries WHERE profile_id = ?").bind(profileId),
      env.DB.prepare("DELETE FROM routing_profiles WHERE profile_id = ? AND telegram_id = ?").bind(profileId, userId),
      env.DB.prepare("UPDATE users SET active_profile_id = NULL, updated_at = ? WHERE telegram_id = ? AND active_profile_id = ?").bind(now(), userId, profileId)
    ]);
    return true;
  } catch (err) {
    console.error("deleteRoutingProfile failed:", (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

export async function setDefaultRoutingProfile(env: NyraEnv, userId, profileId) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE routing_profiles SET is_default = 0 WHERE telegram_id = ?").bind(userId),
      env.DB.prepare("UPDATE routing_profiles SET is_default = 1, updated_at = ? WHERE profile_id = ? AND telegram_id = ?").bind(now(), profileId, userId)
    ]);
    return true;
  } catch (err) {
    console.error("setDefaultRoutingProfile failed:", (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/** Select this profile for the user (users.active_profile_id). */
export async function setActiveRoutingProfile(env: NyraEnv, userId, profileId) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile || profile.enabled !== 1) return false;
  try {
    await env.DB.prepare("UPDATE users SET active_profile_id = ?, updated_at = ? WHERE telegram_id = ?").bind(profileId, now(), userId).run();
    return true;
  } catch (err) {
    console.error("setActiveRoutingProfile failed:", (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

export async function clearActiveRoutingProfile(env: NyraEnv, userId) {
  try {
    await env.DB.prepare("UPDATE users SET active_profile_id = NULL, updated_at = ? WHERE telegram_id = ?").bind(now(), userId).run();
    return true;
  } catch (err) { return false; }
}

async function nextEntryPriority(env: NyraEnv, profileId) {
  try {
    const row = await env.DB.prepare("SELECT MAX(priority) AS m FROM routing_profile_entries WHERE profile_id = ?").bind(profileId).first();
    if (row && row.m !== null && row.m !== undefined) return Number(row.m) + 10;
  } catch (err) {}
  return 100;
}

/**
 * Add an entry. The (profile, connection, model) triple is unique: adding a
 * duplicate is idempotent and returns the existing entry instead of failing.
 */
export async function addRoutingProfileEntry(env: NyraEnv, userId, profileId, params) {
  const p = params || {};
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return { ok: false, error: "not_found" };
  const connectionId = String(p.connection_id === undefined || p.connection_id === null ? "" : p.connection_id).trim();
  const model = String(p.model === undefined || p.model === null ? "" : p.model).trim();
  if (!connectionId) return { ok: false, error: "connection_required" };
  if (!model) return { ok: false, error: "model_required" };
  const existing = await env.DB.prepare("SELECT * FROM routing_profile_entries WHERE profile_id = ? AND connection_id = ? AND model = ?").bind(profileId, connectionId, model).first().catch(function () { return null; });
  if (existing) return { ok: true, entry: existing, existed: true };
  let count = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM routing_profile_entries WHERE profile_id = ?").bind(profileId).first();
    count = row ? Number(row.c) : 0;
  } catch (err) {}
  if (count >= MAX_ROUTE_MODELS) return { ok: false, error: "too_many_entries" };
  let priority = Number(p.priority);
  if (!Number.isFinite(priority)) priority = await nextEntryPriority(env, profileId);
  const ts = now();
  const entryId = generateShortId();
  try {
    await env.DB.prepare("INSERT INTO routing_profile_entries (entry_id, profile_id, connection_id, model, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(entryId, profileId, connectionId, model, Math.trunc(priority), ts, ts).run();
    const stored = await getRoutingEntryById(env, profileId, entryId);
    return { ok: true, entry: stored, existed: false };
  } catch (err) {
    if (String((err instanceof Error ? err.message : String(err)) || "").toLowerCase().indexOf("unique") !== -1) {
      const dup = await env.DB.prepare("SELECT * FROM routing_profile_entries WHERE profile_id = ? AND connection_id = ? AND model = ?").bind(profileId, connectionId, model).first().catch(function () { return null; });
      if (dup) return { ok: true, entry: dup, existed: true };
    }
    console.error("addRoutingProfileEntry failed:", (err instanceof Error ? err.message : String(err)));
    return { ok: false, error: "create_failed" };
  }
}

export async function updateRoutingProfileEntry(env: NyraEnv, userId, profileId, entryId, updates) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return { ok: false, error: "not_found" };
  const u = updates || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  if (u.enabled !== undefined) { fields.push("enabled = ?"); values.push(u.enabled ? 1 : 0); }
  if (u.priority !== undefined) {
    const n = Number(u.priority);
    if (!Number.isFinite(n)) return { ok: false, error: "invalid_priority" };
    fields.push("priority = ?"); values.push(Math.trunc(n));
  }
  if (fields.length === 0) return { ok: true };
  fields.push("updated_at = ?"); values.push(now());
  values.push(entryId, profileId);
  try {
    await env.DB.prepare("UPDATE routing_profile_entries SET " + fields.join(", ") + " WHERE entry_id = ? AND profile_id = ?").bind.apply(null, values).run();
    return { ok: true };
  } catch (err) {
    console.error("updateRoutingProfileEntry failed:", (err instanceof Error ? err.message : String(err)));
    return { ok: false, error: "update_failed" };
  }
}

export async function deleteRoutingProfileEntry(env: NyraEnv, userId, profileId, entryId) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return false;
  try {
    await env.DB.prepare("DELETE FROM routing_profile_entries WHERE entry_id = ? AND profile_id = ?").bind(entryId, profileId).run();
    return true;
  } catch (err) { return false; }
}

/**
 * Rewrite priorities from an ordered entry-id list (primary first). Ids that
 * belong to the profile but are not listed are appended afterwards, so a
 * partial reorder request can never lose an entry from the plan.
 */
export async function reorderRoutingProfileEntries(env: NyraEnv, userId, profileId, entryIds) {
  const profile = await getRoutingProfileById(env, userId, profileId);
  if (!profile) return false;
  const current = await getRoutingProfileEntries(env, profileId);
  if (current.length === 0) return true;
  const known = new Set(current.map(function (e) { return e.entry_id; }));
  const ordered: string[] = [];
  const seen = new Set();
  const requested = Array.isArray(entryIds) ? entryIds : [];
  for (let i = 0; i < requested.length; i++) {
    const id = String(requested[i]);
    if (known.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); }
  }
  for (let i = 0; i < current.length; i++) {
    if (!seen.has(current[i].entry_id)) { seen.add(String(current[i].entry_id)); ordered.push(String(current[i].entry_id)); }
  }
  const ts = now();
  try {
    const batch = ordered.map(function (id, index) {
      return env.DB.prepare("UPDATE routing_profile_entries SET priority = ?, updated_at = ? WHERE entry_id = ? AND profile_id = ?")
        .bind((index + 1) * 10, ts, id, profileId);
    });
    await env.DB.batch(batch);
    return true;
  } catch (err) {
    console.error("reorderRoutingProfileEntries failed:", (err instanceof Error ? err.message : String(err)));
    return false;
  }
}
