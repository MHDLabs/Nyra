// Nyra — entry point: AI message pipeline, update routing, webhook and setup endpoints.
import { MAX_TELEGRAM_LENGTH, MEMORY_UPDATE_INTERVAL, RATE_LIMIT_USER_PER_MIN, RATE_LIMIT_USER_PER_HOUR, RATE_LIMIT_CHAT_PER_HOUR, RATE_LIMIT_ADMIN_PER_MIN, RATE_LIMIT_CALLBACK_PER_MIN, RATE_LIMIT_SETUP_PER_MIN, RATE_LIMIT_CONN_TEST_PER_MIN, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS, UNHEALTHY_FAILURE_THRESHOLD, UNHEALTHY_WARN_TTL, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL, STREAM_EDIT_THROTTLE_MS, STREAM_PLACEHOLDER } from "./config.js";
import { now, okResponse, jsonResponse, truncate, escapeHtml, stripTelegramHtml, constantTimeEqual, buildUserContent, isAdmin, parseAdminIds, checkMemoryRate, checkRateLimit } from "./utils.js";
import { getMasterKey, initSecrets, getWebhookSecret } from "./crypto.js";
import { tg, sendMessageReturn, sendMessage, sendMessageSafeResult, answerCallback, editMessage, deleteMessage, buildInlineKeyboard, startTypingHeartbeat, ensureWebhook } from "./telegram.js";
import { ensureSchema, maybeInitSchema, getBotIdentity, getUser, upsertUser, getChat, recordGroupChatAndCheckAccess, isUserBlocked, saveThreadMessage, getThreadContext, isGroupTrigger, determineThreadId, getFlowState, setFlowState, clearFlowState, getUserConnectionById, deleteUserConnection, toggleUserConnection, setDefaultConnection, updateUserConnectionTest, updateUsageStatsAsync, resolveUserActiveConnection, trackConnectionUsage } from "./db.js";
import { normalizeError, humanizeError, shouldNotifyAdmin, testUserConnectionById, tryStreamWithFallback, notifyAdminOnError } from "./ai.js";
import { buildContextMessages, getUserPersonality, consolidateMemory, consolidateChatSummary, incrementMessageCount } from "./memory.js";
import { showNoConnectionMessage, showSettingsMenu, showModelList, showPersonalitiesForUser, showMyPersonalities, showPersonalityDetail, showMemorySubmenu, showCustomInstructionsMenu, showUsage, showPrivacy, sourceSuffix, sourceBackButton, showMyConnections, resolveUserConnectionShortId } from "./menus.js";
import { startAddConnectionFlow, startEditConnectionFlow, flowPromptLabel, flowPromptApiKey, handleFlowMessage, handleFlowSkip, flowFetchModels, showModelPage, flowSelectModel, finalizeConnectionFromFlow } from "./flows.js";
import { showAdminMenu, showAdminUsers, showAdminGroups, showAdminBlocked, showAdminStats, showAdminStatus, handleUserCommand } from "./commands.js";
import { serveStatic, routeMiniAppAPI } from "./miniapp.js";
import { getStaticAsset, getContentType } from "./assets.js";
import { shouldReact, trySetReaction } from "./reactions.js";
import { safeFormat } from "./formatter.js";

async function handleAIMessage(env, ctx, message, from, chat, isGroup, threadId) {
  const userId = from.id;
  const chatId = chat.id;
  const rawText = (message.text || message.caption || "").trim();
  const hasSticker = !!message.sticker;
  const hasAnyContent = rawText || hasSticker || message.photo || message.animation || message.video || message.voice || message.document;
  if (!hasAnyContent) return;

  const rateOk = await checkRateLimit(env, "user:min:" + userId, RATE_LIMIT_USER_PER_MIN, 60);
  if (!rateOk) {
    if (!isGroup) await sendMessage(env, chatId, "Slow down. Try again in a minute.");
    return;
  }
  const hourOk = await checkRateLimit(env, "user:hour:" + userId, RATE_LIMIT_USER_PER_HOUR, 3600);
  if (!hourOk) {
    if (!isGroup) await sendMessage(env, chatId, "Hourly limit reached. Try again later.");
    return;
  }
  if (isGroup) {
    const chatOk = await checkRateLimit(env, "chat:hour:" + chatId, RATE_LIMIT_CHAT_PER_HOUR, 3600);
    if (!chatOk) return;
  }

  const user = await upsertUser(env, from);
  if (!user) {
    if (!isGroup) await sendMessage(env, chatId, "⚠ Could not load your profile. Try again.");
    return;
  }

  const resolved = await resolveUserActiveConnection(env, user);
  if (!resolved.connection) {
    await showNoConnectionMessage(env, chatId, isGroup);
    return;
  }
  const connection = resolved.connection;
  if (resolved.previousMissing && !isGroup) {
    await sendMessage(env, chatId, "ℹ Your previous model is no longer available. Switched to <b>" + escapeHtml(connection.label) + "</b>.", { parse_mode: "HTML" });
  }

  if ((connection.consecutive_failures || 0) >= UNHEALTHY_FAILURE_THRESHOLD) {
    const warnKey = "unhealthy:" + userId + ":" + connection.connection_id;
    try {
      const warned = await env.KV.get(warnKey);
      if (warned !== "1") {
        await env.KV.put(warnKey, "1", { expirationTtl: UNHEALTHY_WARN_TTL });
        if (!isGroup) await sendMessage(env, chatId, "⚠ This model has been failing repeatedly. Try another model or contact an administrator.", { parse_mode: "HTML" });
      }
    } catch (e) {}
  }

  const personality = await getUserPersonality(env, user);
  const recentContext = await getThreadContext(env, chatId, threadId);
  const chatRow = isGroup ? await getChat(env, chatId) : null;
  const mode = (user && user.memory_mode) || "normal";
  const userContent = buildUserContent(message);

  await saveThreadMessage(env, chatId, threadId, message.message_id, userId, "user", userContent);

  const messages = buildContextMessages(personality, user, chatRow, recentContext, userContent, mode);
  const streamOptions = { max_tokens: 2048, temperature: 0.7 };
  const replyToId = isGroup ? message.message_id : undefined;

  const placeholderResult = await sendMessageSafeResult(env, chatId, STREAM_PLACEHOLDER, { reply_to_message_id: replyToId });
  if (!placeholderResult || !placeholderResult.ok || !placeholderResult.result || typeof placeholderResult.result.message_id !== "number") {
    if (!isGroup) await sendMessage(env, chatId, "⚠ Could not start a response. Please try again.");
    return;
  }
  const placeholderMsgId = placeholderResult.result.message_id;

  let accumulated = "";
  let lastEditAt = 0;
  let lastEditedText = "";
  const heartbeat = startTypingHeartbeat(env, ctx, chatId);
  let heartbeatStopped = false;
  let finalUsage = null;
  let finalConn = null;
  let finalAttempts = 0;
  let finalFallbackUsed = false;
  let streamError = null;
  let streamErrorCategory = null;
  let streamCompleted = false;

  try {
    for await (const event of tryStreamWithFallback(env, user, messages, streamOptions)) {
      if (event.type === "text") {
        if (!heartbeatStopped) {
          heartbeat.stop();
          heartbeatStopped = true;
        }
        accumulated += event.text;
        const nowMs = Date.now();
        if (nowMs - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
          lastEditAt = nowMs;
          let preview = stripTelegramHtml(accumulated);
          if (preview.length > MAX_TELEGRAM_LENGTH - 20) {
            preview = preview.slice(0, MAX_TELEGRAM_LENGTH - 30) + "\n...";
          }
          if (preview !== lastEditedText && preview.length > 0) {
            lastEditedText = preview;
            await editMessage(env, chatId, placeholderMsgId, preview, undefined, undefined);
          }
        }
      } else if (event.type === "usage") {
        finalUsage = event.usage;
      } else if (event.type === "done") {
        finalUsage = event.usage;
        finalConn = event.connection;
        finalAttempts = event.attempts;
        finalFallbackUsed = event.fallbackUsed;
        streamCompleted = true;
      } else if (event.type === "error") {
        streamError = event.error;
        streamErrorCategory = event.category;
        finalConn = event.connection;
        finalAttempts = event.attempts || 0;
        finalFallbackUsed = event.fallbackUsed || false;
      }
    }
  } catch (e) {
    streamError = e;
    streamErrorCategory = normalizeError(e, e.status);
  } finally {
    if (!heartbeatStopped) heartbeat.stop();
  }

  if (!streamCompleted || streamError) {
    const category = streamErrorCategory || "unknown";
    updateUsageStatsAsync(env, ctx, userId, false, category, null);
    if (accumulated.length > 0) {
      const note = "\n\n<i>⚠ Response interrupted.</i>";
      let preview = stripTelegramHtml(accumulated);
      if (preview.length + note.length > MAX_TELEGRAM_LENGTH) {
        preview = preview.slice(0, MAX_TELEGRAM_LENGTH - note.length - 10) + "…";
      }
      const finalText = preview + note;
      await editMessage(env, chatId, placeholderMsgId, finalText, undefined, "HTML");
      await saveThreadMessage(env, chatId, threadId, placeholderMsgId, null, "assistant", accumulated);
    } else {
      await deleteMessage(env, chatId, placeholderMsgId);
      if (!isGroup) await sendMessage(env, chatId, "⚠ " + humanizeError(category), { parse_mode: "HTML" });
    }
    if (shouldNotifyAdmin(category)) {
      const connForAlert = finalConn || connection;
      ctx.waitUntil(notifyAdminOnError(env, {
        connection_id: connForAlert ? connForAlert.connection_id : null,
        connection_label: connForAlert ? connForAlert.label : null,
        provider: connForAlert ? connForAlert.provider : null,
        model: connForAlert ? connForAlert.model : null,
        category: category,
        attempts: finalAttempts,
        raw_error: streamError ? (streamError.message || String(streamError)) : "no error detail",
        user_id: userId,
        chat_id: chatId,
        fallback_used: finalFallbackUsed
      }));
    }
    return;
  }

  updateUsageStatsAsync(env, ctx, userId, true, null, finalUsage);
  
  // Track connection usage metrics
  if (finalConn) {
    const totalTokens = finalUsage ? ((finalUsage.in || 0) + (finalUsage.out || 0)) : 0;
    ctx.waitUntil(trackConnectionUsage(env, finalConn.connection_id, userId, totalTokens));
  }
  
  const replyText = accumulated || "(empty response)";
  const formatted = safeFormat(replyText, "HTML");
  const sendText = formatted.text;
  const parseMode = formatted.parseMode;

  let finalMsgId = placeholderMsgId;
  if (sendText.length > MAX_TELEGRAM_LENGTH) {
    await deleteMessage(env, chatId, placeholderMsgId);
    const sentResult = await sendMessageReturn(env, chatId, sendText, { parse_mode: parseMode, reply_to_message_id: replyToId });
    if (sentResult && sentResult.ok && sentResult.result && typeof sentResult.result.message_id === "number") {
      finalMsgId = sentResult.result.message_id;
    }
    await saveThreadMessage(env, chatId, threadId, finalMsgId, null, "assistant", replyText);
  } else {
    const finalEdit = await editMessage(env, chatId, placeholderMsgId, sendText, undefined, parseMode);
    if (!finalEdit || !finalEdit.ok) {
      const desc = String(finalEdit ? finalEdit.description : "").toLowerCase();
      if (desc.indexOf("not modified") === -1) {
        await deleteMessage(env, chatId, placeholderMsgId);
        const sentNew = await sendMessageReturn(env, chatId, sendText, { parse_mode: parseMode, reply_to_message_id: replyToId });
        if (sentNew && sentNew.ok && sentNew.result && typeof sentNew.result.message_id === "number") {
          finalMsgId = sentNew.result.message_id;
        }
      }
    }
    await saveThreadMessage(env, chatId, threadId, finalMsgId, null, "assistant", replyText);
  }

  const counter = await incrementMessageCount(env, userId);
  if (counter >= MEMORY_UPDATE_INTERVAL && mode !== "none") {
    ctx.waitUntil((async function () {
      try {
        const updatedUser = await getUser(env, userId);
        const updatedContext = await getThreadContext(env, chatId, threadId);
        await consolidateMemory(env, updatedUser, updatedContext, { user: userContent, assistant: replyText });
        if (isGroup) {
          const updatedChat = await getChat(env, chatId);
          await consolidateChatSummary(env, updatedChat, userId, updatedContext, { user: userContent, assistant: replyText });
        }
      } catch (err) {
        console.error("Memory consolidation background task failed:", err.message);
      }
    })());
  }
}


function parseMyconnSource(action, parts) {
  if (action === "list" || action === "add") {
    return parts[2] === "adm" ? "adm" : "set";
  }
  return parts[3] === "adm" ? "adm" : "set";
}

async function handleCallbackQuery(env, ctx, query) {
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
      if (!flowState.encrypted_key || !flowState.model) { await editMessage(env, chatId, messageId, "Flow state incomplete. Restart."); return; }
      await editMessage(env, chatId, messageId, "Testing connection... This may take up to 10 seconds.");
      await finalizeConnectionFromFlow(env, chatId, userId, flowState);
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
      if (section === "main") { await showAdminMenu(env, chatId, messageId); }
      else if (section === "users") { await showAdminUsers(env, chatId, messageId); }
      else if (section === "groups") { await showAdminGroups(env, chatId, messageId); }
      else if (section === "blocked") { await showAdminBlocked(env, chatId, messageId); }
      else if (section === "stats") { await showAdminStats(env, chatId, messageId); }
      else if (section === "conns") { await showMyConnections(env, chatId, messageId, userId, "adm"); }
      else if (section === "status") { await showAdminStatus(env, chatId, messageId); }
      else if (section === "close") { await editMessage(env, chatId, messageId, "Closed."); }
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

function parseCommand(text, identity) {
  if (!text.startsWith("/")) return null;
  const parts = text.split(/\s+/);
  const firstWord = parts[0];
  const atIdx = firstWord.indexOf("@");
  let command = firstWord.toLowerCase();
  if (atIdx !== -1) {
    const cmdName = firstWord.slice(0, atIdx).toLowerCase();
    const targetUsername = firstWord.slice(atIdx + 1);
    if (identity && identity.username) {
      if (targetUsername.toLowerCase() !== identity.username.toLowerCase()) return null;
    }
    command = cmdName;
  }
  const args = parts.slice(1).join(" ");
  return { command: command, args: args };
}

async function processMessage(env, ctx, message) {
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
      } else if (flowState.step === "label" || flowState.step === "description" || flowState.step === "base_url" || flowState.step === "api_key" || flowState.step === "model" ||
                 flowState.step === "edit_label" || flowState.step === "edit_description" || flowState.step === "edit_base_url" || flowState.step === "edit_api_key" || flowState.step === "edit_model") {
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
    // Try to set reaction (independent, fire-and-forget)
    if (shouldReact(message, true)) {
      const reactionText = message.text || message.caption || "";
      trySetReaction(env, ctx, chat.id, message.message_id, reactionText);
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

// GET / — status page and bootstrap endpoint. Idempotent: initialises the
// schema (KV-gated) and registers/verifies the Telegram webhook from the
// request's own origin, so a fresh one-click deployment becomes functional the
// first time anything loads it (the post-deploy probe, a human, or a monitor).
async function handleStatus(request, env, adminIds) {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!checkMemoryRate("status:" + clientIp, 30, 60000)) return new Response("Too Many Requests", { status: 429 });
  await maybeInitSchema(env);
  const hook = await ensureWebhook(env, new URL(request.url).origin);
  const hookLine = hook.ok
    ? hook.status + " → " + hook.url
    : "problem: " + hook.status + (hook.detail ? " — " + hook.detail : "");
  const adminLine = adminIds.configured
    ? adminIds.valid.length + " configured" + (adminIds.invalid.length ? "; " + adminIds.invalid.length + " non-numeric entr" + (adminIds.invalid.length === 1 ? "y" : "ies") + " ignored" : "")
    : "NOT CONFIGURED — set ADMIN_IDS to your numeric Telegram user ID(s) in wrangler.toml [vars] and redeploy";
  const body = [
    "Nyra is running.",
    "",
    "Webhook:   " + hookLine,
    "Admin IDs: " + adminLine,
    "Queue:     " + (env.NYRA_QUEUE ? "bound (NYRA_QUEUE)" : "MISSING — check the queues config in wrangler.toml"),
    "",
    adminIds.configured ? "Send /start to the bot in Telegram." : "Admin commands are disabled until ADMIN_IDS is set."
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function handleWebhook(request, env, ctx) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  const expectedSecret = await getWebhookSecret(env);
  if (!expectedSecret || !constantTimeEqual(secret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const masterKey = getMasterKey(env);
  if (!masterKey) {
    console.error("ENCRYPTION_KEY missing or invalid. Refusing to process requests.");
    return new Response("Service Unavailable", { status: 503 });
  }
  let update;
  try { update = await request.json(); } catch (err) { return new Response("Bad Request", { status: 400 }); }
  try { await ensureSchema(env); } catch (err) {
    console.error("ensureSchema failed:", err.message);
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!env.NYRA_QUEUE) {
    console.error("NYRA_QUEUE binding is missing. Deploy with the queue configuration from wrangler.toml.");
    return new Response("Service Unavailable", { status: 503 });
  }
  // Durable acceptance: deduplicate by update_id, then enqueue before acking.
  // Telegram retries on non-2xx, so an enqueue failure must free the dedup slot.
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  if (updateId !== null) {
    let firstDelivery = true;
    try {
      const inserted = await env.DB.prepare(
        "INSERT INTO processed_updates (update_id, received_at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING RETURNING update_id"
      ).bind(updateId, Math.floor(Date.now() / 1000)).first();
      firstDelivery = inserted != null;
    } catch (err) {
      console.error("update dedup insert failed:", err.message);
      return new Response("Service Unavailable", { status: 503 });
    }
    if (!firstDelivery) return okResponse();
  }
  try {
    await env.NYRA_QUEUE.send({ update: update });
  } catch (err) {
    console.error("update enqueue failed:", err.message);
    if (updateId !== null) {
      try { await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run(); }
      catch (e) { console.error("dedup rollback failed:", e.message); }
    }
    return new Response("Service Unavailable", { status: 503 });
  }
  return okResponse();
}

async function handleSetup(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/setup") return new Response("Not Found", { status: 404 });
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!checkMemoryRate("setup:" + clientIp, RATE_LIMIT_SETUP_PER_MIN, 60000)) return new Response("Too Many Requests", { status: 429 });
  if (url.searchParams.has("secret")) {
    // Secrets in the query string leak into logs/history/referrers — header only.
    console.error("Rejected /setup request: secret provided via query string. Use the X-Setup-Secret header.");
    return new Response("Unauthorized", { status: 401 });
  }
  const setupSecret = request.headers.get("X-Setup-Secret") || "";
  const expectedSecret = await getWebhookSecret(env);
  if (!expectedSecret || !constantTimeEqual(setupSecret, expectedSecret)) return new Response("Unauthorized", { status: 401 });
  const webhookUrl = url.searchParams.get("url");
  if (!webhookUrl) return new Response("Missing url parameter", { status: 400 });
  if (!webhookUrl.startsWith("https://")) return new Response("Webhook URL must use HTTPS", { status: 400 });
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.host !== url.host) return new Response("Webhook URL must match this worker's host", { status: 400 });
    if (parsed.pathname !== "/webhook") return new Response("Webhook URL path must be exactly /webhook", { status: 400 });
  } catch (err) { return new Response("Invalid webhook URL", { status: 400 }); }
  const result = await tg(env, "setWebhook", {
    url: webhookUrl,
    secret_token: expectedSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });
  return jsonResponse(result, result && result.ok ? 200 : 500);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error("TELEGRAM_BOT_TOKEN is not set.");
      return new Response("Server misconfigured", { status: 500 });
    }
    try { await initSecrets(env); } catch (err) {
      console.error("Secret derivation failed:", err.message);
      return new Response("Server misconfigured: secrets", { status: 500 });
    }
    if (!getMasterKey(env)) {
      console.error("ENCRYPTION_KEY missing or invalid.");
      return new Response("Server misconfigured: encryption key", { status: 500 });
    }
    // ADMIN_IDS is a required one-click-deploy input; enforce at runtime so a
    // missing/typo'd value is loud (status page + logs) instead of silent.
    const adminIds = parseAdminIds(env.ADMIN_IDS);
    if (!adminIds.configured) console.error("ADMIN_IDS is not set to numeric Telegram user ID(s) — admin commands are disabled.");
    else if (adminIds.invalid.length) console.error("ADMIN_IDS has non-numeric entries (ignored): " + adminIds.invalid.join(", "));
    // Webhook endpoint
    if (request.method === "POST" && url.pathname === "/webhook") return await handleWebhook(request, env, ctx);
    
    // Setup endpoint (admin only)
    if (request.method === "GET" && url.pathname === "/setup") return await handleSetup(request, env);
    
    // Mini App API endpoints
    if (url.pathname.startsWith("/api/")) {
      return await routeMiniAppAPI(env, ctx, request, url.pathname);
    }
    
    // Mini App static files
    const staticFile = serveStatic(url.pathname);
    if (staticFile) {
      const content = getStaticAsset(staticFile.file);
      if (content) {
        return new Response(content, {
          status: 200,
          headers: { 
            "Content-Type": getContentType(staticFile.file),
            "Cache-Control": "public, max-age=3600"
          }
        });
      }
    }
    
    // Status endpoint (fallback for root)
    if (request.method === "GET" && url.pathname === "/") {
      return await handleStatus(request, env, adminIds);
    }
    
    return new Response("Not Found", { status: 404 });
  },
  // Cron: self-healing — schema probe (KV-gated) plus webhook re-verification
  // of the learned URL (no-op until GET / has learned the origin). Runs every
  // 5 minutes via [triggers] in wrangler.toml.
  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    try { await initSecrets(env); } catch (err) {
      console.error("Secret derivation failed:", err.message);
      return;
    }
    await maybeInitSchema(env);
    const res = await ensureWebhook(env, null);
    if (!res.ok && res.status !== "awaiting_first_request") {
      console.error("Webhook re-check failed [" + res.status + "]:" + (res.detail ? " " + res.detail : ""));
    }
  },
  // Queue consumer: runs the full AI pipeline outside the webhook request lifecycle.
  // Consumer invocations allow long wall time (vs. the 30s post-response waitUntil cap),
  // so streaming, fallbacks, consolidation and heartbeats are no longer cut off at 30s.
  async queue(batch, env, ctx) {
    if (env.TELEGRAM_BOT_TOKEN) {
      try { await initSecrets(env); } catch (err) { console.error("Secret derivation failed:", err.message); }
    }
    await ensureSchema(env);
    const queueName = batch.queue || "nyra-updates";
    // DLQ consumer: log permanently failed updates
    if (queueName === "nyra-updates-dlq") {
      for (let i = 0; i < batch.messages.length; i++) {
        const msg = batch.messages[i];
        try {
          await logFailedUpdate(env, msg);
          msg.ack();
        } catch (err) {
          console.error("DLQ logging failed:", err.message);
          msg.ack(); // Ack anyway to prevent infinite loop
        }
      }
      return;
    }
    // Main queue consumer
    for (let i = 0; i < batch.messages.length; i++) {
      const msg = batch.messages[i];
      const update = msg.body && msg.body.update;
      try {
        if (update && update.message) await processMessage(env, ctx, update.message);
        else if (update && update.callback_query) await handleCallbackQuery(env, ctx, update.callback_query);
        msg.ack();
      } catch (err) {
        console.error("Queued update processing failed:", err.message);
        try { msg.retry(); } catch (e) { console.error("queue retry failed:", e.message); }
      }
    }
  }
};
