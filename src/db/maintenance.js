// Emergency maintenance switch: persistent admin-only toggle that blocks ordinary AI responses.
// Uses app_settings for authoritative state shared across all instances.
import { now, isAdmin } from "../utils.js";
import { getSetting, setSetting } from "./settings.js";

const MAINTENANCE_KEY = "emergency_maintenance";
const MAINTENANCE_CONFIRM_KEY = "emergency_maintenance_confirmed_by";

export async function isMaintenanceMode(env) {
  const val = await getSetting(env, MAINTENANCE_KEY, "0");
  return val === "1" || val === "true";
}

export async function setMaintenanceMode(env, enabled, adminId) {
  await setSetting(env, MAINTENANCE_KEY, enabled ? "1" : "0", adminId);
  if (enabled) {
    await setSetting(env, MAINTENANCE_CONFIRM_KEY, String(adminId), adminId);
  }
}

export async function getMaintenanceConfirmedBy(env) {
  const val = await getSetting(env, MAINTENANCE_CONFIRM_KEY, null);
  return val ? parseInt(val, 10) : null;
}
