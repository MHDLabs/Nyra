// Nyra — Mini App API barrel.
//
// `src/miniapp.js` re-exports this so the historical import path stays valid.
// The route table lives in `./router.js`; the handlers are grouped by domain.
export {
  validateInitData, extractInitData, handleAuth
} from "./auth.js";

export {
  handleUserProfile, handleUserStats, handleChatMessage,
  handleUserConnections, handleSetActiveConnection, handleToggleCodingMode
} from "./user.js";

export {
  handlePersonalModels, handleCreatePersonalModel, handleDeletePersonalModel
} from "./personal.js";

export {
  handleUserRoutes, handleAdminCreateRoute, handleAdminDeleteRoute,
  handleAdminRouteAction
} from "./routes.js";

export {
  handleAdminStats, handleAdminUsers, handleAdminChats, handleAdminSettings,
  handleAdminUpdateSettings, handleAdminConnectionUsage
} from "./admin.js";

export {
  handleAdminBroadcasts, handleCreateBroadcast, handleBroadcastAction,
  handleGetBroadcast
} from "./broadcast-api.js";

export {
  handleAdminFailedUpdates, handleReplayFailedUpdate
} from "./dlq-api.js";

export {
  handleUserMemory, handleSetMemoryMode, handleClearMemory,
  handlePersonalities, handleSetPersonality, handleCustomInstructions,
  handleAdminConnectionToggle
} from "./preferences.js";

export {
  routeMiniAppAPI
} from "./router.js";
