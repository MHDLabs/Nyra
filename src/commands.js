// Nyra — commands: /start /help /admin plus reminder surface.
import { isAdmin, escapeHtml } from "./utils.js";
import { sendMessage, buildInlineKeyboard, editMessage } from "./telegram.js";
import { getUser, upsertUser } from "./db.js";
import { t } from "./i18n/index.js";
import { startOnboarding, getOnboardingState } from "./handlers/onboarding.js";
import { isMaintenanceMode } from "./db/maintenance.js";
import { getMasterKey } from "./crypto.js";
import { getConfiguredReactions, getAllowedReactions } from "./reactions.js";
import { showSettingsMenu, showPersonalitiesForUser } from "./menus.js";
import {
  handleRemindCommand,
  handleRemindersCommand,
  handleReminderDetailCommand,
  handleEditReminderCommand,
  handleCancelReminderCommand,
  handleDoneReminderCommand,
  handleTimezoneCommand
} from "./reminders/commands.js";
import { detectLang } from "./reminders/parse.js";

async function handleStartCommand(env, chatId, userId, from, isGroup) {
  if (isGroup) {
    const user = await getUser(env, userId);
    const locale = user?.locale || "en-US";
    await sendMessage(env, chatId, t(locale, "commands.start.group"));
    return;
  }

  // Check onboarding status
  const user = await getUser(env, userId);
  if (!user || user.onboarding_completed !== 1) {
    await startOnboarding(env, chatId, userId, from);
    return;
  }

  // Regular start for completed users
  const locale = user.locale || "en-US";
  const name = user.preferred_name || user.first_name || "";
  const msg = name ? t(locale, "commands.start.greeting", { name }) : t(locale, "commands.start.greeting_anon");
  await sendMessage(env, chatId, msg);
}

async function handleHelpCommand(env, chatId, userId, isGroup) {
  const user = await getUser(env, userId);
  const locale = user?.locale || "en-US";

  let text = t(locale, "commands.help");

  if (isAdmin(env, userId)) {
    text += "\n" + t(locale, "commands.help.admin_line");
  }

  await sendMessage(env, chatId, text);
}

async function handleAdminCommand(env, chatId, userId, isGroup) {
  const user = await getUser(env, userId);
  const locale = user?.locale || "en-US";

  if (!isAdmin(env, userId)) {
    await sendMessage(env, chatId, t(locale, "commands.admin.denied"));
    return;
  }

  if (isGroup) {
    await sendMessage(env, chatId, t(locale, "commands.admin.private_only"));
    return;
  }

  // Open admin panel in message with inline keyboard
  const miniappUrl = env.MINIAPP_URL || "https://nyra.example.com";
  const keyboard = buildInlineKeyboard([[
    { text: "Open Mini App", web_app: { url: miniappUrl } }
  ]]);

  await sendMessage(env, chatId, t(locale, "commands.admin.open"), { reply_markup: keyboard });
}

export async function handleUserCommand(env, ctx, command, args, message, from, chat) {
  const userId = from.id;
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  // Check maintenance mode for all commands except admin
  if (command !== "admin") {
    const maintenance = await isMaintenanceMode(env);
    if (maintenance) {
      const user = await getUser(env, userId);
      const locale = user?.locale || "en-US";
      await sendMessage(env, chatId, t(locale, "maintenance.notice"));
      return;
    }
  }

  // Normalize command (strip leading slash if present)
  const cmd = String(command || "").replace(/^\//, "").toLowerCase();

  if (cmd === "start") {
    await handleStartCommand(env, chatId, userId, from, isGroup);
    return;
  }
  if (cmd === "help") {
    await handleHelpCommand(env, chatId, userId, isGroup);
    return;
  }
  if (cmd === "admin") {
    await handleAdminCommand(env, chatId, userId, isGroup);
    return;
  }

  // Reminder surface — private chats only (reminders are personal)
  const reminderCommands = new Set([
    "remind", "reminders", "reminder",
    "editreminder", "cancelreminder", "donereminder",
    "timezone", "tz"
  ]);
  if (reminderCommands.has(cmd)) {
    if (isGroup) {
      const user = await getUser(env, userId);
      const locale = user?.locale || "en-US";
      await sendMessage(env, chatId, t(locale, "commands.reminders.private_only") ||
        "Reminder commands work in private chat with Nyra.");
      return;
    }
    const detected = detectLang(String(args || "") + " " + (message.text || ""));
    const userRow = await getUser(env, userId);
    const lang = detected || ((userRow?.locale || "en").startsWith("fa") ? "fa" : "en");
    if (cmd === "remind") return await handleRemindCommand(env, chatId, userId, args, lang);
    if (cmd === "reminders") return await handleRemindersCommand(env, chatId, userId, args, lang);
    if (cmd === "reminder") return await handleReminderDetailCommand(env, chatId, userId, args, lang);
    if (cmd === "editreminder") return await handleEditReminderCommand(env, chatId, userId, args, lang);
    if (cmd === "cancelreminder") return await handleCancelReminderCommand(env, chatId, userId, args, lang);
    if (cmd === "donereminder") return await handleDoneReminderCommand(env, chatId, userId, args, lang);
    if (cmd === "timezone" || cmd === "tz") return await handleTimezoneCommand(env, chatId, userId, args, lang);
  }

  // Everything else: point to Mini App
  const user = await getUser(env, userId);
  const locale = user?.locale || "en-US";
  const miniappUrl = env.MINIAPP_URL || "https://nyra.example.com";
  const keyboard = buildInlineKeyboard([[
    { text: "Open Mini App", web_app: { url: miniappUrl } }
  ]]);
  await sendMessage(env, chatId, t(locale, "commands.legacy.moved"), { reply_markup: keyboard });
}

export async function showAdminMenu(env, chatId, messageId) {
  const text = "<b>Admin Panel</b>\n\nSelect a section:";
  const rows = [
    [{ text: "👥 Users", callback_data: "adm:users" }, { text: "💬 Groups", callback_data: "adm:groups" }],
    [{ text: "🚫 Blocked", callback_data: "adm:blocked" }, { text: "📊 Stats", callback_data: "adm:stats" }],
    [{ text: "🤖 Models", callback_data: "adm:conns" }, { text: "💚 Status", callback_data: "adm:status" }],
    [{ text: "😀 Reactions", callback_data: "adm:react" }, { text: "⚠️ Maintenance", callback_data: "adm:maint" }],
    [{ text: "Close", callback_data: "adm:close" }]
  ];
  await editMessage(env, chatId, messageId, text, buildInlineKeyboard(rows), "HTML");
}

export async function showAdminUsers(env, chatId, messageId) {
  let rows = [];
  try {
    const result = await env.DB.prepare("SELECT telegram_id, first_name, username, last_seen_at, memory_mode FROM users WHERE telegram_id NOT IN (SELECT telegram_id FROM blocked_users) ORDER BY last_seen_at DESC LIMIT 20").all();
    rows = result.results || [];
  } catch (err) {}
  const lines = ["<b>Recent Users</b>", ""];
  const buttons = [];
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    lines.push(escapeHtml(u.first_name || "User") + (u.username ? " @" + escapeHtml(u.username) : "") + " (" + u.telegram_id + ") — " + (u.memory_mode || "normal"));
    buttons.push([{ text: "Block " + (u.first_name || u.telegram_id).toString().slice(0, 15), callback_data: "adm:user:block:" + u.telegram_id }]);
  }
  if (rows.length === 0) lines.push("No users.");
  buttons.push([{ text: "Back", callback_data: "adm:main" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(buttons), "HTML");
}

export async function showAdminGroups(env, chatId, messageId) {
  let rows = [];
  try {
    const result = await env.DB.prepare("SELECT chat_id, title, chat_type, enabled, mode FROM chats ORDER BY updated_at DESC LIMIT 20").all();
    rows = result.results || [];
  } catch (err) {}
  const lines = ["<b>Groups</b>", "", "<i>Enabled: responds when triggered by name or reply. Admin-only: only admins can trigger. Disabled: no response.</i>", ""];
  const buttons = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const mode = c.mode || (c.enabled === 1 ? "enabled" : "disabled");
    lines.push(escapeHtml(c.title || String(c.chat_id)) + " — " + mode);
    buttons.push([
      { text: (mode === "enabled" ? "✓ " : "") + "On", callback_data: "adm:gm:" + c.chat_id + ":enabled" },
      { text: (mode === "disabled" ? "✓ " : "") + "Off", callback_data: "adm:gm:" + c.chat_id + ":disabled" },
      { text: (mode === "admin_only" ? "✓ " : "") + "Adm", callback_data: "adm:gm:" + c.chat_id + ":admin_only" }
    ]);
  }
  if (rows.length === 0) lines.push("No chats recorded.");
  buttons.push([{ text: "Add Group", callback_data: "adm:group:add" }]);
  buttons.push([{ text: "Back", callback_data: "adm:main" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(buttons), "HTML");
}

export async function showAdminBlocked(env, chatId, messageId) {
  let rows = [];
  try { const result = await env.DB.prepare("SELECT telegram_id, reason FROM blocked_users ORDER BY blocked_at DESC LIMIT 20").all(); rows = result.results || []; } catch (err) {}
  const lines = ["<b>Blocked Users</b>", ""];
  const buttons = [];
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    lines.push(b.telegram_id + (b.reason ? " — " + escapeHtml(b.reason) : ""));
    buttons.push([{ text: "Unblock " + b.telegram_id, callback_data: "adm:user:unblock:" + b.telegram_id }]);
  }
  if (rows.length === 0) lines.push("No blocked users.");
  buttons.push([{ text: "Back", callback_data: "adm:main" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(buttons), "HTML");
}

export async function showAdminStats(env, chatId, messageId) {
  let userCount = 0, connCount = 0, enabledCount = 0, blockedCount = 0, chatCount = 0, globalCount = 0, threadCount = 0;
  try {
    const u = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first(); userCount = u ? u.c : 0;
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections").first(); connCount = c ? c.c : 0;
    const e = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections WHERE enabled = 1").first(); enabledCount = e ? e.c : 0;
    const g = await env.DB.prepare("SELECT COUNT(*) AS c FROM ai_connections WHERE is_global = 1").first(); globalCount = g ? g.c : 0;
    const b = await env.DB.prepare("SELECT COUNT(*) AS c FROM blocked_users").first(); blockedCount = b ? b.c : 0;
    const ch = await env.DB.prepare("SELECT COUNT(*) AS c FROM chats").first(); chatCount = ch ? ch.c : 0;
    const tm = await env.DB.prepare("SELECT COUNT(*) AS c FROM thread_messages").first(); threadCount = tm ? tm.c : 0;
  } catch (err) {}
  const text = "<b>Statistics</b>\n\nUsers: " + userCount + "\nChats: " + chatCount + "\nThread messages: " + threadCount + "\nTotal Connections: " + connCount + " (" + enabledCount + " enabled)\nGlobal Connections: " + globalCount + "\nBlocked users: " + blockedCount;
  await editMessage(env, chatId, messageId, text, buildInlineKeyboard([[{ text: "Back", callback_data: "adm:main" }]]), "HTML");
}

export async function showAdminStatus(env, chatId, messageId) {
  let dbOk = false, kvOk = false;
  try { await env.DB.prepare("SELECT 1").first(); dbOk = true; } catch (err) {}
  try { await env.KV.get("healthcheck"); kvOk = true; } catch (err) {}
  const encOk = !!getMasterKey(env);
  const text = "<b>System Status</b>\n\nD1: " + (dbOk ? "OK" : "FAIL") + "\nKV: " + (kvOk ? "OK" : "FAIL") + "\nEncryption key: " + (encOk ? "OK" : "MISSING") + "\nTimestamp: " + new Date().toISOString();
  await editMessage(env, chatId, messageId, text, buildInlineKeyboard([[{ text: "Back", callback_data: "adm:main" }]]), "HTML");
}

/**
 * Reactions section of the admin panel: shows the emoji the bot is currently
 * allowed to react with, and which ones Telegram has refused in recent chats.
 * Responds to an emoji message from the admin by filtering the allowlist.
 */
export async function showAdminReactions(env, chatId, messageId) {
  const configured = await getConfiguredReactions(env);
  const allowed = await getAllowedReactions(env, null);
  const lines = [
    "<b>Reactions</b>", "",
    "Source: <b>" + (configured ? "custom" : "defaults") + "</b>",
    "Allowed: " + (allowed.join(" ") || "(none)"),
    "",
    "<i>Nyra only reacts in groups when she is named, and stays silent when no reaction clearly fits.</i>",
    "",
    "Send the emoji Nyra may use — e.g. <code>👍 ❤ 🤔</code> — one message, space or comma separated.",
    "Send <code>default</code> to restore the built-in set."
  ];
  const buttons = [
    [{ text: "Restore defaults", callback_data: "adm:react:default" }],
    [{ text: "Back", callback_data: "adm:main" }]
  ];
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(buttons), "HTML");
}

export async function showAdminMaintenance(env, chatId, messageId) {
  const { isMaintenanceMode } = await import("./db/maintenance.js");
  const enabled = await isMaintenanceMode(env);

  const status = enabled ? "🔴 ENABLED" : "🟢 DISABLED";
  const text = `<b>Emergency Maintenance</b>

Status: ${status}

When enabled, Nyra stops responding to ordinary AI messages across all chats. Only administrators can toggle this switch.

Use this during critical maintenance, outages, or emergencies.`;

  const toggleText = enabled ? "✅ Disable Maintenance" : "⚠️ Enable Maintenance";
  const toggleData = enabled ? "adm:maint:off" : "adm:maint:on";

  const rows = [
    [{ text: toggleText, callback_data: toggleData }],
    [{ text: "« Back", callback_data: "adm:menu" }]
  ];
  await editMessage(env, chatId, messageId, text, buildInlineKeyboard(rows), "HTML");
}
