// Button taps: menu navigation and the full admin/self-service callback
// surface. Bundled as one unit because the dispatch switch and the shared
// helpers it uses are tightly coupled and split apart would only add
// indirection.
import { RATE_LIMIT_ADMIN_PER_MIN, RATE_LIMIT_CALLBACK_PER_MIN, RATE_LIMIT_CONN_TEST_PER_MIN, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL } from "../config.js";
import { now, truncate, escapeHtml, isAdmin, checkRateLimit } from "../utils.js";
import { sendMessage, answerCallback, editMessage, buildInlineKeyboard } from "../telegram.js";
import { getUser, getFlowState, setFlowState, clearFlowState, getUserConnectionById, deleteUserConnection, toggleUserConnection, setDefaultConnection, setConnectionFast, setConnectionVision, updateUserConnectionTest, setDefaultRoute, deleteRoute, setRouteDefaultModel, removeRouteModel, removeRouteToken, toggleRouteToken } from "../db.js";
import { humanizeError, testUserConnectionById } from "../ai.js";
import { showSettingsMenu, showModelList, showPersonalitiesForUser, showMyPersonalities, showPersonalityDetail, showMemorySubmenu, showCustomInstructionsMenu, showUsage, showPrivacy, sourceSuffix, sourceBackButton, showMyConnections, resolveUserConnectionShortId, showRoutesList, showRouteDetail, resolveRouteShortId, resolveRouteItemShortId, showPersonalModelsMenu } from "../menus.js";
import { startAddConnectionFlow, startEditConnectionFlow, flowPromptLabel, flowPromptApiKey, flowPromptReview, handleFlowSkip, flowFetchModels, showModelPage, flowSelectModel, finalizeConnectionFromFlow, startAddRouteFlow, startEditRouteFlow, routePromptBaseUrl, routePromptModels, routePromptReview, finalizeRouteFromFlow } from "../flows.js";
import { showAdminMenu, showAdminUsers, showAdminGroups, showAdminBlocked, showAdminStats, showAdminStatus, showAdminReactions } from "../commands.js";
import { setConfiguredReactions, clearConfiguredReactions } from "../reactions.js";

export async function handleCallbackQuery(env, ctx, query) {
  const data = query.data || "";
  const userId = query.from.id;
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const messageId = query.message ? query.message.message_id : null;
  const rateOk = await checkRateLimit(env, "cb:" + userId, RATE_LIMIT_CALLBACK_PER_MIN, 60);
  if (!rateOk) { await answerCallback(env, query.id, "Slow down."); return; }
  const parts = data.split(":");
  const namespace = parts[0];

  if (namespace === "flow") {
    await answerCallback(env, query.id, "");
    const flowState = await getFlowState(env, userId);
    const action = parts[1];
    if (action === "cancel") { await clearFlowState(env, userId); await editMessage(env, chatId, messageId, "Cancelled."); return; }
    if (!flowState) { await editMessage(env, chatId, messageId, "Setup flow expired. Start again."); return; }
    if (action === "provider") {
      const provider = parts[2];
      if (provider !== "openai-compatible" && provider !== "anthropic") return;
      flowState.provider = provider;
      flowState.step = "label";
      await setFlowState(env, userId, flowState);
      await editMessage(env, chatId, messageId, "Provider: " + provider);
      await flowPromptLabel(env, chatId, null);
      return;
    }
    if (action === "use_default_url") {
      flowState.base_url = flowState.provider === "anthropic" ? ANTHROPIC_DEFAULT_URL : OPENAI_DEFAULT_URL;
      const isEdit = flowState.flowType === "edit";
      flowState.step = isEdit ? "edit_api_key" : "api_key";
      await setFlowState(env, userId, flowState);
      await editMessage(env, chatId, messageId, "Using default URL.");
      await flowPromptApiKey(env, chatId, isEdit);
      return;
    }
    if (action === "skip") { await handleFlowSkip(env, chatId, userId, flowState); return; }
    if (action === "vision") {
      flowState.supports_vision = parts[2] === "1" ? 1 : 0;
      flowState.step = flowState.flowType === "edit" ? "edit_confirm" : "confirm";
      await setFlowState(env, userId, flowState);
      await editMessage(env, chatId, messageId, flowState.supports_vision ? "Images enabled for this model." : "Text-only model.");
      await flowPromptReview(env, chatId, flowState);
      return;
    }
    if (action === "fetchmodels") { await flowFetchModels(env, chatId, userId, flowState); return; }
    if (action === "manual") {
      flowState.step = flowState.flowType === "edit" ? "edit_model" : "model";
      await setFlowState(env, userId, flowState);
      await sendMessage(env, chatId, "Send the model name.");
      return;
    }
    if (action === "mp") {
      const page = parseInt(parts[2], 10);
      if (isNaN(page)) return;
      await showModelPage(env, chatId, messageId, userId, flowState, page);
      return;
    }
    if (action === "ms") {
      const idx = parseInt(parts[2], 10);
      if (isNaN(idx)) return;
      await flowSelectModel(env, chatId, userId, flowState, idx);
      return;
    }
    if (action === "save" || action === "retry_test") {
      if (flowState.flowType === "add_route" || flowState.flowType === "edit_route") {
        await editMessage(env, chatId, messageId, "Saving route...");
        await finalizeRouteFromFlow(env, chatId, userId, flowState);
        return;
      }
      if (!flowState.encrypted_key || !flowState.model) { await editMessage(env, chatId, messageId, "Flow state incomplete. Restart."); return; }
      await editMessage(env, chatId, messageId, "Testing connection... This may take up to 10 seconds.");
      await finalizeConnectionFromFlow(env, chatId, userId, flowState);
      return;
    }
    if (action === "route_provider") {
      const provider = parts[2];
      if (provider !== "openai-compatible" && provider !== "anthropic") return;
      flowState.provider = provider;
      flowState.step = "route_base_url";
      await setFlowState(env, userId, flowState);
      await editMessage(env, chatId, messageId, "Provider: " + provider);
      await routePromptBaseUrl(env, chatId, provider);
      return;
    }
    if (action === "route_default_url") {
      flowState.base_url = flowState.provider === "anthropic" ? ANTHROPIC_DEFAULT_URL : OPENAI_DEFAULT_URL;
      flowState.step = "route_models";
      await setFlowState(env, userId, flowState);
      await editMessage(env, chatId, messageId, "Using default URL.");
      await routePromptModels(env, chatId, null);
      return;
    }
    if (action === "route_save") {
      await editMessage(env, chatId, messageId, "Saving route...");
      await finalizeRouteFromFlow(env, chatId, userId, flowState);
      return;
    }
    if (action === "route_keep_tokens") {
      flowState.step = "route_confirm";
      await setFlowState(env, userId, flowState);
      await routePromptReview(env, chatId, flowState);
      return;
    }
    return;
  }

  if (namespace === "route") {
    await answerCallback(env, query.id, "");
    if (!isAdmin(env, userId)) { await editMessage(env, chatId, messageId, "Only administrators can manage routes.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML"); return; }
    const action = parts[1];
    if (action === "list") { await showRoutesList(env, chatId, messageId, userId, "set"); return; }
    if (action === "add") { await startAddRouteFlow(env, chatId, userId, "set"); return; }
    const routeId = await resolveRouteShortId(env, userId, parts[2]);
    if (!routeId) { await editMessage(env, chatId, messageId, "Route not found.", buildInlineKeyboard([[{ text: "Back", callback_data: "route:list" }]]), "HTML"); return; }
    if (action === "view") { await showRouteDetail(env, chatId, messageId, userId, routeId, "set"); return; }
    if (action === "def") { await setDefaultRoute(env, userId, routeId); await showRoutesList(env, chatId, messageId, userId, "set"); return; }
    if (action === "edit") { await startEditRouteFlow(env, chatId, userId, routeId, "set"); return; }
    if (action === "del") { await deleteRoute(env, userId, routeId); await showRoutesList(env, chatId, messageId, userId, "set"); return; }
    if (action === "madd") { await setFlowState(env, userId, { flowType: "route_add_model", routeId: routeId }); await sendMessage(env, chatId, "Send the model name to add."); return; }
    if (action === "tadd") { await setFlowState(env, userId, { flowType: "route_add_token", routeId: routeId }); await sendMessage(env, chatId, "Send the API key to add.\n\n⚠ Your message will be deleted immediately after Nyra reads it."); return; }
    const itemId = await resolveRouteItemShortId(env, routeId, parts[3]);
    if (action === "mdef") { await setRouteDefaultModel(env, userId, routeId, itemId); await showRouteDetail(env, chatId, messageId, userId, routeId, "set"); return; }
    if (action === "mdel") { await removeRouteModel(env, userId, routeId, itemId); await showRouteDetail(env, chatId, messageId, userId, routeId, "set"); return; }
    if (action === "ttog") { await toggleRouteToken(env, userId, routeId, itemId); await showRouteDetail(env, chatId, messageId, userId, routeId, "set"); return; }
    if (action === "tdel") { await removeRouteToken(env, userId, routeId, itemId); await showRouteDetail(env, chatId, messageId, userId, routeId, "set"); return; }
    return;
  }

  if (namespace === "mypersonal") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "menu") { await showPersonalModelsMenu(env, chatId, messageId, userId); return; }
    if (action === "add") { await startAddConnectionFlow(env, chatId, userId, "set"); return; }
    const connId = await resolveUserConnectionShortId(env, userId, parts[2]);
    if (!connId) { await editMessage(env, chatId, messageId, "Model not found.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML"); return; }
    if (action === "edit") { await startEditConnectionFlow(env, chatId, userId, connId, "set"); return; }
    if (action === "del") {
      const conn = await getUserConnectionById(env, userId, connId);
      if (conn && conn.is_global === 0) { await deleteUserConnection(env, userId, connId); }
      await showPersonalModelsMenu(env, chatId, messageId, userId);
      return;
    }
    return;
  }

  if (namespace === "set") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "menu") { await showSettingsMenu(env, chatId, messageId, userId); return; }
    if (action === "model") { await showModelList(env, chatId, messageId, userId, 0); return; }
    if (action === "pers") { await showPersonalitiesForUser(env, chatId, messageId, userId); return; }
    if (action === "mem") { await showMemorySubmenu(env, chatId, messageId, userId); return; }
    if (action === "ci") { await showCustomInstructionsMenu(env, chatId, messageId, userId); return; }
    if (action === "usage") { await showUsage(env, chatId, messageId, userId); return; }
    if (action === "privacy") { await showPrivacy(env, chatId, messageId); return; }
    if (action === "close") { await editMessage(env, chatId, messageId, "Settings closed."); return; }
    if (action === "fallback") {
      const user = await getUser(env, userId);
      const current = !user || user.fallback_enabled !== 0;
      const newVal = current ? 0 : 1;
      await env.DB.prepare("UPDATE users SET fallback_enabled = ?, updated_at = ? WHERE telegram_id = ?").bind(newVal, now(), userId).run();
      await showSettingsMenu(env, chatId, messageId, userId);
      return;
    }
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

  if (namespace === "myconn") {
    await answerCallback(env, query.id, "");
    if (!isAdmin(env, userId)) { await editMessage(env, chatId, messageId, "Only administrators can manage models.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML"); return; }
    const action = parts[1];
    const source = parseMyconnSource(action, parts);
    if (action === "list") { await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "add") { await startAddConnectionFlow(env, chatId, userId, source); return; }
    const shortId = parts[2];
    const connId = await resolveUserConnectionShortId(env, userId, shortId);
    if (!connId) { await editMessage(env, chatId, messageId, "Connection not found.", buildInlineKeyboard([[sourceBackButton(source)]]), "HTML"); return; }
    if (action === "tog") { await toggleUserConnection(env, userId, connId); await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "fast") { await setConnectionFast(env, userId, connId); await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "vision") { await setConnectionVision(env, userId, connId); await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "del") { await deleteUserConnection(env, userId, connId); await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "def") { await setDefaultConnection(env, userId, connId); await showMyConnections(env, chatId, messageId, userId, source); return; }
    if (action === "edit") { await startEditConnectionFlow(env, chatId, userId, connId, source); return; }
    if (action === "test") {
      const testRateOk = await checkRateLimit(env, "conntest:" + userId, RATE_LIMIT_CONN_TEST_PER_MIN, 60);
      if (!testRateOk) { await editMessage(env, chatId, messageId, "Too many tests."); return; }
      const conn = await getUserConnectionById(env, userId, connId);
      if (!conn) { await editMessage(env, chatId, messageId, "Connection not found."); return; }
      await editMessage(env, chatId, messageId, "Testing...");
      const test = await testUserConnectionById(env, userId, connId);
      await updateUserConnectionTest(env, userId, connId, test.status, test.error, test.latency, test.diagnostic);
      let text;
      if (test.status === "success") {
        text = "✅ <b>" + escapeHtml(conn.label) + "</b> test passed (" + (test.latency || "?") + " ms)";
      } else {
        text = "⚠ <b>" + escapeHtml(conn.label) + "</b> test failed\n<b>" + escapeHtml(test.status) + "</b>\n" + escapeHtml(humanizeError(test.status));
        if (test.diagnostic) text += "\n\n<i>Diagnostic:</i>\n<code>" + escapeHtml(truncate(test.diagnostic, 400)) + "</code>";
      }
      await editMessage(env, chatId, messageId, text, buildInlineKeyboard([[{ text: "Back", callback_data: "myconn:list" + sourceSuffix(source) }]]), "HTML");
      return;
    }
    return;
  }

  if (namespace === "model") {
    await answerCallback(env, query.id, "");
    const action = parts[1];
    if (action === "pg") {
      const page = parseInt(parts[2], 10);
      if (isNaN(page)) return;
      await showModelList(env, chatId, messageId, userId, page);
      return;
    }
    if (action === "set") {
      const shortId = parts[2];
      const connId = await resolveUserConnectionShortId(env, userId, shortId);
      if (!connId) { await editMessage(env, chatId, messageId, "That model is no longer available.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML"); return; }
      const conn = await getUserConnectionById(env, userId, connId);
      if (!conn || conn.enabled !== 1) { await editMessage(env, chatId, messageId, "That model is no longer available.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML"); return; }
      await env.DB.prepare("UPDATE users SET active_connection_id = ?, updated_at = ? WHERE telegram_id = ?").bind(connId, now(), userId).run();
      await editMessage(env, chatId, messageId, "✅ Active model set to <b>" + escapeHtml(conn.label) + "</b>.", buildInlineKeyboard([[{ text: "Back", callback_data: "set:menu" }]]), "HTML");
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
        if (!p) { await editMessage(env, chatId, messageId, "Personality not found."); return; }
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
    const adminRateOk = await checkRateLimit(env, "admin:" + userId, RATE_LIMIT_ADMIN_PER_MIN, 60);
    if (!adminRateOk) { if (messageId) await editMessage(env, chatId, messageId, "Rate limit reached."); return; }
    const section = parts[1];
    const action = parts[2];
    const target = parts[3];
    try {
      if (section === "main") { await clearFlowState(env, userId); await showAdminMenu(env, chatId, messageId); }
      else if (section === "users") { await showAdminUsers(env, chatId, messageId); }
      else if (section === "groups") { await showAdminGroups(env, chatId, messageId); }
      else if (section === "blocked") { await showAdminBlocked(env, chatId, messageId); }
      else if (section === "stats") { await showAdminStats(env, chatId, messageId); }
      else if (section === "conns") { await showMyConnections(env, chatId, messageId, userId, "adm"); }
      else if (section === "status") { await showAdminStatus(env, chatId, messageId); }
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
          await env.DB.prepare("INSERT OR REPLACE INTO blocked_users (telegram_id, reason, blocked_at, blocked_by) VALUES (?, 'admin block', ?, ?)").bind(target, now(), userId).run();
          await showAdminUsers(env, chatId, messageId);
        } else if (action === "unblock" && target) {
          await env.DB.prepare("DELETE FROM blocked_users WHERE telegram_id = ?").bind(target).run();
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

export function parseMyconnSource(action, parts) {
  if (action === "list" || action === "add") {
    return parts[2] === "adm" ? "adm" : "set";
  }
  return parts[3] === "adm" ? "adm" : "set";
}
