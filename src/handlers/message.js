// Incoming message pipeline: group access checks, onboarding interception,
// flow-state interception (setup wizards own the next message), command dispatch,
// maintenance check, and the group trigger / reaction logic that decides whether Nyra answers at all.
import { MAX_MODEL_LENGTH, MAX_API_KEY_LENGTH } from "../config.js";
import { now, escapeHtml, isAdmin } from "../utils.js";
import { tg, sendMessage, deleteMessage, buildInlineKeyboard } from "../telegram.js";
import { getBotIdentity, getChat, recordGroupChatAndCheckAccess, isUserBlocked, isGroupTrigger, determineThreadId, getFlowState, clearFlowState, addRouteModel, addRouteToken, getUser } from "../db.js";
import { handleFlowMessage } from "../flows.js";
import { handleUserCommand } from "../commands.js";
import { shouldReact, trySetReaction, extractMessageText, setConfiguredReactions, clearConfiguredReactions } from "../reactions.js";
import { getTriggerConfig } from "../db/settings.js";
import { handleAIMessage } from "./ai-message.js";
import { parseCommand } from "./command-parse.js";
import { handleOnboardingMessage, getOnboardingState } from "./onboarding.js";
import { isMaintenanceMode } from "../db/maintenance.js";
import { t } from "../i18n/index.js";
import { handleReminderClarification } from "../reminders/commands.js";
import { touchLastInbound } from "../db/users.js";

export async function processMessage(env, ctx, message) {
  const from = message.from;
  const chat = message.chat;
  if (!from || from.is_bot) return;
  // Prefer text; fall back to caption so commands on media captions work
  // (Telegram delivers /cmd in caption + caption_entities for photos/docs).
  const text = (message.text || message.caption || "").trim();
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  if (isGroup) {
    const allowed = await recordGroupChatAndCheckAccess(env, chat, from.id);
    if (!allowed) return;
  }

  if (await isUserBlocked(env, from.id)) return;

  // Private inbound activity advances the proactive inactivity clock.
  // Group traffic, bot messages, and blocked users never reset it.
  if (!isGroup) {
    ctx.waitUntil(touchLastInbound(env, from.id).catch(function () {}));
  }

  if (!isGroup) {
    // Check onboarding state first (takes priority over flows)
    const onboardingState = await getOnboardingState(env, from.id);
    if (onboardingState && onboardingState.step && onboardingState.step !== "complete") {
      // Allow /cancel to exit onboarding
      if (/^\/cancel(@\w+)?$/i.test(text)) {
        await env.DB.prepare("UPDATE users SET onboarding_state = NULL, updated_at = ? WHERE telegram_id = ?")
          .bind(now(), from.id).run();
        await sendMessage(env, chat.id, "Onboarding cancelled.");
        return;
      }
      // Commands during onboarding clear state and process command
      // Reply-keyboard shortcuts (private chat menu under the input field).
  if (!isGroup && text && !text.startsWith("/")) {
    const mapped = mapReplyMenuText(text);
    if (mapped) {
      await handleUserCommand(env, ctx, mapped, "", message, from, chat);
      return;
    }
  }

  if (text.startsWith("/")) {
        await env.DB.prepare("UPDATE users SET onboarding_state = NULL, updated_at = ? WHERE telegram_id = ?")
          .bind(now(), from.id).run();
        // Continue to command processing below
      } else {
        // Handle onboarding message
        const handled = await handleOnboardingMessage(env, chat.id, from.id, text);
        if (handled) return;
      }
    }

    const flowState = await getFlowState(env, from.id);
    if (flowState) {
      if (/^\/cancel(@\w+)?$/i.test(text)) { await clearFlowState(env, from.id); await sendMessage(env, chat.id, "Cancelled."); return; }
      // Reply-keyboard shortcuts (private chat menu under the input field).
  if (!isGroup && text && !text.startsWith("/")) {
    const mapped = mapReplyMenuText(text);
    if (mapped) {
      await handleUserCommand(env, ctx, mapped, "", message, from, chat);
      return;
    }
  }

  if (text.startsWith("/")) { await clearFlowState(env, from.id); }
      else if (flowState.flowType === "reaction_config") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        if (/^(default|reset|پیش\u200c?فرض)$/i.test(text.trim())) {
          await clearConfiguredReactions(env);
          await clearFlowState(env, from.id);
          await sendMessage(env, chat.id, "✅ Reaction allowlist reset to the built-in emoji.", { reply_markup: buildInlineKeyboard([[{ text: "Reactions", callback_data: "adm:react" }]]) });
          return;
        }
        const parsed = await setConfiguredReactions(env, text);
        if (!parsed.allowed.length) { await sendMessage(env, chat.id, "None of those are valid Telegram reactions. Example: 👍 ❤ 🤔"); return; }
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "✅ Nyra may now react with: " + parsed.allowed.join(" ") + (parsed.ignored ? "\n\nIgnored " + parsed.ignored + " emoji Telegram does not accept." : ""), { reply_markup: buildInlineKeyboard([[{ text: "Reactions", callback_data: "adm:react" }]]) });
        return;
      }
      else if (flowState.step === "admin_group_add") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        if (!/^-?\d+$/.test(text)) { await sendMessage(env, chat.id, "That's not a valid numeric chat ID."); return; }
        const chatIdNum = Number(text);
        if (!isFinite(chatIdNum)) { await sendMessage(env, chat.id, "Invalid chat ID."); return; }
        const chatInfo = await tg(env, "getChat", { chat_id: chatIdNum });
        if (!chatInfo || !chatInfo.ok || !chatInfo.result) { await sendMessage(env, chat.id, "Could not access that chat."); return; }
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO chats (chat_id, chat_type, title, enabled, mode, summary, created_at, updated_at) VALUES (?, ?, ?, 1, 'enabled', '', ?, ?)").bind(chatIdNum, chatInfo.result.type || "group", chatInfo.result.title || "", now(), now()).run();
          await env.DB.prepare("UPDATE chats SET enabled = 1, mode = 'enabled', updated_at = ? WHERE chat_id = ?").bind(now(), chatIdNum).run();
          await clearFlowState(env, from.id);
          await sendMessage(env, chat.id, "✅ Chat " + chatIdNum + " added and enabled.\nTitle: " + escapeHtml(chatInfo.result.title || "(no title)"), { parse_mode: "HTML" });
        } catch (err) { console.error("admin_group_add failed:", err.message); await sendMessage(env, chat.id, "Failed to add chat."); }
        return;
      } else if (flowState.flowType === "reminder_clarify") {
        // Time/timezone clarification replies for /remind — must not fall into AI.
        await handleReminderClarification(env, message, from, chat, flowState);
        return;
      } else if (flowState.flowType === "custom_instructions" || flowState.flowType === "personality_edit") {
        await handleFlowMessage(env, ctx, message, from, chat, flowState);
        return;
      } else if (flowState.flowType === "add_route" || flowState.flowType === "edit_route") {
        await handleFlowMessage(env, ctx, message, from, chat, flowState);
        return;
      } else if (flowState.flowType === "route_add_model") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        const modelName = text.trim();
        if (modelName.length === 0 || modelName.length > MAX_MODEL_LENGTH) { await sendMessage(env, chat.id, "Model name must be 1–" + MAX_MODEL_LENGTH + " characters."); return; }
        await addRouteModel(env, from.id, flowState.routeId, modelName);
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "✅ Model added to route.", { reply_markup: buildInlineKeyboard([[{ text: "Back to Route", callback_data: "route:list" }]]) });
        return;
      } else if (flowState.flowType === "route_add_token") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        const key = text.trim();
        const delResult = await deleteMessage(env, chat.id, message.message_id);
        if (!delResult || !delResult.ok) await sendMessage(env, chat.id, "⚠ I could not delete your API key message. Please delete it manually.");
        if (key.length === 0 || key.length > MAX_API_KEY_LENGTH) { await sendMessage(env, chat.id, "API key length is invalid."); return; }
        await addRouteToken(env, from.id, flowState.routeId, key);
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "✅ Token added to route.", { reply_markup: buildInlineKeyboard([[{ text: "Back to Route", callback_data: "route:list" }]]) });
        return;
      } else if (flowState.step === "label" || flowState.step === "description" || flowState.step === "base_url" || flowState.step === "api_key" || flowState.step === "model" ||
                 flowState.step === "edit_label" || flowState.step === "edit_description" || flowState.step === "edit_base_url" || flowState.step === "edit_api_key" || flowState.step === "edit_model" ||
                 flowState.step === "route_label" || flowState.step === "route_edit_label" || flowState.step === "route_base_url" || flowState.step === "route_models" || flowState.step === "route_tokens") {
        await handleFlowMessage(env, ctx, message, from, chat, flowState);
        return;
      } else {
        await sendMessage(env, chat.id, "Please use the buttons above or send /cancel to cancel the current setup.");
        return;
      }
    }
  }

  // Reply-keyboard shortcuts (private chat menu under the input field).
  if (!isGroup && text && !text.startsWith("/")) {
    const mapped = mapReplyMenuText(text);
    if (mapped) {
      await handleUserCommand(env, ctx, mapped, "", message, from, chat);
      return;
    }
  }

  if (text.startsWith("/")) {
    const identity = await getBotIdentity(env);
    // Pass the full message so bot_command entities (and caption_entities) are used.
    const parsed = parseCommand(message, identity);
    if (!parsed) return;
    await handleUserCommand(env, ctx, parsed.command, parsed.args, message, from, chat);
    return;
  }

  // Maintenance check for AI messages (not commands)
  const maintenance = await isMaintenanceMode(env);
  if (maintenance) {
    const user = await getUser(env, from.id);
    const locale = user?.locale || "en-US";
    await sendMessage(env, chat.id, t(locale, "maintenance.notice"));
    return;
  }

  const hasContent = text || message.sticker || message.photo || message.animation || message.video || message.voice || message.document;
  if (!hasContent) return;

  if (isGroup) {
    const identity = await getBotIdentity(env);
    if (shouldReact(message, chat, identity)) {
      trySetReaction(env, ctx, chat, message.message_id, extractMessageText(message), from.id);
    }
    const triggerCfg = await getTriggerConfig(env);
    const trigger = isGroupTrigger(message, identity, triggerCfg);
    if (!trigger.trigger) return;
    const threadId = await determineThreadId(env, chat.id, message, identity, trigger.mode);
    await handleAIMessage(env, ctx, message, from, chat, true, threadId);
    return;
  }

  await handleAIMessage(env, ctx, message, from, chat, false, chat.id);
}


function mapReplyMenuText(text) {
  const s = String(text || "").trim();
  if (s === "⚙️ تنظیمات" || s === "⚙️ Settings") return "settings";
  if (s === "🎭 شخصیت" || s === "🎭 Personality") return "personality";
  if (s === "🧠 حافظه" || s === "🧠 Memory") return "memory";
  if (s === "❓ راهنما" || s === "❓ Help") return "help";
  return null;
}
