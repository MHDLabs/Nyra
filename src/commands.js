// Nyra — commands: user command handlers and the admin panel.
import { RATE_LIMIT_ADMIN_PER_MIN, MAX_PERSONALITIES, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC } from "./config.js";
import { now, escapeHtml, generateShortId, sanitizeMemoryString, sanitizeMemoryFact, dedupeArray, filterSubstrings, isAdmin, checkRateLimit, containsPhrase } from "./utils.js";
import { getMasterKey } from "./crypto.js";
import { sendMessage, editMessage, buildInlineKeyboard } from "./telegram.js";
import { getUser, upsertUser, resolveUserActiveConnection } from "./db.js";
import { parseMemoryData, serializeMemoryData, formatMemoryForUser } from "./memory.js";
import { showNoConnectionMessage, showSettingsMenu, showPersonalitiesForUser, showUsage } from "./menus.js";
import { executeWebTool } from "./tools.js";

async function handleSearchCommand(env, chatId, userId, args) {
  const query = (args || "").trim();
  if (!query) {
    await sendMessage(env, chatId, "Usage: /search &lt;query&gt;", { parse_mode: "HTML" });
    return;
  }
  await sendMessage(env, chatId, "🔍 Searching for: <i>" + escapeHtml(query) + "</i>...", { parse_mode: "HTML" });
  try {
    const result = await executeWebTool(env, "search", { query }, userId);
    let out = "<b>Search Results for:</b> <i>" + escapeHtml(query) + "</i>\n\n";
    if (result.results && result.results.length > 0) {
      for (const item of result.results.slice(0, 5)) {
        out += "• <b>" + escapeHtml(item.title) + "</b>\n" + escapeHtml(item.snippet || "") + "\n<a href=\"" + escapeHtml(item.url) + "\">" + escapeHtml(item.url) + "</a>\n\n";
      }
    } else if (result.raw) {
      out += escapeHtml(result.raw);
    } else {
      out += "No results found.";
    }
    await sendMessage(env, chatId, out, { parse_mode: "HTML" });
  } catch (err) {
    await sendMessage(env, chatId, "❌ Search failed: " + escapeHtml(err.message));
  }
}

async function handleFetchCommand(env, chatId, userId, args) {
  const url = (args || "").trim();
  if (!url) {
    await sendMessage(env, chatId, "Usage: /fetch &lt;url&gt;", { parse_mode: "HTML" });
    return;
  }
  await sendMessage(env, chatId, "🌐 Fetching: <i>" + escapeHtml(url) + "</i>...", { parse_mode: "HTML" });
  try {
    const result = await executeWebTool(env, "fetch", { url }, userId);
    const content = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const snippet = content.length > 3500 ? content.slice(0, 3500) + "\n\n<i>(truncated)</i>" : content;
    await sendMessage(env, chatId, "<b>Fetched Content:</b>\n\n" + escapeHtml(snippet), { parse_mode: "HTML" });
  } catch (err) {
    await sendMessage(env, chatId, "❌ Fetch failed: " + escapeHtml(err.message));
  }
}

async function handleStartCommand(env, chatId, userId) {
  const user = await getUser(env, userId);
  const resolved = await resolveUserActiveConnection(env, user);
  if (!resolved.connection) { await showNoConnectionMessage(env, chatId, false); return; }
  const name = (user && user.preferred_name) ? user.preferred_name : null;
  const greeting = name ? "Hi " + escapeHtml(name) + ", I'm Nyra." : "Hi, I'm Nyra.";
  const text = "<b>" + greeting + "</b>\n\nYour active model: <b>" + escapeHtml(resolved.connection.label) + "</b>\n\nUse /settings to manage preferences.\nUse /help for the command list.";
  await sendMessage(env, chatId, text, { parse_mode: "HTML" });
}

async function handleHelpCommand(env, chatId, userId, isGroup) {
  const lines = [
    "<b>Commands</b>", "",
    "/start — Greeting",
    "/help — This message",
    "/settings — Preferences (private)",
    "/personality — Choose a personality (private)",
    "/memory — View your memory (private)",
    "/forget [topic] — Clear memory or forget a topic",
    "/remember &lt;fact&gt; — Explicitly remember",
    "/setname &lt;name&gt; — Set your preferred name",
    "/usage — Your usage statistics (private)",
    "/newpersonality — Create a custom personality (private)",
    "/search &lt;query&gt; — Search the web (private)",
    "/fetch &lt;url&gt; — Fetch a webpage (private)"
  ];
  if (isAdmin(env, userId)) {
    lines.push("");
    lines.push("<b>Admin</b>");
    lines.push("/admin — Admin panel (private chat only)");
    lines.push("/stats — Statistics (private chat only)");
  }
  if (isGroup) {
    lines.push("");
    lines.push("<b>Group usage</b>");
    lines.push("In groups, Nyra only responds when you say her name (Nyra / نیرا / نيرا) or reply to one of her messages.");
  }
  await sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

async function handleRememberCommand(env, chatId, userId, args) {
  const fact = sanitizeMemoryFact(args);
  if (!fact) { await sendMessage(env, chatId, "Usage: /remember <fact>"); return; }
  if (fact.length > 300) { await sendMessage(env, chatId, "Fact too long (max 300 characters)."); return; }
  const user = await getUser(env, userId);
  if (!user) { await sendMessage(env, chatId, "Please send /start first."); return; }
  if (user.memory_mode === "none") { await sendMessage(env, chatId, "Memory is disabled. Enable it in /settings → Memory."); return; }
  const data = parseMemoryData(user.memory_data);
  if (!Array.isArray(data.explicit_facts)) data.explicit_facts = [];
  const lowerFact = fact.toLowerCase();
  let isDuplicate = false;
  for (let i = 0; i < data.explicit_facts.length; i++) {
    if (String(data.explicit_facts[i]).toLowerCase() === lowerFact) { isDuplicate = true; break; }
  }
  if (isDuplicate) { await sendMessage(env, chatId, "I already remember that."); return; }
  data.explicit_facts.push(fact);
  data.explicit_facts = filterSubstrings(dedupeArray(data.explicit_facts.map(sanitizeMemoryFact).filter(Boolean)));
  if (data.explicit_facts.length > 20) data.explicit_facts = data.explicit_facts.slice(-20);
  data.last_updated = now();
  try {
    await env.DB.prepare("UPDATE users SET memory_data = ?, updated_at = ? WHERE telegram_id = ?").bind(serializeMemoryData(data), now(), userId).run();
    await sendMessage(env, chatId, "Got it. I'll remember: " + escapeHtml(fact));
  } catch (err) { await sendMessage(env, chatId, "Could not save that. Try again."); }
}

async function handleForgetCommand(env, chatId, userId, args) {
  const user = await getUser(env, userId);
  if (!user) return;
  if (user.memory_mode === "none") { await sendMessage(env, chatId, "Memory is already disabled."); return; }
  const topic = (args || "").trim();
  if (!topic) {
    try { await env.DB.prepare("UPDATE users SET memory_data = ?, updated_at = ? WHERE telegram_id = ?").bind(JSON.stringify({ last_updated: now() }), now(), userId).run(); } catch (err) {}
    await sendMessage(env, chatId, "Memory cleared.");
    return;
  }
  const data = parseMemoryData(user.memory_data);
  let changed = false;
  const filterField = function (field) {
    if (Array.isArray(data[field])) {
      const filtered = data[field].filter(function (f) { return !containsPhrase(String(f), topic); });
      if (filtered.length !== data[field].length) { data[field] = filtered; changed = true; }
    }
  };
  filterField("explicit_facts");
  filterField("interests");
  filterField("tools");
  filterField("projects");
  if (data.communication_style && containsPhrase(data.communication_style, topic)) { delete data.communication_style; changed = true; }
  if (data.preferred_name && containsPhrase(data.preferred_name, topic)) { delete data.preferred_name; changed = true; }
  if (!changed) { await sendMessage(env, chatId, "Nothing matching that found in memory."); return; }
  data.last_updated = now();
  try {
    await env.DB.prepare("UPDATE users SET memory_data = ?, updated_at = ? WHERE telegram_id = ?").bind(serializeMemoryData(data), now(), userId).run();
    await sendMessage(env, chatId, "Removed from memory: " + escapeHtml(topic));
  } catch (err) { await sendMessage(env, chatId, "Could not update memory."); }
}

async function handleMemoryCommand(env, chatId, userId) {
  const user = await getUser(env, userId);
  if (!user) return;
  const mode = user.memory_mode || "normal";
  if (mode === "none") { await sendMessage(env, chatId, "Memory is disabled. Enable it in /settings → Memory."); return; }
  const formatted = formatMemoryForUser(user.memory_data, mode);
  const header = "<b>Your Memory</b> (mode: " + mode + ")\n\n";
  await sendMessage(env, chatId, header + formatted, { parse_mode: "HTML" });
}

async function handleSetNameCommand(env, chatId, userId, args) {
  const name = sanitizeMemoryString(args);
  if (!name || name.length > 50) { await sendMessage(env, chatId, "Usage: /setname <name> (max 50 characters)."); return; }
  try {
    await env.DB.prepare("UPDATE users SET preferred_name = ?, updated_at = ? WHERE telegram_id = ?").bind(name, now(), userId).run();
    await sendMessage(env, chatId, "Got it — I'll call you " + escapeHtml(name) + ".");
  } catch (err) { await sendMessage(env, chatId, "Could not update. Try again."); }
}

async function handleUsageCommand(env, chatId, userId) { await showUsage(env, chatId, null, userId); }

async function handleNewPersonalityCommand(env, chatId, userId) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS c FROM custom_personalities WHERE telegram_id = ?").bind(userId).first();
  if (existing && existing.c >= MAX_PERSONALITIES) { await sendMessage(env, chatId, "You already have " + MAX_PERSONALITIES + " custom personalities."); return; }
  await sendMessage(env, chatId, "To create a custom personality, send:\n\n<code>/newpersonality Name | Description | System instructions...</code>", { parse_mode: "HTML" });
}

async function handleNewPersonalitySubmit(env, chatId, userId, args) {
  const parts = (args || "").split("|").map(function (s) { return s.trim(); });
  if (parts.length < 3) { await sendMessage(env, chatId, "Format: /newpersonality Name | Description | System instructions"); return; }
  const name = parts[0];
  const description = parts[1];
  const prompt = parts.slice(2).join(" | ");
  if (name.length === 0 || name.length > 50) { await sendMessage(env, chatId, "Name must be 1–50 characters."); return; }
  if (description.length > MAX_PERSONALITY_DESC) { await sendMessage(env, chatId, "Description too long."); return; }
  if (prompt.length > MAX_PERSONALITY_PROMPT) { await sendMessage(env, chatId, "Prompt too long."); return; }
  const existing = await env.DB.prepare("SELECT COUNT(*) AS c FROM custom_personalities WHERE telegram_id = ?").bind(userId).first();
  if (existing && existing.c >= MAX_PERSONALITIES) { await sendMessage(env, chatId, "You already have " + MAX_PERSONALITIES + " custom personalities."); return; }
  const id = generateShortId();
  try {
    await env.DB.prepare("INSERT INTO custom_personalities (personality_id, telegram_id, name, description, prompt, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(id, userId, name, description, prompt, now(), now()).run();
    await sendMessage(env, chatId, "✅ Personality '" + escapeHtml(name) + "' created. Manage it in /settings → Personalities.", { parse_mode: "HTML" });
  } catch (err) { await sendMessage(env, chatId, "Could not create personality. Try again."); }
}

async function handleAdminCommand(env, from, chat) {
  const userId = from.id;
  if (!isAdmin(env, userId)) { await sendMessage(env, chat.id, "Unknown command."); return; }
  if (chat.type !== "private") { await sendMessage(env, chat.id, "Admin panel is only available in private chat."); return; }
  const rateOk = await checkRateLimit(env, "admin:" + userId, RATE_LIMIT_ADMIN_PER_MIN, 60);
  if (!rateOk) { await sendMessage(env, chat.id, "Rate limit reached."); return; }
  await showAdminMenu(env, chat.id, null);
}

export async function showAdminMenu(env, chatId, messageId) {
  const text = "<b>Admin Panel</b>\n\nSelect a section:";
  const rows = [
    [{ text: "👥 Users", callback_data: "adm:users" }, { text: "💬 Groups", callback_data: "adm:groups" }],
    [{ text: "🚫 Blocked", callback_data: "adm:blocked" }, { text: "📊 Stats", callback_data: "adm:stats" }],
    [{ text: "🤖 Models", callback_data: "adm:conns" }, { text: "💚 Status", callback_data: "adm:status" }],
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

export async function handleUserCommand(env, ctx, command, args, message, from, chat) {
  const userId = from.id;
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (command === "/start") { await upsertUser(env, from); await handleStartCommand(env, chatId, userId); return true; }
  if (command === "/help") { await handleHelpCommand(env, chatId, userId, isGroup); return true; }
  if (command === "/settings") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /settings in private chat."); return true; }
    await upsertUser(env, from); await showSettingsMenu(env, chatId, null, userId); return true;
  }
  if (command === "/personality") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /personality in private chat."); return true; }
    await upsertUser(env, from); await showPersonalitiesForUser(env, chatId, null, userId); return true;
  }
  if (command === "/memory") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /memory in private chat."); return true; }
    await upsertUser(env, from); await handleMemoryCommand(env, chatId, userId); return true;
  }
  if (command === "/forget") { await upsertUser(env, from); await handleForgetCommand(env, chatId, userId, args); return true; }
  if (command === "/remember") { await upsertUser(env, from); await handleRememberCommand(env, chatId, userId, args); return true; }
  if (command === "/setname") { await upsertUser(env, from); await handleSetNameCommand(env, chatId, userId, args); return true; }
  if (command === "/usage") { await upsertUser(env, from); await handleUsageCommand(env, chatId, userId); return true; }
  if (command === "/newpersonality") {
    if (isGroup) { await sendMessage(env, chatId, "Please use this in private chat."); return true; }
    await upsertUser(env, from);
    if (args && args.trim().length > 0) await handleNewPersonalitySubmit(env, chatId, userId, args);
    else await handleNewPersonalityCommand(env, chatId, userId);
    return true;
  }
  if (command === "/search") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /search in private chat."); return true; }
    await upsertUser(env, from);
    await handleSearchCommand(env, chatId, userId, args);
    return true;
  }
  if (command === "/fetch") {
    if (isGroup) { await sendMessage(env, chatId, "Please use /fetch in private chat."); return true; }
    await upsertUser(env, from);
    await handleFetchCommand(env, chatId, userId, args);
    return true;
  }
  if (command === "/admin") { await handleAdminCommand(env, from, chat); return true; }
  if (command === "/stats") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "Unknown command."); return true; }
    if (isGroup) { await sendMessage(env, chatId, "Please use /stats in private chat."); return true; }
    await showAdminStats(env, chatId, null); return true;
  }
  return false;
}
