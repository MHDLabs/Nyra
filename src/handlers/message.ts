// Telegram message pipeline: onboarding, retained preference flows, commands, group policy, and AI chat.
import type { TelegramMessage } from "../../types/telegram.js";
import type { NyraEnv } from "../../types/env.js";
import { now, escapeHtml, isAdmin } from "../utils.js";
import { tg, sendMessage, buildInlineKeyboard } from "../telegram.js";
import {
  getBotIdentity,
  recordGroupChatAndCheckAccess,
  isUserBlocked,
  isGroupTrigger,
  determineThreadId,
  getFlowState,
  clearFlowState,
  getUser
} from "../db.js";
import { handlePreferenceFlow } from "../flows.js";
import { handleUserCommand } from "../commands.js";
import { shouldReact, trySetReaction, extractMessageText, setConfiguredReactions, clearConfiguredReactions } from "../reactions.js";
import { getTriggerConfig } from "../db/settings.js";
import { handleAIMessage } from "./ai-message.js";
import { parseCommand } from "./command-parse.js";
import { handleOnboardingMessage, getOnboardingState } from "./onboarding.js";
import { isMaintenanceMode } from "../db/maintenance.js";
import { t } from "../i18n/index.js";

type WorkerCtx = { waitUntil?(promise: Promise<unknown>): void };

export async function processMessage(env: NyraEnv, ctx: WorkerCtx, message: TelegramMessage): Promise<void> {
  const from = message.from;
  const chat = message.chat;
  if (!from || from.is_bot) return;

  const text = String(message.text || message.caption || "").trim();
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  if (isGroup && !(await recordGroupChatAndCheckAccess(env, chat, from.id))) return;
  if (await isUserBlocked(env, from.id)) return;

  if (!isGroup) {
    const onboardingState = await getOnboardingState(env, from.id);
    if (onboardingState && onboardingState.step && onboardingState.step !== "complete") {
      if (/^\/cancel(@\w+)?$/i.test(text)) {
        await env.DB.prepare("UPDATE users SET onboarding_state = NULL, updated_at = ? WHERE telegram_id = ?")
          .bind(now(), from.id).run();
        await sendMessage(env, chat.id, "Onboarding cancelled.");
        return;
      }
      if (text.startsWith("/")) {
        await env.DB.prepare("UPDATE users SET onboarding_state = NULL, updated_at = ? WHERE telegram_id = ?")
          .bind(now(), from.id).run();
      } else {
        const handled = await handleOnboardingMessage(env, chat.id, from.id, text);
        if (handled) return;
      }
    }

    const flowState = await getFlowState(env, from.id);
    if (flowState) {
      if (/^\/cancel(@\w+)?$/i.test(text)) {
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "Cancelled.");
        return;
      }
      if (text.startsWith("/")) {
        await clearFlowState(env, from.id);
      } else if (flowState.flowType === "reaction_config") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        if (/^(default|reset|پیش\u200c?فرض)$/i.test(text)) {
          await clearConfiguredReactions(env);
          await clearFlowState(env, from.id);
          await sendMessage(env, chat.id, "✅ Reaction allowlist reset to the built-in emoji.", {
            reply_markup: buildInlineKeyboard([[{ text: "Reactions", callback_data: "adm:react" }]])
          });
          return;
        }
        const parsed = await setConfiguredReactions(env, text);
        if (!parsed.allowed.length) {
          await sendMessage(env, chat.id, "None of those are valid Telegram reactions. Example: 👍 ❤ 🤔");
          return;
        }
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "✅ Nyra may now react with: " + parsed.allowed.join(" ")
          + (parsed.ignored ? "\n\nIgnored " + parsed.ignored + " emoji Telegram does not accept." : ""), {
            reply_markup: buildInlineKeyboard([[{ text: "Reactions", callback_data: "adm:react" }]])
          });
        return;
      } else if (flowState.step === "admin_group_add") {
        if (!isAdmin(env, from.id)) { await clearFlowState(env, from.id); return; }
        if (!/^-?\d+$/.test(text)) { await sendMessage(env, chat.id, "That's not a valid numeric chat ID."); return; }
        const targetChatId = Number(text);
        if (!Number.isFinite(targetChatId)) { await sendMessage(env, chat.id, "Invalid chat ID."); return; }
        const chatInfo = await tg(env, "getChat", { chat_id: targetChatId });
        if (!chatInfo || !chatInfo.ok || !chatInfo.result) {
          await sendMessage(env, chat.id, "Could not access that chat.");
          return;
        }
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO chats (chat_id, chat_type, title, enabled, mode, summary, created_at, updated_at) VALUES (?, ?, ?, 1, 'enabled', '', ?, ?)")
            .bind(targetChatId, chatInfo.result.type || "group", chatInfo.result.title || "", now(), now()).run();
          await env.DB.prepare("UPDATE chats SET enabled = 1, mode = 'enabled', updated_at = ? WHERE chat_id = ?")
            .bind(now(), targetChatId).run();
          await clearFlowState(env, from.id);
          await sendMessage(env, chat.id, "✅ Chat " + targetChatId + " added and enabled.\nTitle: "
            + escapeHtml(chatInfo.result.title || "(no title)"), { parse_mode: "HTML" });
        } catch (error) {
          console.error("admin_group_add failed:", error instanceof Error ? error.message : String(error));
          await sendMessage(env, chat.id, "Failed to add chat.");
        }
        return;
      } else if (flowState.flowType === "custom_instructions" || flowState.flowType === "personality_edit") {
        await handlePreferenceFlow(env, message, from, chat, flowState);
        return;
      } else {
        // Discard obsolete setup state left by an earlier version of Nyra.
        await clearFlowState(env, from.id);
        await sendMessage(env, chat.id, "This setup flow is no longer available. Please use /settings.");
        return;
      }
    }

    if (text && !text.startsWith("/")) {
      const mapped = mapReplyMenuText(text);
      if (mapped) {
        await handleUserCommand(env, ctx, mapped, "", message, from, chat);
        return;
      }
    }
  }

  if (text.startsWith("/")) {
    const identity = await getBotIdentity(env);
    const parsed = parseCommand(message, { username: identity.username || undefined });
    if (!parsed) return;
    await handleUserCommand(env, ctx, parsed.command, parsed.args, message, from, chat);
    return;
  }

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
    const trigger = isGroupTrigger(message, { username: identity.username || undefined, id: identity.id }, triggerCfg);
    if (!trigger.trigger) return;
    const threadId = await determineThreadId(env, chat.id, message, identity, trigger.mode);
    await handleAIMessage(env, ctx, message, from, chat, true, threadId);
    return;
  }

  await handleAIMessage(env, ctx, message, from, chat, false, chat.id);
}

function mapReplyMenuText(text: string): string | null {
  const value = String(text || "").trim();
  if (value === "⚙️ تنظیمات" || value === "⚙️ Settings") return "settings";
  if (value === "🎭 شخصیت" || value === "🎭 Personality") return "personality";
  if (value === "🧠 حافظه" || value === "🧠 Memory") return "memory";
  if (value === "❓ راهنما" || value === "❓ Help") return "help";
  return null;
}
