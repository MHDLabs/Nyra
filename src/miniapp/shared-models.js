// Admin-managed shared models: the operator's own connections, exposed to
// keyless users under the shared-service quota.
//
// This is not a second connection system — every write goes through the same
// `ai_connections` table and the same `saveGlobalConnection` /
// `updateUserConnection` / `deleteUserConnection` helpers the Telegram wizard
// uses. The only new thing is the admin HTTP surface, which exists because the
// wizard was the *only* way to create a global connection and the Mini App had
// no way to turn the shared service on.
//
// Two rules hold for every response here:
//   1. `encrypted_key` / `key_iv` are never selected, so a stored credential
//      cannot leak to the browser no matter what the client asks for.
//   2. Every mutation re-checks admin status server side; the router gate is a
//      first line, not the only one.
import {
  getUserConnectionById, saveGlobalConnection,
  updateUserConnection, deleteUserConnection, setDefaultConnection,
  setGlobalConnectionEnabled, getSharedServiceSettings, setSharedServiceSettings,
  listGlobalConnections, countEnabledSharedConnections
} from "../db.js";
import { encryptCredential } from "../crypto.js";
import { normalizeBaseUrl, isAdmin } from "../utils.js";
import { testConnectionRaw, fetchAvailableModels } from "../providers/models.js";
import { MAX_LABEL_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_MODEL_LENGTH, MAX_URL_LENGTH, MAX_API_KEY_LENGTH } from "../config.js";
import { jsonOk, jsonError } from "./respond.js";

const PROVIDERS = ["openai-compatible", "anthropic"];

function normalizeProvider(raw) {
  return String(raw || "").toLowerCase() === "anthropic" ? "anthropic" : "openai-compatible";
}

/** Row shape safe to return: no ciphertext, no plaintext key, nothing derived. */
function publicRow(row) {
  return {
    connection_id: row.connection_id,
    label: row.label,
    provider: row.provider,
    base_url: row.base_url || "",
    model: row.model,
    description: row.description || "",
    enabled: row.enabled === 1,
    is_default: row.is_default === 1,
    is_fast: row.is_fast === 1,
    supports_vision: row.supports_vision === 1,
    has_key: !!(row.encrypted_key || row.has_key),
    last_test_status: row.last_test_status || null,
    last_test_error: row.last_test_error || null,
    last_test_diagnostic: row.last_test_diagnostic || null,
    last_test_at: row.last_test_at || null,
    consecutive_failures: row.consecutive_failures || 0
  };
}

/**
 * The exact state users will experience. `ready` is true only when the switch
 * is on AND at least one enabled shared model exists — the same predicate the
 * request path enforces, so the panel can never claim a service that is not
 * actually serving.
 */
async function readiness(env) {
  const [settings, enabledModels] = await Promise.all([
    getSharedServiceSettings(env),
    countEnabledSharedConnections(env)
  ]);
  const ready = settings.enabled && enabledModels > 0;
  let reason = null;
  if (!settings.enabled) reason = "disabled_by_admin";
  else if (enabledModels === 0) reason = "no_shared_model";
  return { settings: settings, enabled_models: enabledModels, ready: ready, reason: reason };
}

async function listShared(env) {
  const globals = (await listGlobalConnections(env))
    .map(publicRow)
    .sort(function (a, b) { return (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0); });
  const state = await readiness(env);
  return { models: globals, settings: state.settings, enabled_models: state.enabled_models, ready: state.ready, reason: state.reason };
}

function validateFields(body, partial) {
  const out = {};
  if (!partial || body.label !== undefined) {
    const label = String(body.label === undefined ? "" : body.label).trim();
    if (!label) return { error: "label is required" };
    if (label.length > MAX_LABEL_LENGTH) return { error: "label too long (max " + MAX_LABEL_LENGTH + ")" };
    out.label = label;
  }
  if (!partial || body.model !== undefined) {
    const model = String(body.model === undefined ? "" : body.model).trim();
    if (!model) return { error: "model is required" };
    if (model.length > MAX_MODEL_LENGTH) return { error: "model too long (max " + MAX_MODEL_LENGTH + ")" };
    out.model = model;
  }
  if (!partial || body.base_url !== undefined) {
    const raw = String(body.base_url === undefined ? "" : body.base_url);
    if (raw.length > MAX_URL_LENGTH) return { error: "base_url too long (max " + MAX_URL_LENGTH + ")" };
    out.base_url_raw = raw;
  }
  if (body.description !== undefined) {
    const desc = String(body.description).trim();
    if (desc.length > MAX_DESCRIPTION_LENGTH) return { error: "description too long (max " + MAX_DESCRIPTION_LENGTH + ")" };
    out.description = desc;
  }
  if (body.provider !== undefined) {
    const provider = normalizeProvider(body.provider);
    if (PROVIDERS.indexOf(String(body.provider).toLowerCase()) === -1 && String(body.provider).toLowerCase() !== "openai") {
      return { error: "unsupported provider" };
    }
    out.provider = provider;
  }
  out.api_key = body.api_key === undefined || body.api_key === null ? undefined : String(body.api_key);
  if (out.api_key !== undefined && out.api_key.length > MAX_API_KEY_LENGTH) return { error: "api_key too long (max " + MAX_API_KEY_LENGTH + ")" };
  return { fields: out };
}

/** List every shared model plus the shared-service switch and its readiness. */
export async function handleAdminSharedModels(env, adminId) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  try {
    return jsonOk(await listShared(env));
  } catch (err) {
    console.error("handleAdminSharedModels failed:", err.message);
    return jsonError(500, "Failed to load shared models");
  }
}

/**
 * Create a shared model. The connection is tested against the provider BEFORE
 * it is stored, so "saved" always means "this model answered". A model that
 * fails the probe is still storable only via `force`, which the UI does not
 * use — that keeps an unusable row from silently becoming the default.
 */
export async function handleAdminCreateSharedModel(env, adminId, body) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  const check = validateFields(body || {}, false);
  if (check.error) return jsonError(400, check.error);
  const f = check.fields;
  if (!f.api_key) return jsonError(400, "api_key is required for a new shared model");
  const provider = f.provider || "openai-compatible";
  const baseUrl = normalizeBaseUrl(provider, f.base_url_raw);
  if (!baseUrl) return jsonError(400, "base_url must be a valid http(s) URL");

  try {
    const test = await testConnectionRaw(provider, baseUrl, f.api_key, f.model);
    if (test.status !== "success") {
      return jsonOk({
        error: "Model test failed: " + (test.diagnostic || test.error || test.status),
        test_status: test.status,
        diagnostic: test.diagnostic || null,
        latency: test.latency || 0
      }, 400);
    }
    const connectionId = await saveGlobalConnection(env, adminId, {
      label: f.label,
      provider: provider,
      base_url: baseUrl,
      model: f.model,
      api_key: f.api_key,
      description: f.description || ""
    });
    // First usable shared model becomes the default so a keyless user has
    // something to resolve without a second admin action.
    const enabled = await countEnabledSharedConnections(env);
    if (enabled <= 1) await setDefaultConnection(env, adminId, connectionId);
    const payload = await listShared(env);
    payload.created = connectionId;
    payload.test = { status: test.status, latency: test.latency || 0 };
    return jsonOk(payload);
  } catch (err) {
    console.error("handleAdminCreateSharedModel failed:", err.message);
    return jsonError(500, "Failed to create shared model");
  }
}

/** Update a shared model. `api_key` is optional: omitting it keeps the stored one. */
export async function handleAdminUpdateSharedModel(env, adminId, connectionId, body) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn || conn.is_global !== 1) return jsonError(404, "Shared model not found");

  const check = validateFields(body || {}, true);
  if (check.error) return jsonError(400, check.error);
  const f = check.fields;
  const updates = {};
  if (f.label !== undefined) updates.label = f.label;
  if (f.model !== undefined) updates.model = f.model;
  if (f.description !== undefined) updates.description = f.description;
  if (f.provider !== undefined) updates.provider = f.provider;
  if (f.base_url_raw !== undefined) {
    const baseUrl = normalizeBaseUrl(f.provider || conn.provider, f.base_url_raw);
    if (!baseUrl) return jsonError(400, "base_url must be a valid http(s) URL");
    updates.base_url = baseUrl;
  }
  if (f.api_key) {
    const enc = await encryptCredential(env, adminId, f.api_key);
    updates.encrypted_key = enc.ct;
    updates.key_iv = enc.iv;
  }
  try {
    const ok = await updateUserConnection(env, adminId, connectionId, updates);
    if (!ok) return jsonError(403, "Not allowed");
    const payload = await listShared(env);
    return jsonOk(payload);
  } catch (err) {
    console.error("handleAdminUpdateSharedModel failed:", err.message);
    return jsonError(500, "Failed to update shared model");
  }
}

/** Probe a stored shared model with its own decrypted key. */
export async function handleAdminTestSharedModel(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn || conn.is_global !== 1) return jsonError(404, "Shared model not found");
  try {
    const { testUserConnectionById } = await import("../providers/models.js");
    const test = await testUserConnectionById(env, adminId, connectionId);
    const payload = await listShared(env);
    payload.test = { status: test.status, error: test.error || null, diagnostic: test.diagnostic || null, latency: test.latency || 0 };
    return jsonOk(payload, test.status === "success" ? 200 : 400);
  } catch (err) {
    console.error("handleAdminTestSharedModel failed:", err.message);
    return jsonError(500, "Failed to test shared model");
  }
}

/** Enable/disable one shared model, or make it the default fallback target. */
export async function handleAdminSharedModelAction(env, adminId, connectionId, action) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  if (action !== "enable" && action !== "disable" && action !== "default") return jsonError(400, "Unknown action");
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn || conn.is_global !== 1) return jsonError(404, "Shared model not found");
  try {
    const ok = action === "default"
      ? await setDefaultConnection(env, adminId, connectionId)
      : await setGlobalConnectionEnabled(env, adminId, connectionId, action === "enable");
    if (!ok) return jsonError(403, "Not allowed");
    return jsonOk(await listShared(env));
  } catch (err) {
    console.error("handleAdminSharedModelAction failed:", err.message);
    return jsonError(500, "Failed to update shared model");
  }
}

export async function handleAdminDeleteSharedModel(env, adminId, connectionId) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  const conn = await getUserConnectionById(env, adminId, connectionId);
  if (!conn || conn.is_global !== 1) return jsonError(404, "Shared model not found");
  try {
    const ok = await deleteUserConnection(env, adminId, connectionId);
    if (!ok) return jsonError(403, "Not allowed");
    return jsonOk(await listShared(env));
  } catch (err) {
    console.error("handleAdminDeleteSharedModel failed:", err.message);
    return jsonError(500, "Failed to delete shared model");
  }
}

/**
 * Turn the shared service on/off and set its daily quotas. Enabling with no
 * usable model is rejected outright: otherwise users get a service that claims
 * to be on and cannot answer.
 */
export async function handleAdminSharedServiceSettings(env, adminId, body) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  try {
    const requested = body && body.shared_service ? body.shared_service : body;
    if (requested && requested.enabled === true) {
      const usable = await countEnabledSharedConnections(env);
      if (usable === 0) {
        return jsonOk({
          error: "Add and enable at least one shared model before turning the shared service on.",
          enabled_models: 0,
          settings: await getSharedServiceSettings(env),
          ready: false,
          reason: "no_shared_model"
        }, 400);
      }
    }
    const res = await setSharedServiceSettings(env, adminId, requested);
    if (!res.ok) return jsonError(400, res.error);
    return jsonOk(await listShared(env));
  } catch (err) {
    console.error("handleAdminSharedServiceSettings failed:", err.message);
    return jsonError(500, "Failed to save shared service settings");
  }
}

/**
 * Model discovery for the "add shared model" form. Falls back to manual entry
 * on the client when this fails, because some compatible endpoints do not
 * implement /models at all.
 */
export async function handleAdminDiscoverModels(env, adminId, body) {
  if (!isAdmin(env, adminId)) return jsonError(403, "Forbidden");
  const provider = normalizeProvider(body && body.provider);
  const baseUrl = normalizeBaseUrl(provider, body && body.base_url);
  if (!baseUrl) return jsonError(400, "base_url must be a valid http(s) URL");
  let apiKey = body && body.api_key ? String(body.api_key) : "";
  if (!apiKey && body && body.connection_id) {
    const conn = await getUserConnectionById(env, adminId, body.connection_id);
    if (!conn || conn.is_global !== 1) return jsonError(404, "Shared model not found");
    const { decryptCredential } = await import("../crypto.js");
    try { apiKey = await decryptCredential(env, conn.telegram_id, conn.encrypted_key, conn.key_iv); }
    catch (err) { return jsonError(400, "Stored key could not be decrypted"); }
  }
  if (!apiKey) return jsonError(400, "api_key is required");
  try {
    const res = await fetchAvailableModels(provider, baseUrl, apiKey);
    if (res && res.error) return jsonError(400, "Model discovery failed: " + res.error);
    return jsonOk({ models: (res && res.models) || [] });
  } catch (err) {
    console.error("handleAdminDiscoverModels failed:", err.message);
    return jsonError(502, "Model discovery failed");
  }
}
