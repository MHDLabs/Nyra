// Route (multi-model failover bundle) CRUD shared by the self-service view
// and the admin panel; both call the same handlers with the admin's user id.
import { getUserRoutes, getRouteById, getRouteModels, getRouteTokens, getRouteBundle, saveRoute, updateRoute, deleteRoute, setDefaultRoute, addRouteModel, removeRouteModel, setRouteDefaultModel, addRouteToken, removeRouteToken, toggleRouteToken } from "../db.js";
import { jsonOk, jsonError } from "./respond.js";

/** List routes the user can see (admin: all their routes; user: routes available). */
export async function handleUserRoutes(env, userId) {
  try {
    const routes = await getUserRoutes(env, userId);
    const out = [];
    for (let i = 0; i < routes.length; i++) {
      const models = await getRouteModels(env, routes[i].route_id);
      const tokens = await getRouteTokens(env, routes[i].route_id);
      out.push({
        route_id: routes[i].route_id,
        label: routes[i].label,
        provider: routes[i].provider,
        is_default: routes[i].is_default,
        models: models.map(function (m) { return { model_id: m.model_id, model: m.model, is_default: m.is_default }; }),
        token_count: tokens.length,
        enabled_token_count: tokens.filter(function (t) { return t.enabled === 1; }).length
      });
    }
    return jsonOk({ routes: out });
  } catch (err) { return jsonError(500, "Failed to load routes"); }
}

/** Admin: create a route. */
export async function handleAdminCreateRoute(env, userId, body) {
  try {
    if (!body || !body.label || !body.provider) return jsonError(400, "Missing fields");
    const routeId = await saveRoute(env, userId, { label: body.label, provider: body.provider, base_url: body.base_url || "", models: body.models || [], tokens: body.tokens || [] });
    return jsonOk({ success: true, route_id: routeId });
  } catch (err) { return jsonError(500, "Failed to create route"); }
}

/** Admin: delete a route. */
export async function handleAdminDeleteRoute(env, userId, routeId) {
  try {
    const ok = await deleteRoute(env, userId, routeId);
    return ok ? jsonOk({ success: true }) : jsonError(404, "Route not found");
  } catch (err) { return jsonError(500, "Failed to delete route"); }
}

/** Admin: route sub-actions (models, tokens, default, update). */
export async function handleAdminRouteAction(env, userId, routeId, action, body) {
  try {
    const route = await getRouteById(env, userId, routeId);
    if (!route) return jsonError(404, "Route not found");
    switch (action) {
      case "update":
        await updateRoute(env, userId, routeId, { label: body.label, provider: body.provider, base_url: body.base_url });
        break;
      case "default":
        await setDefaultRoute(env, userId, routeId);
        break;
      case "model-add":
        if (!body.model) return jsonError(400, "Missing model");
        await addRouteModel(env, userId, routeId, body.model);
        break;
      case "model-remove":
        if (!body.model_id) return jsonError(400, "Missing model_id");
        await removeRouteModel(env, userId, routeId, body.model_id);
        break;
      case "model-default":
        if (!body.model_id) return jsonError(400, "Missing model_id");
        await setRouteDefaultModel(env, userId, routeId, body.model_id);
        break;
      case "token-add":
        if (!body.api_key) return jsonError(400, "Missing api_key");
        await addRouteToken(env, userId, routeId, body.api_key, body.label);
        break;
      case "token-remove":
        if (!body.token_id) return jsonError(400, "Missing token_id");
        await removeRouteToken(env, userId, routeId, body.token_id);
        break;
      case "token-toggle":
        if (!body.token_id) return jsonError(400, "Missing token_id");
        await toggleRouteToken(env, userId, routeId, body.token_id);
        break;
      default:
        return jsonError(400, "Unknown action");
    }
    const bundle = await getRouteBundle(env, userId, routeId);
    return jsonOk({ success: true, route: bundle });
  } catch (err) { return jsonError(500, "Route action failed"); }
}
