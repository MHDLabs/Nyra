// Incoming message pipeline: group access checks, flow-state interception
// (setup wizards own the next message), command dispatch, and the group
// trigger / reaction logic that decides whether Nyra answers at all.
import { MAX_MODEL_LENGTH, MAX_API_KEY_LENGTH } from "../config.js";
import { now, escapeHtml, isAdmin } from "../utils.js";
import { tg, sendMessage, deleteMessage, buildInlineKeyboard } from "../telegram.js";
import { getBotIdentity, getChat, recordGroupChatAndCheckAccess, isUserBlocked, isGroupTrigger, determineThreadId, getFlowState, clearFlowState, addRouteModel, addRouteToken } from "../db.js";
import { handleFlowMessage } from "../flows.js";
import { handleUserCommand } from "../commands.js";
import { shouldReact, trySetReaction, extractMessageText, setConfiguredReactions, clearConfiguredReactions } from "../reactions.js";
import { handleAIMessage } from "./ai-message.js";
import { parseCommand } from "./command-parse.js";

export async function processMessage(env, ctx, message) {
  const from = message.from;
  const chat = message.chat;
  if (!from || from.is_bot) return;
  const text = (message.text || "").trim();
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  if (isGroup) {
    const allowed = await recordGroupChatAndCheckAccess(env, chat, from.id);
    if (!allowed) return;
  }

  if (await isUserBlocked(env, from.id)) return;

  if (!isGroup) {
    const flowState = await getFlowState(env, from.id);
    if (flowState) {
      if (/^\/cancel(@\w+)?$/i.test(text)) { await clearFlowState(env, from.id); await sendMessage(env, chat.id, "Cancelled."); return; }
      if (text.startsWith("/")) { await clearFlowState(env, from.id); }
      // Reaction allowlist: the admin panel arms this flow, then the next plain
      // message holds the emoji Nyra may react with. "default" clears the
      // override so the built-in set applies again.
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

  if (text.startsWith("/")) {
    const identity = await getBotIdentity(env);
    const parsed = parseCommand(text, identity);
    if (!parsed) return;
    const handled = await handleUserCommand(env, ctx, parsed.command, parsed.args, message, from, chat);
    if (!handled) await sendMessage(env, chat.id, "Unknown command. Try /help.");
    return;
  }

  const hasContent = text || message.sticker || message.photo || message.animation || message.video || message.voice || message.document;
  if (!hasContent) return;

  if (isGroup) {
    // Try to set reaction (independent, fire-and-forget). The Chat object is
    // passed so the classifier can honour per-chat allowed reactions.
    if (shouldReact(message, chat)) {
      trySetReaction(env, ctx, chat, message.message_id, extractMessageText(message), from.id);
    }
    
    const identity = await getBotIdentity(env);
    const trigger = isGroupTrigger(message, identity);
    if (!trigger.trigger) return;
    const threadId = await determineThreadId(env, chat.id, message, identity, trigger.mode);
    await handleAIMessage(env, ctx, message, from, chat, true, threadId);
    return;
  }

  await handleAIMessage(env, ctx, message, from, chat, false, chat.id);
}
