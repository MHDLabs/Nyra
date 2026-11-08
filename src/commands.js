// Nyra — commands: full in-chat control (settings, memory, admin) + reminders.
// Mini App remains available, but nothing requires it.
import { RATE_LIMIT_ADMIN_PER_MIN, MAX_PERSONALITIES, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, ONBOARDING_MAX_NAME_LENGTH } from "./config.js";
import { now, escapeHtml, generateShortId, isAdmin, checkRateLimit } from "./utils.js";
import { getMasterKey } from "./crypto.js";
import { sendMessage, editMessage, buildInlineKeyboard } from "./telegram.js";
import { getUser, upsertUser, resolveUserActiveConnection } from "./db.js";
import { parseMemoryData, serializeMemoryData, formatMemoryForUser } from "./memory.js";
import { t } from "./i18n/index.js";
import { startOnboarding, getOnboardingState } from "./handlers/onboarding.js";
import { isMaintenanceMode } from "./db/maintenance.js";
import { getConfiguredReactions, getAllowedReactions } from "./reactions.js";
import { showNoConnectionMessage, showSettingsMenu, showPersonalitiesForUser, showUsage } from "./menus.js";
import { createBroadcast, startBroadcast, listBroadcasts } from "./broadcast.js";
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

function publicOrigin(env) {
  if (env.PUBLIC_ORIGIN) return String(env.PUBLIC_ORIGIN).replace(/\/+$/, "");
  if (env.MINIAPP_URL) return String(env.MINIAPP_URL).replace(/\/+$/, "");
  return null;
}

function miniAppKeyboard(env, locale) {
  const origin = publicOrigin(env);
  if (!origin) return undefined;
  return buildInlineKeyboard([[{ text: t(locale, "commands.miniapp.open") || "Open Mini App", web_app: { url: origin + "/" } }]]);
}

async function handleStartCommand(env, chatId, userId, from, isGroup) {
  if (isGroup) {
    const user = await getUser(env, userId);
    const locale = user?.locale || "en-US";
    await sendMessage(env, chatId, t(locale, "commands.start.group"));
    return;
  }

  await upsertUser(env, from);
  const user = await getUser(env, userId);
  if (!user || user.onboarding_completed !== 1) {
    await startOnboarding(env, chatId, userId, from);
    return;
  }

  const locale = user.locale || "en-US";
  const name = user.preferred_name || user.first_name || "";
  let msg = name ? t(locale, "commands.start.greeting", { name }) : t(locale, "commands.start.greeting_anon");
  try {
    const resolved = await resolveUserActiveConnection(env, user);
    if (resolved && resolved.connection) {
      msg += "\n\n" + (locale.startsWith("fa")
        ? ("مدل فعال: <b>" + escapeHtml(resolved.connection.label) + "</b>")
        : ("Active model: <b>" + escapeHtml(resolved.connection.label) + "</b>"));
    }
  } catch (err) {}

  const keyboard = buildInlineKeyboard([
    [{ text: locale.startsWith("fa") ? "⚙️ تنظیمات" : "⚙️ Settings", callback_data: "set:menu" }],
    [{ text: locale.startsWith("fa") ? "🎭 شخصیت" : "🎭 Personality", callback_data: "set:pers" }],
    [{ text: locale.startsWith("fa") ? "🧠 حافظه" : "🧠 Memory", callback_data: "set:mem" }]
  ]);
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: keyboard });
}

async function handleHelpCommand(env, chatId, userId, isGroup) {
  const user = await getUser(env, userId);
  const locale = user?.locale || "en-US";
  const fa = locale.startsWith("fa");
  const lines = fa ? [
    "<b>دستورات</b>",
    "",
    "/start — سلام و منوی سریع",
    "/help — همین راهنما",
    "/settings — تنظیمات",
    "/personality — انتخاب شخصیت",
    "/memory — مشاهده حافظه",
    "/forget [موضوع] — پاک کردن حافظه یا یک موضوع",
    "/remember <متن> — ذخیره در حافظه",
    "/setname <نام> — نام نمایشی",
    "/usage — آمار مصرف",
    "/newpersonality — شخصیت سفارشی",
    "",
    "<b>یادآورها</b>",
    "/remind — یادآور جدید",
    "/reminders — لیست یادآورها",
    "/timezone — منطقه زمانی"
  ] : [
    "<b>Commands</b>",
    "",
    "/start — Greeting & quick menu",
    "/help — This message",
    "/settings — Preferences",
    "/personality — Choose personality",
    "/memory — View memory",
    "/forget [topic] — Clear memory or a topic",
    "/remember &lt;fact&gt; — Store a fact",
    "/setname &lt;name&gt; — Preferred name",
    "/usage — Usage stats",
    "/newpersonality — Create a personality",
    "",
    "<b>Reminders</b>",
    "/remind — New reminder",
    "/reminders — List reminders",
    "/timezone — Time zone"
  ];
  if (isAdmin(env, userId)) {
    lines.push("");
    lines.push(fa ? "<b>مدیریت</b>" : "<b>Admin</b>");
    lines.push("/admin — " + (fa ? "پنل مدیریت" : "Admin panel"));
    lines.push("/stats — " + (fa ? "آمار سیستم" : "System stats"));
    lines.push("/broadcast — " + (fa ? "پیام همگانی" : "Broadcast"));
  }
  if (!isGroup) {
    lines.push("");
    lines.push(fa
      ? "مینی‌اپ اختیاری است؛ همه کارها از همین چت هم قابل انجام است."
      : "The Mini App is optional — everything works from this chat.");
  }
  await sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
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
  const rateOk = await checkRateLimit(env, "admin:" + userId, RATE_LIMIT_ADMIN_PER_MIN, 60);
  if (!rateOk) {
    await sendMessage(env, chatId, locale.startsWith("fa") ? "محدودیت نرخ. کمی بعد دوباره تلاش کنید." : "Rate limit reached. Try again shortly.");
    return;
  }
  await showAdminMenu(env, chatId, null);
}

async function handleRememberCommand(env, chatId, userId, args) {
  const fact = String(args || "").trim();
  if (!fact) {
    await sendMessage(env, chatId, "Usage: /remember &lt;fact&gt;", { parse_mode: "HTML" });
    return;
  }
  const user = await getUser(env, userId);
  if (!user || user.memory_mode === "none") {
    await sendMessage(env, chatId, "Memory is disabled. Enable it in /settings → Memory.");
    return;
  }
  try {
    const { executeAgentTool } = await import("./tools.js");
    const result = JSON.parse(await executeAgentTool(env, userId, "remember_fact", { fact: fact.slice(0, 300) }));
    if (result.saved) await sendMessage(env, chatId, "✅ Remembered: " + result.fact);
    else await sendMessage(env, chatId, result.reason === "duplicate" ? "Already in memory." : "Could not save that fact.");
  } catch (err) {
    await sendMessage(env, chatId, "Could not save that fact.");
  }
}

async function handleForgetCommand(env, chatId, userId, args) {
  const query = String(args || "").trim();
  const user = await getUser(env, userId);
  if (!user || user.memory_mode === "none") {
    await sendMessage(env, chatId, "Memory is disabled.");
    return;
  }
  if (!query) {
    // clear all facts path via memory mode tools
    try {
      const data = parseMemoryData(user.memory_data);
      data.facts = [];
      await env.DB.prepare("UPDATE users SET memory_data = ?, updated_at = ? WHERE telegram_id = ?")
        .bind(serializeMemoryData(data), now(), userId).run();
      await sendMessage(env, chatId, "✅ Memory cleared.");
    } catch (err) {
      await sendMessage(env, chatId, "Could not clear memory.");
    }
    return;
  }
  try {
    const { executeAgentTool } = await import("./tools.js");
    const result = JSON.parse(await executeAgentTool(env, userId, "forget_fact", { query: query.slice(0, 120) }));
    if (result.deleted) await sendMessage(env, chatId, "✅ Forgotten.");
    else await sendMessage(env, chatId, result.matches ? "Several matches — be more specific." : "No matching memory.");
  } catch (err) {
    await sendMessage(env, chatId, "Could not update memory.");
  }
}

async function handleMemoryCommand(env, chatId, userId) {
  const user = await getUser(env, userId);
  if (!user || user.memory_mode === "none") {
    await sendMessage(env, chatId, "Memory is disabled. Enable it in /settings → Memory.");
    return;
  }
  const locale = user.locale || "en-US";
  const text = formatMemoryForUser(user.memory_data, user.memory_mode, locale) || "Memory is empty.";
  await sendMessage(env, chatId, text, { parse_mode: "HTML" });
}

async function handleSetNameCommand(env, chatId, userId, args) {
  const name = String(args || "").trim().slice(0, ONBOARDING_MAX_NAME_LENGTH || 50);
  if (!name) {
    await sendMessage(env, chatId, "Usage: /setname &lt;name&gt;", { parse_mode: "HTML" });
    return;
  }
  await env.DB.prepare("UPDATE users SET preferred_name = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(name, now(), userId).run();
  await sendMessage(env, chatId, "✅ Name set to " + name);
}

async function handleUsageCommand(env, chatId, userId) {
  await showUsage(env, chatId, null, userId);
}

async function handleNewPersonalityCommand(env, chatId, userId, args) {
  const raw = String(args || "").trim();
  if (!raw) {
    await sendMessage(env, chatId, "Usage: /newpersonality Name | prompt text\nExample: /newpersonality Coach | Be supportive and concise.");
    return;
  }
  const parts = raw.split("|").map(function (s) { return s.trim(); });
  const name = (parts[0] || "").slice(0, 40);
  const prompt = (parts.slice(1).join("|") || "").slice(0, MAX_PERSONALITY_PROMPT || 2000);
  if (!name || !prompt) {
    await sendMessage(env, chatId, "Provide both a name and a prompt separated by |");
    return;
  }
  let count = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM custom_personalities WHERE telegram_id = ?").bind(userId).first();
    count = row ? row.c : 0;
  } catch (err) {}
  if (count >= (MAX_PERSONALITIES || 10)) {
    await sendMessage(env, chatId, "Personality limit reached.");
    return;
  }
  const id = generateShortId();
  const ts = now();
  try {
    await env.DB.prepare(
      "INSERT INTO custom_personalities (personality_id, telegram_id, name, prompt, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).bind(id, userId, name, prompt, ts, ts).run();
    await sendMessage(env, chatId, "✅ Personality '" + escapeHtml(name) + "' created. Manage it in /personality.", { parse_mode: "HTML" });
  } catch (err) {
    await sendMessage(env, chatId, "Could not create personality.");
  }
}

async function handleStatsCommand(env, chatId, userId) {
  if (!isAdmin(env, userId)) {
    await sendMessage(env, chatId, "Unknown command.");
    return;
  }
  await showAdminStats(env, chatId, null);
}

async function handleBroadcastCommand(env, ctx, from, chat, args) {
  const userId = from.id;
  if (!isAdmin(env, userId)) {
    await sendMessage(env, chat.id, "Unknown command.");
    return;
  }
  if (chat.type !== "private") {
    await sendMessage(env, chat.id, "Broadcast is only available in private chat.");
    return;
  }
  const text = String(args || "").trim();
  if (!text) {
    const listed = await listBroadcasts(env, 0, 5);
    const list = (listed && listed.broadcasts) || (Array.isArray(listed) ? listed : []);
    const lines = ["<b>Broadcast</b>", "", "Usage: /broadcast &lt;message&gt;", "", "Recent:"];
    if (!list || !list.length) lines.push("None.");
    else for (const b of list) lines.push((b.broadcast_id || "?").toString().slice(0, 8) + " — " + (b.status || "?") + " — " + escapeHtml(String(b.message || "").slice(0, 40)));
    await sendMessage(env, chat.id, lines.join("\n"), { parse_mode: "HTML" });
    return;
  }
  try {
    const created = await createBroadcast(env, userId, text, "all_users");
    if (created && created.broadcastId) {
      const started = await startBroadcast(env, ctx, created.broadcastId, userId);
      await sendMessage(env, chat.id, "✅ Broadcast started (" + (started && started.totalCount != null ? started.totalCount : "?") + " recipients).");
    } else {
      await sendMessage(env, chat.id, "Could not create broadcast.");
    }
  } catch (err) {
    await sendMessage(env, chat.id, "Broadcast failed: " + (err.message || "error"));
  }
}

export async function handleUserCommand(env, ctx, command, args, message, from, chat) {
  const userId = from.id;
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const cmd = String(command || "").replace(/^\//, "").toLowerCase();

  // Maintenance: still allow admin commands
  if (cmd !== "admin" && cmd !== "stats" && cmd !== "broadcast") {
    const maintenance = await isMaintenanceMode(env);
    if (maintenance && !isAdmin(env, userId)) {
      const user = await getUser(env, userId);
      const locale = user?.locale || "en-US";
      await sendMessage(env, chatId, t(locale, "maintenance.notice"));
      return;
    }
  }

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
  if (cmd === "settings") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /settings in private chat."); return; }
    await upsertUser(env, from);
    await showSettingsMenu(env, chatId, null, userId);
    return;
  }
  if (cmd === "personality") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /personality in private chat."); return; }
    await upsertUser(env, from);
    await showPersonalitiesForUser(env, chatId, null, userId);
    return;
  }
  if (cmd === "memory") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /memory in private chat."); return; }
    await upsertUser(env, from);
    await handleMemoryCommand(env, chatId, userId);
    return;
  }
  if (cmd === "forget") {
    await upsertUser(env, from);
    await handleForgetCommand(env, chatId, userId, args);
    return;
  }
  if (cmd === "remember") {
    await upsertUser(env, from);
    await handleRememberCommand(env, chatId, userId, args);
    return;
  }
  if (cmd === "setname") {
    await upsertUser(env, from);
    await handleSetNameCommand(env, chatId, userId, args);
    return;
  }
  if (cmd === "usage") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /usage in private chat."); return; }
    await upsertUser(env, from);
    await handleUsageCommand(env, chatId, userId);
    return;
  }
  if (cmd === "newpersonality") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /newpersonality in private chat."); return; }
    await upsertUser(env, from);
    await handleNewPersonalityCommand(env, chatId, userId, args);
    return;
  }
  if (cmd === "stats") {
    await handleStatsCommand(env, chatId, userId);
    return;
  }
  if (cmd === "broadcast") {
    await handleBroadcastCommand(env, ctx, from, chat, args);
    return;
  }

  // Reminders
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

  // Unknown command
  const user = await getUser(env, userId);
  const locale = user?.locale || "en-US";
  await sendMessage(env, chatId, locale.startsWith("fa")
    ? "دستور ناشناخته. /help را ببینید."
    : "Unknown command. Try /help.");
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
