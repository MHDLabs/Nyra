// Per-user personal model connections, gated by the admin-controlled
// `personal_models_allowed` setting and the per-user limit.
import { getUserConnectionById, getUserConnections, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections, saveGlobalConnection, deleteUserConnection } from "../db.js";

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
    const limit = await getPersonalModelLimit(env);
    const used = await countPersonalConnections(env, userId);
    if (used >= limit) return jsonError(403, "Personal model limit reached");
    await saveGlobalConnection(env, userId, {
      label: body.label,
      provider: body.provider || "openai",
      base_url: body.base_url || "",
      model: body.model,
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
