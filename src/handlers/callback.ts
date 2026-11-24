// Button taps: menu navigation and the full admin/self-service callback
// surface. Bundled as one unit because the dispatch switch and the shared
// helpers it uses are tightly coupled and split apart would only add
// indirection.
import type { CallbackQuery } from "../../types/telegram.js";
import type { NyraEnv } from "../../types/env.js";
import { RATE_LIMIT_CALLBACK_PER_MIN, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS, RETIRED_PERSONALITY_IDS } from "../config.js";
import { now, escapeHtml, isAdmin, checkRateLimit } from "../utils.js";
import { sendMessage, answerCallback, editMessage, buildInlineKeyboard } from "../telegram.js";
import { getUser, getFlowState, setFlowState, clearFlowState, blockUser, unblockUser } from "../db.js";

import { showSettingsMenu, showPersonalitiesForUser, showMyPersonalities, showPersonalityDetail, showMemorySubmenu, showCustomInstructionsMenu, showUsage, showPrivacy } from "../menus.js";
import { showAdminMenu, showAdminUsers, showAdminGroups, showAdminBlocked, showAdminStats, showAdminStatus, showAdminReactions } from "../commands.js";
import { setConfiguredReactions, clearConfiguredReactions } from "../reactions.js";
import { handleOnboardingCallback } from "./onboarding.js";
import { setUserSelectedModel } from "../providers/registry.js";
import { retryWithCloudflare } from "./ai-message.js";

type WorkerCtx = { waitUntil?(promise: Promise<unknown>): void };

export async function handleCallbackQuery(
  env: NyraEnv,
  ctx: WorkerCtx,
  query: CallbackQuery
): Promise<void> {
  const data = query.data || "";
  const userId = query.from.id;
  const rateOk = await checkRateLimit(env, "cb:" + userId, RATE_LIMIT_CALLBACK_PER_MIN, 60);
  if (!rateOk) { await answerCallback(env, query.id, "Slow down."); return; }
  // Inline-menu callbacks in Nyra always originate from a bot message.
  if (!query.message) {
    await answerCallback(env, query.id, "");
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const parts = data.split(":");
  const namespace = parts[0];

  if (namespace === "ai" && parts[1] === "retry") {
    const token = String(parts[2] || "");
    await answerCallback(env, query.id, "در حال تلاش با Cloudflare…");
    try {
      const raw = token ? await env.KV.get("ai-retry:" + token) : null;
      if (!raw) { await editMessage(env, chatId, messageId, "این درخواست منقضی شده است. پیام را دوباره ارسال کنید."); return; }
      const snapshot = JSON.parse(raw);
      if (String(snapshot.user_id) !== String(userId)) { await editMessage(env, chatId, messageId, "این دکمه برای فرستندهٔ درخواست است."); return; }
      await env.KV.delete("ai-retry:" + token);
      await retryWithCloudflare(env, ctx, snapshot, userId);
    } catch (error) {
      console.error("Cloudflare retry callback failed:", error instanceof Error ? error.message : String(error));
      await editMessage(env, chatId, messageId, "⚠ تلاش مجدد با Cloudflare انجام نشد.");
    }
    return;
  }

  if (namespace === "mdl") {
    await answerCallback(env, query.id, "");
    if (parts[1] === "set" && parts[2]) {
      const saved = await setUserSelectedModel(env, userId, parts[2]);
      if (saved) {
        const { showUserModelMenu } = await import("../commands.js");
        await showUserModelMenu(env, chatId, messageId, userId);
      } else {
        await editMessage(env, chatId, messageId, "این مدل دیگر فعال یا برای حساب شما مجاز نیست.");
      }
    }
    return;
  }

  if (namespace === "onboard") {
    const action = parts[1];
    const value = parts[2];
    await handleOnboardingCallback(env, chatId, userId, messageId, action, value, query.id);
    return;
  }

  if (namespace === "set") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "menu") { await showSettingsMenu(env, chatId, messageId, userId); return; }
    if (action === "lang") {
      const { setUserLocale } = await import("../db/locale.js");
      const next = parts[2] === "fa-IR" || parts[2] === "fa" ? "fa-IR" : "en-US";
      await setUserLocale(env, userId, next);
      await showSettingsMenu(env, chatId, messageId, userId);
      return;
    }
    if (action === "pers") { await showPersonalitiesForUser(env, chatId, messageId, userId); return; }
    if (action === "mem") { await showMemorySubmenu(env, chatId, messageId, userId); return; }
    if (action === "ci") { await showCustomInstructionsMenu(env, chatId, messageId, userId); return; }
    if (action === "usage") { await showUsage(env, chatId, messageId, userId); return; }
    if (action === "privacy") { await showPrivacy(env, chatId, messageId); return; }
    if (action === "close") { await editMessage(env, chatId, messageId, "Settings closed."); return; }
    return;
  }

  if (namespace === "mem") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    const value = parts[2];
    if (action === "mode" && ["normal", "minimal", "none"].indexOf(value) !== -1) {
      await env.DB.prepare("UPDATE users SET memory_mode = ?, updated_at = ? WHERE telegram_id = ?").bind(value, now(), userId).run();
      await showMemorySubmenu(env, chatId, messageId, userId);
      return;
    }
    if (action === "clear") {
      await editMessage(env, chatId, messageId, "Clear all memory? This cannot be undone.", buildInlineKeyboard([
        [{ text: "Yes, clear", callback_data: "mem:clear2" }],
        [{ text: "Cancel", callback_data: "mem:back" }]
      ]), "HTML");
      return;
    }
    if (action === "clear2") {
      try { await env.DB.prepare("UPDATE users SET memory_data = ?, updated_at = ? WHERE telegram_id = ?").bind(JSON.stringify({ last_updated: now() }), now(), userId).run(); } catch (err) {}
      await showMemorySubmenu(env, chatId, messageId, userId);
      return;
    }
    if (action === "back") { await showMemorySubmenu(env, chatId, messageId, userId); return; }
    return;
  }

  if (namespace === "ci") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "set") {
      await setFlowState(env, userId, { flowType: "custom_instructions" });
      await sendMessage(env, chatId, "Send your custom instructions. They will be added to every conversation.\n\nMax " + MAX_CUSTOM_INSTRUCTIONS + " characters.\n\nSend /cancel to cancel.");
      return;
    }
    if (action === "clear") {
      try { await env.DB.prepare("UPDATE users SET custom_instructions = NULL, updated_at = ? WHERE telegram_id = ?").bind(now(), userId).run(); } catch (err) {}
      await showCustomInstructionsMenu(env, chatId, messageId, userId);
      return;
    }
    return;
  }

  if (namespace === "myp") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "list") { await showMyPersonalities(env, chatId, messageId, userId); return; }
    if (action === "new") { await sendMessage(env, chatId, "To create a custom personality, send:\n\n<code>/newpersonality Name | Description | System instructions...</code>", { parse_mode: "HTML" }); return; }
    if (action === "view") { await showPersonalityDetail(env, chatId, messageId, userId, parts[2]); return; }
    return;
  }

  if (namespace === "mypd") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    const rawId = parts[2];
    if (!rawId) return;
    const p = await env.DB.prepare("SELECT * FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1").bind(rawId, userId).first();
    if (!p) { await editMessage(env, chatId, messageId, "Personality not found.", buildInlineKeyboard([[{ text: "Back", callback_data: "myp:list" }]]), "HTML"); return; }
    if (action === "select") {
      await env.DB.prepare("UPDATE users SET personality_id = ?, updated_at = ? WHERE telegram_id = ?").bind("custom:" + rawId, now(), userId).run();
      await editMessage(env, chatId, messageId, "✅ Active personality set to <b>" + escapeHtml(p.name) + "</b>.", buildInlineKeyboard([[{ text: "Back", callback_data: "myp:view:" + rawId }]]), "HTML");
      return;
    }
    if (action === "rename") {
      await setFlowState(env, userId, { flowType: "personality_edit", editField: "name", personalityId: rawId });
      await sendMessage(env, chatId, "Send a new name (max 50 characters). Current: <b>" + escapeHtml(p.name) + "</b>\n\nSend /cancel to cancel.", { parse_mode: "HTML" });
      return;
    }
    if (action === "desc") {
      await setFlowState(env, userId, { flowType: "personality_edit", editField: "description", personalityId: rawId });
      await sendMessage(env, chatId, "Send a new description (max " + MAX_PERSONALITY_DESC + " characters).\n\nSend /cancel to cancel.");
      return;
    }
    if (action === "prompt") {
      await setFlowState(env, userId, { flowType: "personality_edit", editField: "prompt", personalityId: rawId });
      await sendMessage(env, chatId, "Send new system instructions (max " + MAX_PERSONALITY_PROMPT + " characters).\n\nSend /cancel to cancel.");
      return;
    }
    if (action === "del") {
      await editMessage(env, chatId, messageId, "Delete <b>" + escapeHtml(p.name) + "</b>?", buildInlineKeyboard([
        [{ text: "Yes, delete", callback_data: "mypd:del2:" + rawId }],
        [{ text: "Cancel", callback_data: "myp:view:" + rawId }]
      ]), "HTML");
      return;
    }
    if (action === "del2") {
      try { await env.DB.prepare("DELETE FROM custom_personalities WHERE personality_id = ? AND telegram_id = ?").bind(rawId, userId).run(); } catch (err) {}
      const user = await getUser(env, userId);
      if (user && user.personality_id === "custom:" + rawId) {
        await env.DB.prepare("UPDATE users SET personality_id = 'default', updated_at = ? WHERE telegram_id = ?").bind(now(), userId).run();
      }
      await showMyPersonalities(env, chatId, messageId, userId);
      return;
    }
    return;
  }

  if (namespace === "pers") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    const target = parts[2];
    if (action === "set") {
      if (target.indexOf("custom:") === 0) {
        const realId = target.slice(7);
        const c = await env.DB.prepare("SELECT personality_id FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1").bind(realId, userId).first();
        if (!c) { await editMessage(env, chatId, messageId, "Personality not found."); return; }
      } else {
        const p = await env.DB.prepare("SELECT personality_id FROM personalities WHERE personality_id = ? AND enabled = 1").bind(target).first();
        if (!p || RETIRED_PERSONALITY_IDS.indexOf(target) !== -1) { await editMessage(env, chatId, messageId, "Personality not found."); return; }
      }
      await env.DB.prepare("UPDATE users SET personality_id = ?, updated_at = ? WHERE telegram_id = ?").bind(target, now(), userId).run();
      await editMessage(env, chatId, messageId, "Personality updated.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:pers" }]]), "HTML");
      return;
    }
    return;
  }

  if (namespace === "adm") {
    if (!isAdmin(env, userId)) { await answerCallback(env, query.id, "Unauthorized."); return; }
    await answerCallback(env, query.id, "");
    // Menu navigation is chatty; allow a higher burst than write actions.
    const adminRateOk = await checkRateLimit(env, "admin-nav:" + userId, 60, 60);
    if (!adminRateOk) { if (messageId) await editMessage(env, chatId, messageId, "Rate limit reached."); return; }
    const section = parts[1];
    const action = parts[2];
    const target = parts[3];
    try {
      if (section === "main" || section === "menu") { await clearFlowState(env, userId); await showAdminMenu(env, chatId, messageId); }
      else if (section === "maint") {
        const { showAdminMaintenance } = await import("../commands.js");
        const { setMaintenanceMode } = await import("../db/maintenance.js");
        if (action === "on") { await setMaintenanceMode(env, true, userId); }
        else if (action === "off") { await setMaintenanceMode(env, false, userId); }
        await showAdminMaintenance(env, chatId, messageId);
      }
      else if (section === "models") {
        const { showAdminModels } = await import("../commands.js");
        await showAdminModels(env, chatId, messageId);
      }
      else if (section === "model") {
        const { getAdminModelList, setModelEnabled, setModelVisibility, setDefaultModel } = await import("../providers/registry.js");
        const models = await getAdminModelList(env);
        const model = models.find(item => item.id === target);
        if (model && action === "toggle") await setModelEnabled(env, target, !model.enabled);
        else if (model && action === "visibility" && !model.fallback_only) await setModelVisibility(env, target, !model.user_selectable);
        else if (model && action === "default") await setDefaultModel(env, target);
        const { showAdminModels } = await import("../commands.js");
        await showAdminModels(env, chatId, messageId);
      }
      else if (section === "users") { await showAdminUsers(env, chatId, messageId); }
      else if (section === "groups") { await showAdminGroups(env, chatId, messageId); }
      else if (section === "blocked") { await showAdminBlocked(env, chatId, messageId); }
      else if (section === "stats") { await showAdminStats(env, chatId, messageId); }
      else if (section === "status") { await showAdminStatus(env, chatId, messageId); }
      else if (section === "triggers") {
        const { showAdminTriggers } = await import("../commands.js");
        await showAdminTriggers(env, chatId, messageId);
      }
      else if (section === "trig") {
        const { showAdminTriggers } = await import("../commands.js");
        const { setTriggerFlag, getTriggerConfig } = await import("../db/settings.js");
        const cfg = await getTriggerConfig(env);
        if (action === "enabled") await setTriggerFlag(env, "trigger_enabled", !cfg.enabled, userId);
        else if (action === "reply") await setTriggerFlag(env, "trigger_reply", !cfg.reply, userId);
        else if (action === "mention") await setTriggerFlag(env, "trigger_mention", !cfg.mention, userId);
                await showAdminTriggers(env, chatId, messageId);
      }
      else if (section === "react") {
        // Opening the section arms a flow so the admin's next plain message is
        // parsed as the allowlist; restoring defaults disarms it again.
        if (action === "default") { await clearConfiguredReactions(env); await clearFlowState(env, userId); }
        else await setFlowState(env, userId, { flowType: "reaction_config" });
        await showAdminReactions(env, chatId, messageId);
      }
      else if (section === "close") { await clearFlowState(env, userId); await editMessage(env, chatId, messageId, "Closed."); }
      else if (section === "group") {
        if (action === "add") {
          await setFlowState(env, userId, { step: "admin_group_add", flowType: "admin" });
          await sendMessage(env, chatId, "Send the numeric chat ID to add.");
        }
      }
      else if (section === "gm") {
        const targetChatId = action;
        const mode = target;
        if (targetChatId && ["enabled", "disabled", "admin_only"].indexOf(mode) !== -1) {
          await env.DB.prepare("UPDATE chats SET mode = ?, enabled = ?, updated_at = ? WHERE chat_id = ?").bind(mode, mode === "disabled" ? 0 : 1, now(), targetChatId).run();
          await showAdminGroups(env, chatId, messageId);
        }
      }
      else if (section === "user") {
        if (action === "block" && target) {
          if (isAdmin(env, target)) { await editMessage(env, chatId, messageId, "Cannot block an admin.", buildInlineKeyboard([[{ text: "Back", callback_data: "adm:main" }]]), "HTML"); return; }
          await blockUser(env, target, userId, "admin block");
          await showAdminUsers(env, chatId, messageId);
        } else if (action === "unblock" && target) {
          await unblockUser(env, target);
          await showAdminBlocked(env, chatId, messageId);
        }
      }
    } catch (err) {
      console.error("Admin callback failed:", err.message);
      if (messageId) await editMessage(env, chatId, messageId, "Action failed.");
    }
    return;
  }

  await answerCallback(env, query.id, "");
}

