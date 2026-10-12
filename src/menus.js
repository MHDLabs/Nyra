// Nyra — menus: settings screens, personality/connection lists, usage and privacy views.
import { UNHEALTHY_FAILURE_THRESHOLD, CONNECTIONS_PER_PAGE } from "./config.js";
import { truncate, escapeHtml, safeCallbackId, isAdmin } from "./utils.js";
import { sendMessage, editMessage, buildInlineKeyboard } from "./telegram.js";
import { getUser, getUserConnections, getEnabledUserConnections, getUserConnectionById, parseUsageStats } from "./db.js";
import { formatMemoryForUser, listAvailablePersonalities } from "./memory.js";

export async function showNoConnectionMessage(env, chatId, isGroup) {
  if (isGroup) return;
  const text = "<b>Hi, I'm Nyra.</b>\n\nNo AI model is available yet. Please ask an administrator to configure a global model.";
  await sendMessage(env, chatId, text, { parse_mode: "HTML" });
}

export async function showSettingsMenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  let activeConn = null;
  if (user && user.active_connection_id) {
    activeConn = await getUserConnectionById(env, userId, user.active_connection_id);
    if (!activeConn || activeConn.enabled !== 1) activeConn = null;
  }
  const fallbackOn = !user || user.fallback_enabled !== 0;
  const hasCI = user && user.custom_instructions && user.custom_instructions.length > 0;
  const admin = isAdmin(env, userId);
  const lines = ["<b>Settings</b>", ""];
  lines.push("Active model: " + (activeConn ? escapeHtml(activeConn.label) + " (" + escapeHtml(activeConn.model) + ")" : "<i>none</i>"));
  lines.push("Memory: " + ((user && user.memory_mode) || "normal"));
  lines.push("Fallback: " + (fallbackOn ? "on" : "off"));
  const rows = [];
  rows.push([{ text: "Choose Model", callback_data: "set:model" }]);
  rows.push([{ text: "Personalities", callback_data: "set:pers" }]);
  rows.push([{ text: "Memory", callback_data: "set:mem" }, { text: "Instructions" + (hasCI ? " ✓" : ""), callback_data: "set:ci" }]);
  rows.push([{ text: "Fallback: " + (fallbackOn ? "On" : "Off"), callback_data: "set:fallback" }]);
  rows.push([{ text: "Usage", callback_data: "set:usage" }, { text: "Privacy", callback_data: "set:privacy" }]);
  if (admin) rows.push([{ text: "🛠 Manage Models", callback_data: "myconn:list:set" }]);
  rows.push([{ text: "Close", callback_data: "set:close" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showModelList(env, chatId, messageId, userId, page) {
  const user = await getUser(env, userId);
  const conns = await getEnabledUserConnections(env, userId);
  if (conns.length === 0) {
    await editMessage(env, chatId, messageId, "No models available yet. Please ask an administrator.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML");
    return;
  }
  const activeId = user ? user.active_connection_id : null;
  const pageSize = CONNECTIONS_PER_PAGE;
  const pageCount = Math.max(1, Math.ceil(conns.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, conns.length);
  const lines = ["<b>Choose Model</b>", "", "Page " + (safePage + 1) + "/" + pageCount];
  const rows = [];
  for (let i = start; i < end; i++) {
    const c = conns[i];
    const mark = c.connection_id === activeId ? "● " : "○ ";
    const tag = c.is_global === 1 ? " [Global]" : "";
    lines.push("");
    lines.push(mark + "<b>" + escapeHtml(c.label) + "</b>" + tag);
    lines.push("   <code>" + escapeHtml(c.model) + "</code>");
    const shortId = safeCallbackId(c.connection_id);
    rows.push([{ text: (c.connection_id === activeId ? "✓ " : "") + truncate(c.label, 40), callback_data: "model:set:" + shortId }]);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: "◀ Prev", callback_data: "model:pg:" + (safePage - 1) });
  if (safePage < pageCount - 1) nav.push({ text: "Next ▶", callback_data: "model:pg:" + (safePage + 1) });
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showPersonalitiesForUser(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const { builtins, customs } = await listAvailablePersonalities(env, userId);
  const current = (user && user.personality_id) || "default";
  const lines = ["<b>Choose Personality</b>", ""];
  const rows = [];
  for (let i = 0; i < builtins.length; i++) {
    const p = builtins[i];
    const mark = p.id === current ? " ✓" : "";
    rows.push([{ text: p.name + mark, callback_data: "pers:set:" + p.id }]);
  }
  if (customs.length > 0) {
    rows.push([{ text: "My Personalities (" + customs.length + ")", callback_data: "myp:list" }]);
  }
  lines.push("");
  lines.push("Create a custom personality with /newpersonality");
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showMyPersonalities(env, chatId, messageId, userId) {
  const { customs } = await listAvailablePersonalities(env, userId);
  const user = await getUser(env, userId);
  const current = (user && user.personality_id) || "default";
  const lines = ["<b>My Personalities</b>", ""];
  const rows = [];
  if (customs.length === 0) {
    lines.push("You have no custom personalities yet.");
  } else {
    for (let i = 0; i < customs.length; i++) {
      const p = customs[i];
      const mark = p.id === current ? " ✓" : "";
      rows.push([{ text: p.name + mark, callback_data: "myp:view:" + p.rawId }]);
    }
  }
  rows.push([{ text: "Create New", callback_data: "myp:new" }]);
  rows.push([{ text: "Back", callback_data: "set:pers" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showPersonalityDetail(env, chatId, messageId, userId, rawId) {
  let p = null;
  try {
    p = await env.DB.prepare("SELECT * FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1").bind(rawId, userId).first();
  } catch (err) {}
  if (!p) { await editMessage(env, chatId, messageId, "Personality not found.", buildInlineKeyboard([[{ text: "Back", callback_data: "myp:list" }]]), "HTML"); return; }
  const user = await getUser(env, userId);
  const isCurrent = user && user.personality_id === "custom:" + rawId;
  const lines = ["<b>" + escapeHtml(p.name) + "</b>", ""];
  if (p.description) lines.push("<i>" + escapeHtml(p.description) + "</i>", "");
  lines.push("Prompt length: " + (p.prompt ? p.prompt.length : 0) + " chars");
  const rows = [];
  rows.push([{ text: isCurrent ? "✓ Active" : "Select", callback_data: "mypd:select:" + rawId }]);
  rows.push([{ text: "Rename", callback_data: "mypd:rename:" + rawId }, { text: "Edit Description", callback_data: "mypd:desc:" + rawId }]);
  rows.push([{ text: "Edit Prompt", callback_data: "mypd:prompt:" + rawId }]);
  rows.push([{ text: "Delete", callback_data: "mypd:del:" + rawId }]);
  rows.push([{ text: "Back", callback_data: "myp:list" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showMemorySubmenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const mode = (user && user.memory_mode) || "normal";
  const lines = ["<b>Memory</b>", ""];
  lines.push("Current mode: <b>" + mode + "</b>", "");
  if (mode === "none") {
    lines.push("<i>Memory is disabled.</i>");
  } else {
    const formatted = formatMemoryForUser(user ? user.memory_data : null, mode);
    lines.push("<blockquote expandable>" + formatted + "</blockquote>");
  }
  const rows = [];
  rows.push([{ text: "Normal" + (mode === "normal" ? " ✓" : ""), callback_data: "mem:mode:normal" }]);
  rows.push([{ text: "Minimal" + (mode === "minimal" ? " ✓" : ""), callback_data: "mem:mode:minimal" }]);
  rows.push([{ text: "None" + (mode === "none" ? " ✓" : ""), callback_data: "mem:mode:none" }]);
  rows.push([{ text: "Clear Memory", callback_data: "mem:clear" }]);
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showCustomInstructionsMenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const ci = (user && user.custom_instructions) || "";
  const lines = ["<b>Custom Instructions</b>", ""];
  if (ci) {
    lines.push("<blockquote expandable>" + escapeHtml(ci) + "</blockquote>");
  } else {
    lines.push("<i>No custom instructions set.</i>");
    lines.push("");
    lines.push("Custom instructions are added to every conversation as a persistent preference.");
  }
  const rows = [];
  rows.push([{ text: ci ? "Replace Instructions" : "Set Instructions", callback_data: "ci:set" }]);
  if (ci) rows.push([{ text: "Clear", callback_data: "ci:clear" }]);
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showUsage(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const stats = parseUsageStats(user ? user.usage_stats : null);
  let activeConn = null;
  if (user && user.active_connection_id) activeConn = await getUserConnectionById(env, userId, user.active_connection_id);
  const lines = ["<b>Usage</b>", ""];
  lines.push("Active model: " + (activeConn ? escapeHtml(activeConn.label) + " / " + escapeHtml(activeConn.model) : "none"));
  lines.push("Total requests: " + stats.total);
  lines.push("Successful: " + stats.success);
  lines.push("Failed: " + stats.fail);
  if (stats.last_at > 0) lines.push("Last request: " + new Date(stats.last_at * 1000).toISOString());
  if (stats.last_error) lines.push("Last error: " + escapeHtml(stats.last_error));
  if (stats.token_source === "provider_reported") {
    lines.push("Input tokens: " + stats.in_tokens);
    lines.push("Output tokens: " + stats.out_tokens);
  } else {
    lines.push("<i>Token usage not reported by provider.</i>");
  }
  if (stats.cost_usd > 0) lines.push("Cumulative cost: $" + stats.cost_usd.toFixed(4));
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML");
}

export async function showPrivacy(env, chatId, messageId) {
  const text = "<b>Privacy</b>\n\n" +
    "• Nyra stores a lightweight profile, a small structured memory, and recent conversation context for your chats.\n" +
    "• Memory and conversations are stored in the project database; credentials are encrypted at rest, memory text is not.\n" +
    "• AI models are configured by administrators and shared across users.\n" +
    "• The app never shows your memory or conversations to other users — including admins.\n\n" +
    "Change memory behavior in Memory.";
  await editMessage(env, chatId, messageId, text, buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML");
}

export function sourceSuffix(source) {
  return source === "adm" ? ":adm" : "";
}

export function sourceBackButton(source) {
  if (source === "adm") return { text: "◀ Admin", callback_data: "adm:main" };
  return { text: "Back", callback_data: "set:menu" };
}

export async function showMyConnections(env, chatId, messageId, userId, source) {
  if (!isAdmin(env, userId)) {
    await editMessage(env, chatId, messageId, "Only administrators can manage models.", buildInlineKeyboard([[sourceBackButton(source)]]), "HTML");
    return;
  }
  const sfx = sourceSuffix(source);
  const conns = await getUserConnections(env, userId);
  const lines = ["<b>Manage Models</b>", "", "<i>These models are shared with all users.</i>", ""];
  const rows = [];
  if (conns.length === 0) {
    lines.push("No models yet.");
    rows.push([{ text: "➕ Add Model", callback_data: "myconn:add" + sfx }]);
  } else {
    for (let i = 0; i < conns.length; i++) {
      const c = conns[i];
      const enabledMark = c.enabled === 1 ? "✓" : "✗";
      const globalMark = c.is_global === 1 ? " [Global]" : " [Personal]";
      const defaultMark = c.is_default === 1 ? " ★" : "";
      const healthMark = (c.consecutive_failures || 0) >= UNHEALTHY_FAILURE_THRESHOLD ? " ⚠" : "";
      lines.push(enabledMark + " <b>" + escapeHtml(c.label) + "</b>" + globalMark + defaultMark + healthMark);
      lines.push("   " + escapeHtml(c.provider) + " / <code>" + escapeHtml(c.model) + "</code>");
      const shortId = safeCallbackId(c.connection_id);
      rows.push([
        { text: "🧪 Test", callback_data: "myconn:test:" + shortId + sfx },
        { text: "✏️ Edit", callback_data: "myconn:edit:" + shortId + sfx },
        { text: c.enabled === 1 ? "⏸ Disable" : "▶️ Enable", callback_data: "myconn:tog:" + shortId + sfx }
      ]);
      const row2 = [];
      if (c.is_global === 1 && c.is_default !== 1) row2.push({ text: "⭐ Set Default", callback_data: "myconn:def:" + shortId + sfx });
      row2.push({ text: "🗑 Delete", callback_data: "myconn:del:" + shortId + sfx });
      rows.push(row2);
    }
    rows.push([{ text: "➕ Add Model", callback_data: "myconn:add" + sfx }]);
  }
  rows.push([sourceBackButton(source)]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function resolveUserConnectionShortId(env, userId, shortId) {
  const conns = await getUserConnections(env, userId);
  for (let i = 0; i < conns.length; i++) if (safeCallbackId(conns[i].connection_id) === shortId) return conns[i].connection_id;
  return null;
}
