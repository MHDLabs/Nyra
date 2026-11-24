import type { NyraEnv } from "../../types/env.js";
import type { TelegramId } from "../../types/domain.js";
// Emergency maintenance switch: persistent admin-only toggle that blocks ordinary AI responses.
import { getSetting, setSetting } from "./settings.js";
import { isAdmin } from "../utils.js";

const MAINTENANCE_KEY = "maintenance_enabled";
const MAINTENANCE_CONFIRM_KEY = "emergency_maintenance_confirmed_by";

export async function isMaintenanceMode(env: NyraEnv): Promise<boolean> {
  const val = await getSetting(env, MAINTENANCE_KEY, "0");
  return val === "1" || val === "true";
}

export async function setMaintenanceMode(env: NyraEnv, enabled: boolean, adminId: TelegramId): Promise<void> {
  // A zero actor is reserved for the authenticated web-admin session.
  if (String(adminId) !== "0" && !isAdmin(env, adminId)) throw new Error("Administrator access required.");
  const saved = await setSetting(env, MAINTENANCE_KEY, enabled ? "1" : "0", adminId);
  if (!saved) throw new Error("Could not persist maintenance mode.");
  if (enabled) {
    await setSetting(env, MAINTENANCE_CONFIRM_KEY, String(adminId), adminId);
  }
}

export async function getMaintenanceConfirmedBy(env: NyraEnv): Promise<number | null> {
  const val = await getSetting(env, MAINTENANCE_CONFIRM_KEY, null);
  return val ? parseInt(val, 10) : null;
}
