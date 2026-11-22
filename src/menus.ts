// @ts-nocheck — progressive domain typing (Task 7); refine in Task 10
// Nyra — Telegram menus for settings, memory, personalities, usage, and privacy.
import { truncate, escapeHtml, isAdmin } from "./utils.js";
import { sendMessage, editMessage, buildInlineKeyboard } from "./telegram.js";
import { getUser, parseUsageStats } from "./db.js";
import { formatMemoryForUser, listAvailablePersonalities } from "./memory.js";

export async function showNoConnectionMessage(env, chatId, isGroup) {
  if (isGroup) return;
  const user = await getUser(env, chatId).catch(() => null);
  const fa = String(user?.locale || "").startsWith("fa");
  await sendMessage(env, chatId, fa
    ? "⚠ سرویس هوش مصنوعی هنوز توسط مدیر پیکربندی نشده است."
    : "⚠ The AI service has not been configured by the administrator yet.");
}

export async function showSettingsMenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const hasCI = !!(user && user.custom_instructions && user.custom_instructions.length > 0);
  const loc = (user && user.locale) || "en-US";
  const fa = String(loc).startsWith("fa");
  const model = typeof env.AI_MODEL === "string" && env.AI_MODEL.trim() ? env.AI_MODEL.trim() : "";
  const memoryMode = (user && user.memory_mode) || "normal";
  const configured = !!(model && env.AI_API_KEY);
  const lines = fa
    ? ["<b>⚙️ تنظیمات</b>", "",
       "مدل مرکزی: " + (configured ? "<code>" + escapeHtml(model) + "</code>" : "<i>پیکربندی نشده</i>"),
       "حافظه: " + escapeHtml(memoryMode),
       "زبان: فارسی"]
    : ["<b>⚙️ Settings</b>", "",
       "Central model: " + (configured ? "<code>" + escapeHtml(model) + "</code>" : "<i>not configured</i>"),
       "Memory: " + escapeHtml(memoryMode),
       "Language: " + escapeHtml(loc)];
  const rows = [
    [{ text: fa ? "🎭 شخصیت‌ها" : "🎭 Personalities", callback_data: "set:pers" }],
    [
      { text: fa ? "🧠 حافظه" : "🧠 Memory", callback_data: "set:mem" },
      { text: (fa ? "✏️ دستورالعمل" : "✏️ Instructions") + (hasCI ? " ✓" : ""), callback_data: "set:ci" }
    ],
    [{ text: (fa ? "🌐 زبان: " : "🌐 Language: ") + (fa ? "فارسی" : "English"), callback_data: "set:lang:" + (fa ? "en-US" : "fa-IR") }],
    [
      { text: fa ? "📊 مصرف" : "📊 Usage", callback_data: "set:usage" },
      { text: fa ? "🔒 حریم خصوصی" : "🔒 Privacy", callback_data: "set:privacy" }
    ]
  ];
  if (isAdmin(env, userId)) {
    rows.push([{ text: fa ? "🛠 مدیریت" : "🛠 Administration", callback_data: "adm:main" }]);
  }
  rows.push([{ text: fa ? "بستن" : "Close", callback_data: "set:close" }]);
  await editMessage(env, chatId, messageId, (fa ? "\u200F" : "") + lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showPersonalitiesForUser(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const { builtins, customs } = await listAvailablePersonalities(env, userId);
  const current = (user && user.personality_id) || "default";
  const lines = ["<b>Choose Personality</b>", ""];
  const rows = [];
  for (const personality of builtins) {
    rows.push([{ text: personality.name + (personality.id === current ? " ✓" : ""), callback_data: "pers:set:" + personality.id }]);
  }
  if (customs.length) rows.push([{ text: "My Personalities (" + customs.length + ")", callback_data: "myp:list" }]);
  lines.push("", "Create a custom personality with /newpersonality");
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showMyPersonalities(env, chatId, messageId, userId) {
  const { customs } = await listAvailablePersonalities(env, userId);
  const user = await getUser(env, userId);
  const current = (user && user.personality_id) || "default";
  const lines = ["<b>My Personalities</b>", ""];
  const rows = [];
  if (!customs.length) lines.push("You have no custom personalities yet.");
  for (const personality of customs) {
    rows.push([{ text: personality.name + (personality.id === current ? " ✓" : ""), callback_data: "myp:view:" + personality.rawId }]);
  }
  rows.push([{ text: "Create New", callback_data: "myp:new" }]);
  rows.push([{ text: "Back", callback_data: "set:pers" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showPersonalityDetail(env, chatId, messageId, userId, rawId) {
  let personality = null;
  try {
    personality = await env.DB.prepare("SELECT * FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1").bind(rawId, userId).first();
  } catch (error) {}
  if (!personality) {
    await editMessage(env, chatId, messageId, "Personality not found.", buildInlineKeyboard([[{ text: "Back", callback_data: "myp:list" }]]), "HTML");
    return;
  }
  const user = await getUser(env, userId);
  const isCurrent = user && user.personality_id === "custom:" + rawId;
  const lines = ["<b>" + escapeHtml(personality.name) + "</b>", ""];
  if (personality.description) lines.push("<i>" + escapeHtml(personality.description) + "</i>", "");
  lines.push("Prompt length: " + (personality.prompt ? personality.prompt.length : 0) + " chars");
  const rows = [
    [{ text: isCurrent ? "✓ Active" : "Select", callback_data: "mypd:select:" + rawId }],
    [{ text: "Rename", callback_data: "mypd:rename:" + rawId }, { text: "Edit Description", callback_data: "mypd:desc:" + rawId }],
    [{ text: "Edit Prompt", callback_data: "mypd:prompt:" + rawId }],
    [{ text: "Delete", callback_data: "mypd:del:" + rawId }],
    [{ text: "Back", callback_data: "myp:list" }]
  ];
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showMemorySubmenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const mode = (user && user.memory_mode) || "normal";
  const lines = ["<b>Memory</b>", "", "Current mode: <b>" + escapeHtml(mode) + "</b>", ""];
  if (mode === "none") lines.push("<i>Memory is disabled.</i>");
  else lines.push("<blockquote expandable>" + formatMemoryForUser(user ? user.memory_data : null, mode, user?.locale || "en-US") + "</blockquote>");
  const rows = [
    [{ text: "Normal" + (mode === "normal" ? " ✓" : ""), callback_data: "mem:mode:normal" }],
    [{ text: "Minimal" + (mode === "minimal" ? " ✓" : ""), callback_data: "mem:mode:minimal" }],
    [{ text: "None" + (mode === "none" ? " ✓" : ""), callback_data: "mem:mode:none" }],
    [{ text: "Clear Memory", callback_data: "mem:clear" }],
    [{ text: "Back", callback_data: "set:menu" }]
  ];
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showCustomInstructionsMenu(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const instructions = (user && user.custom_instructions) || "";
  const lines = ["<b>Custom Instructions</b>", ""];
  if (instructions) lines.push("<blockquote expandable>" + escapeHtml(instructions) + "</blockquote>");
  else lines.push("<i>No custom instructions set.</i>", "", "Custom instructions are added to every conversation as a persistent preference.");
  const rows = [[{ text: instructions ? "Replace Instructions" : "Set Instructions", callback_data: "ci:set" }]];
  if (instructions) rows.push([{ text: "Clear", callback_data: "ci:clear" }]);
  rows.push([{ text: "Back", callback_data: "set:menu" }]);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function showUsage(env, chatId, messageId, userId) {
  const user = await getUser(env, userId);
  const stats = parseUsageStats(user ? user.usage_stats : null);
  const lines = ["<b>Usage</b>", "",
    "Total requests: " + stats.total,
    "Successful: " + stats.success,
    "Failed: " + stats.fail];
  if (stats.last_at > 0) lines.push("Last request: " + new Date(stats.last_at * 1000).toISOString());
  if (stats.last_error) lines.push("Last error: " + escapeHtml(stats.last_error));
  if (stats.token_source === "provider_reported") {
    lines.push("Input tokens: " + stats.in_tokens, "Output tokens: " + stats.out_tokens);
  } else lines.push("<i>Token usage not reported by provider.</i>");
  if (stats.cost_usd > 0) lines.push("Cumulative cost: $" + stats.cost_usd.toFixed(4));
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML");
}

export async function showPrivacy(env, chatId, messageId) {
  const user = await getUser(env, chatId).catch(() => null);
  const fa = String(user?.locale || "").startsWith("fa");
  const text = fa
    ? "<b>🔒 حریم خصوصی</b>\n\n"
      + "• نیرا پروفایل سبک، حافظهٔ ساختاریافته و بافت گفت‌وگوی اخیر را نگه می‌دارد.\n"
      + "• حافظه و گفتگوها در پایگاه دادهٔ پروژه ذخیره می‌شوند؛ متن حافظه رمزنگاری‌شده نیست.\n"
      + "• مدل و کلید هوش مصنوعی فقط توسط مدیر و در تنظیمات سرور پیکربندی می‌شوند؛ کلید به کاربران یا مرورگر ارسال نمی‌شود.\n"
      + "• پیام‌های چت برای پنل مدیریت مستقل بایگانی می‌شوند (فقط مدیران).\n"
      + "• حافظه و گفتگوهای شما برای کاربران عادی دیگر قابل مشاهده نیستند.\n\n"
      + "رفتار حافظه را از بخش حافظه تغییر دهید."
    : "<b>🔒 Privacy</b>\n\n"
      + "• Nyra stores a lightweight profile, structured memory, and recent conversation context.\n"
      + "• Memory and conversations are stored in the project database; memory text is not encrypted.\n"
      + "• The model and API credential are configured by the operator in server-side settings and are never sent to users or browser clients.\n"
      + "• Chat messages are archived for the standalone Web Admin Panel (admins only).\n"
      + "• Your memory and conversations are not visible to other regular users.\n\n"
      + "Change memory behavior under Memory.";
  await editMessage(env, chatId, messageId, (fa ? "\u200F" : "") + text,
    buildInlineKeyboard([[{ text: fa ? "بازگشت" : "Back", callback_data: "set:menu" }]]), "HTML");
}
