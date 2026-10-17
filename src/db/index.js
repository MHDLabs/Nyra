// Storage facade. `src/db.js` re-exports this verbatim, so no caller has to
// know how storage is split internally.
//
//   schema.js       D1 schema bootstrap, versioned migrations, housekeeping
//   identity.js     bot id / @username, KV-backed cache
//   users.js        users, chats, threads, block list, conversation flow state
//   usage.js        per-user token and request accounting
//   connections.js  AI connection CRUD, health, active-connection resolution
//   routes.js       route (multi-model x multi-token) CRUD, streaming plan
//   settings.js     global app_settings toggles

export {
  ensureSchema, maybeInitSchema
} from "./schema.js";

export {
  getBotIdentity
} from "./identity.js";

export {
  getUser, upsertUser, getChat, recordGroupChatAndCheckAccess, isUserBlocked,
  saveThreadMessage, getThreadContext, isGroupTrigger, determineThreadId,
  getFlowState, setFlowState, clearFlowState
} from "./users.js";

export {
  trackConnectionUsage, getConnectionUsageStats, getAllConnectionUsageStats,
  parseUsageStats, updateUsageStatsAsync
} from "./usage.js";

export {
  getUserConnections, getEnabledUserConnections, getUserConnectionById,
  saveGlobalConnection, updateUserConnection, deleteUserConnection,
  toggleUserConnection, setDefaultConnection, setConnectionFast,
  setConnectionVision, updateUserConnectionTest, recordConnectionFailure,
  recordConnectionSuccess, resolveUserActiveConnection,
  countPersonalConnections
} from "./connections.js";

export {
  getUserRoutes, getRouteById, getRouteModels, getRouteTokens,
  getRouteBundle, buildRoutePlan, resolveUserActiveRoute, saveRoute,
  updateRoute, deleteRoute, setDefaultRoute, addRouteModel, removeRouteModel,
  setRouteDefaultModel, addRouteToken, removeRouteToken, toggleRouteToken,
  recordRouteTokenFailure, recordRouteTokenSuccess
} from "./routes.js";

export {
  getSetting, setSetting, isPersonalModelsAllowed, getPersonalModelLimit
} from "./settings.js";
