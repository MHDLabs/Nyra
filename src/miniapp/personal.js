// Per-user personal model connections, gated by the admin-controlled
// `personal_models_allowed` setting and the per-user limit.
import { getUserConnectionById, getUserConnections, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections, saveGlobalConnection, deleteUserConnection } from "../db.js";
import { jsonOk, jsonError } from "./respond.js";
import { normalizeBaseUrl } from "../utils.js";
import { testConnectionRaw } from "../providers/models.js";
import { MAX_API_KEY_LENGTH, MAX_MODEL_LENGTH } from "../config.js";

// The adapters only understand two dialects. Anything else (a UI that sends
// "openai", a typo) silently routed to the wrong URL builder before.
function normalizeProvider(raw) {
  return String(raw || "").toLowerCase() === "anthropic" ? "anthropic" : "openai-compatible";
}

/** Non-admin personal models: list, gated by the global toggle. */
export async function handlePersonalModels(env, userId) {
  try {
    const allowed = await isPersonalModelsAllowed(env);
    const limit = await getPersonalModelLimit(env);
    const conns = await getUserConnections(env, userId);
    const mine = conns.filter(function (c) { return c.is_global === 0; }).map(function (c) { return { connection_id: c.connection_id, label: c.label, model: c.model, provider: c.provider, enabled: c.enabled }; });
    return jsonOk({ allowed: allowed, limit: limit, count: mine.length, models: mine });
  } catch (err) { return jsonError(500, "Failed to load personal models"); }
}

/** Non-admin: create a personal model, gated by the global toggle and limit. */
export async function handleCreatePersonalModel(env, userId, body) {
  try {
    if (!(await isPersonalModelsAllowed(env))) return jsonError(403, "Forbidden");
    if (!body || !body.label || !body.model || !body.api_key) return jsonError(400, "Missing fields");
    const provider = normalizeProvider(body.provider);
    const baseUrl = normalizeBaseUrl(provider, body.base_url);
    if (!baseUrl) return jsonError(400, "Invalid base_url");
    if (String(body.api_key).length > MAX_API_KEY_LENGTH || String(body.model).length > MAX_MODEL_LENGTH) {
      return jsonError(400, "Field too long");
    }
    const limit = await getPersonalModelLimit(env);
    const used = await countPersonalConnections(env, userId);
    if (used >= limit) return jsonError(403, "Personal model limit reached");
    // Test BEFORE saving. Reporting "saved" for a connection that cannot answer
    // is the bug this replaces: the user only finds out on their next message.
    const test = await testConnectionRaw(provider, baseUrl, body.api_key, String(body.model).trim());
    if (test.status !== "success") {
      // Diagnostic carries the provider's HTTP status and usually enough detail
      // to tell an auth failure from a wrong model name or a bad endpoint.
      return new Response(JSON.stringify({
        error: "Model test failed: " + (test.diagnostic || test.error || test.status),
        test_status: test.status,
        diagnostic: test.diagnostic || null,
        latency: test.latency || 0
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    await saveGlobalConnection(env, userId, {
      label: body.label,
      provider: provider,
      base_url: baseUrl,
      model: String(body.model).trim(),
      api_key: body.api_key,
      description: body.description || "",
      personal: true
    });
    return await handlePersonalModels(env, userId);
  } catch (err) { return jsonError(500, "Failed to create personal model"); }
}

/** Non-admin: delete one of their own personal models. */
export async function handleDeletePersonalModel(env, userId, connectionId) {
  try {
    if (!(await isPersonalModelsAllowed(env))) return jsonError(403, "Forbidden");
    const conn = await getUserConnectionById(env, userId, connectionId);
    if (!conn || conn.is_global === 1 || conn.telegram_id !== userId) return jsonError(403, "Not allowed");
    await deleteUserConnection(env, userId, connectionId);
    return await handlePersonalModels(env, userId);
  } catch (err) { return jsonError(500, "Failed to delete personal model"); }
}
