// Connection models: the model names one AI connection can serve.
//
// A connection owns the endpoint and the encrypted credential; a model is just
// a name sent to that endpoint. Keeping them in separate tables is what stops
// adding a second model from duplicating the Base URL and the API key, and what
// lets one connection be listed, verified and routed per model.
//
// Invariants:
//  - (connection_id, model) is unique, but a model name may appear on any
//    number of connections: names are not globally unique.
//  - last_error never stores a credential: every write goes through
//    redactErrorMessage, which strips bearer tokens and sk-* keys.
//  - the API shape (publicConnectionModel) exposes no ciphertext and no key.
import { generateShortId, now, truncate } from "../utils.js";
import { MAX_LABEL_LENGTH, MAX_MODEL_LENGTH } from "../config.js";

export const MODEL_SOURCES = ["manual", "discovered"];
export const MODEL_VERIFY_STATES = ["unverified", "verified", "unavailable"];

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  [/\b(?:x-api-key|api[_-]?key|authorization|secret|token)\b\s*[:=]\s*["']?[^"'\s,}{]{6,}/gi, "$1 [redacted]"]
];

/** Remove anything that looks like a credential from an error string. */
export function redactErrorMessage(message) {
  let text = String(message === undefined || message === null ? "" : message);
  for (let i = 0; i < SECRET_PATTERNS.length; i++) text = text.replace(SECRET_PATTERNS[i][0], SECRET_PATTERNS[i][1]);
  return truncate(text, 300);
}

/** Normalize a verification state, defaulting to unverified. */
export function normalizeVerifyStatus(value) {
  const raw = String(value || "").toLowerCase();
  return MODEL_VERIFY_STATES.indexOf(raw) === -1 ? "unverified" : raw;
}

/** Row shape safe to return from a Mini App endpoint: no key material. */
export function publicConnectionModel(row, defaultModel) {
  if (!row) return null;
  return {
    model_id: row.model_id,
    model: row.model,
    label: row.label || row.model,
    source: MODEL_SOURCES.indexOf(row.source) === -1 ? "manual" : row.source,
    enabled: row.enabled === 1,
    verify_status: normalizeVerifyStatus(row.verify_status),
    verified_at: row.verified_at === undefined ? null : row.verified_at,
    last_error: row.last_error ? redactErrorMessage(row.last_error) : null,
    display_order: row.display_order === undefined ? 100 : row.display_order,
    is_default_model: defaultModel !== undefined && defaultModel !== null && row.model === defaultModel
  };
}

export async function listConnectionModels(env, connectionId) {
  try {
    const res = await env.DB.prepare("SELECT * FROM connection_models WHERE connection_id = ? ORDER BY display_order ASC, created_at ASC, model ASC").bind(connectionId).all();
    return res.results || [];
  } catch (err) {
    // A pre-migration database (or a deliberately minimal test stub) must
    // degrade to no model rows, never break the request.
    return [];
  }
}

export async function countConnectionModels(env, connectionId) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM connection_models WHERE connection_id = ?").bind(connectionId).first();
    return row ? row.c : 0;
  } catch (err) { return 0; }
}

export async function getConnectionModelById(env, connectionId, modelId) {
  try {
    return await env.DB.prepare("SELECT * FROM connection_models WHERE connection_id = ? AND model_id = ?").bind(connectionId, modelId).first();
  } catch (err) { return null; }
}

export async function getConnectionModelByName(env, connectionId, model) {
  try {
    return await env.DB.prepare("SELECT * FROM connection_models WHERE connection_id = ? AND model = ?").bind(connectionId, model).first();
  } catch (err) { return null; }
}

/** Idempotent insert used by the connection write paths. */
export async function ensureConnectionModel(env, connectionId, model, displayOrder) {
  const name = String(model === undefined || model === null ? "" : model).trim();
  if (!connectionId || !name) return null;
  const existing = await getConnectionModelByName(env, connectionId, name);
  if (existing) return existing;
  const ts = now();
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO connection_models (model_id, connection_id, model, label, source, enabled, verify_status, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 1, 'unverified', ?, ?, ?)")
      .bind(connectionId + ":" + name, connectionId, name, name, displayOrder === undefined ? 100 : displayOrder, ts, ts).run();
    return await getConnectionModelByName(env, connectionId, name);
  } catch (err) {
    console.error("ensureConnectionModel failed:", err.message);
    return null;
  }
}

/**
 * Add a model to a connection (manual or discovered).
 * Returns { ok: true, model } with the stored row, or { ok: false, error }.
 * Adding an existing (connection, model) pair is idempotent and returns the
 * existing row rather than failing the whole form.
 */
export async function addConnectionModel(env, connectionId, params) {
  const p = params || {};
  const name = String(p.model === undefined || p.model === null ? "" : p.model).trim();
  if (!connectionId) return { ok: false, error: "missing_connection" };
  if (!name) return { ok: false, error: "model_required" };
  if (name.length > MAX_MODEL_LENGTH) return { ok: false, error: "model_too_long" };
  const label = String(p.label === undefined || p.label === null || p.label === "" ? name : p.label).trim().slice(0, MAX_LABEL_LENGTH);
  const source = MODEL_SOURCES.indexOf(p.source) === -1 ? "manual" : p.source;
  const existing = await getConnectionModelByName(env, connectionId, name);
  if (existing) return { ok: true, model: existing, existed: true };
  const ts = now();
  let order = p.display_order;
  if (order === undefined || order === null || !Number.isFinite(Number(order))) {
    order = 100;
    try {
      const row = await env.DB.prepare("SELECT MAX(display_order) AS m FROM connection_models WHERE connection_id = ?").bind(connectionId).first();
      if (row && row.m !== null && row.m !== undefined) order = Number(row.m) + 10;
    } catch (err) {}
  }
  try {
    await env.DB.prepare("INSERT INTO connection_models (model_id, connection_id, model, label, source, enabled, verify_status, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'unverified', ?, ?, ?)")
      .bind(generateShortId(), connectionId, name, label, source, order, ts, ts).run();
    const stored = await getConnectionModelByName(env, connectionId, name);
    return stored ? { ok: true, model: stored, existed: false } : { ok: false, error: "insert_failed" };
  } catch (err) {
    if (String(err.message || "").toLowerCase().indexOf("unique") !== -1) {
      const stored = await getConnectionModelByName(env, connectionId, name);
      if (stored) return { ok: true, model: stored, existed: true };
    }
    console.error("addConnectionModel failed:", err.message);
    return { ok: false, error: "insert_failed" };
  }
}

/** Update label/enabled/display_order. Returns { ok, model?, error? }. */
export async function updateConnectionModel(env, connectionId, modelId, updates) {
  const u = updates || {};
  const fields = [];
  const values = [];
  if (u.label !== undefined) {
    const label = String(u.label).trim();
    if (!label) return { ok: false, error: "label_required" };
    fields.push("label = ?"); values.push(label.slice(0, MAX_LABEL_LENGTH));
  }
  if (u.enabled !== undefined) { fields.push("enabled = ?"); values.push(u.enabled ? 1 : 0); }
  if (u.display_order !== undefined) {
    const n = Number(u.display_order);
    if (!Number.isFinite(n)) return { ok: false, error: "invalid_display_order" };
    fields.push("display_order = ?"); values.push(Math.trunc(n));
  }
  if (u.verify_status !== undefined) {
    fields.push("verify_status = ?"); values.push(normalizeVerifyStatus(u.verify_status));
  }
  if (fields.length === 0) {
    const current = await getConnectionModelById(env, connectionId, modelId);
    return current ? { ok: true, model: current } : { ok: false, error: "not_found" };
  }
  fields.push("updated_at = ?"); values.push(now());
  values.push(modelId, connectionId);
  try {
    await env.DB.prepare("UPDATE connection_models SET " + fields.join(", ") + " WHERE model_id = ? AND connection_id = ?").bind.apply(null, values).run();
    const current = await getConnectionModelById(env, connectionId, modelId);
    return current ? { ok: true, model: current } : { ok: false, error: "not_found" };
  } catch (err) {
    console.error("updateConnectionModel failed:", err.message);
    return { ok: false, error: "update_failed" };
  }
}

export async function deleteConnectionModel(env, connectionId, modelId) {
  try {
    const res = await env.DB.prepare("DELETE FROM connection_models WHERE model_id = ? AND connection_id = ?").bind(modelId, connectionId).run();
    return !(res && res.meta && res.meta.changes === 0);
  } catch (err) { return false; }
}

/** Make one model the connection primary model (mirrored onto ai_connections.model). */
export async function setDefaultConnectionModel(env, connectionId, modelId) {
  const row = await getConnectionModelById(env, connectionId, modelId);
  if (!row) return false;
  try {
    await env.DB.prepare("UPDATE ai_connections SET model = ?, updated_at = ? WHERE connection_id = ?").bind(row.model, now(), connectionId).run();
    return true;
  } catch (err) { console.error("setDefaultConnectionModel failed:", err.message); return false; }
}

/** Record a verification result. unavailable is a state, not a delete. */
export async function setConnectionModelVerification(env, connectionId, modelId, status, lastError) {
  const state = normalizeVerifyStatus(status);
  const ts = now();
  const error = state === "verified" ? null : redactErrorMessage(lastError || "");
  try {
    await env.DB.prepare("UPDATE connection_models SET verify_status = ?, verified_at = ?, last_error = ?, updated_at = ? WHERE model_id = ? AND connection_id = ?")
      .bind(state, state === "verified" ? ts : null, error, ts, modelId, connectionId).run();
    return true;
  } catch (err) {
    console.error("setConnectionModelVerification failed:", err.message);
    return false;
  }
}

/**
 * Enabled model rows for a connection, used by the router when building the
 * implicit fallback list. Returns [] when the table is empty/unavailable.
 */
export async function listEnabledModelsForConnection(env, connectionId) {
  const all = await listConnectionModels(env, connectionId);
  return all.filter(function (row) { return row.enabled === 1; });
}
