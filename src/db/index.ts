// Storage facade for retained Nyra capabilities.
export {
  ensureSchema, maybeInitSchema, hasPendingMigrations
} from "./schema.js";

export { getBotIdentity } from "./identity.js";

export {
  getUser, getUserStrict, upsertUser, touchLastInbound, getChat, recordGroupChatAndCheckAccess, isUserBlocked,
  saveThreadMessage, getThreadContext, isGroupTrigger, determineThreadId,
  getFlowState, setFlowState, clearFlowState, blockUser, unblockUser
} from "./users.js";

export {
  logChatMessage, listPrivateChatUsers, listGroupChats, listChatMessages, detectMediaType
} from "./chat-logs.js";

export { parseUsageStats, updateUsageStatsAsync } from "./usage.js";

export {
  getSetting, setSetting, getTriggerConfig, setTriggerFlag, setTriggerWords,
  isGuestModeEnabled, detectGuestContext
} from "./settings.js";

export {
  isMaintenanceMode, setMaintenanceMode, getMaintenanceConfirmedBy
} from "./maintenance.js";
