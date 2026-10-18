// The AI turn: rate limits, context assembly, the streaming reply loop with
// throttled edit-in-place, reaction handling, memory consolidation and error
// surfacing. This is the single most performance-sensitive path in the bot —
// it runs inside the queue consumer, never inside the webhook request.
import { MAX_TELEGRAM_LENGTH, MEMORY_UPDATE_INTERVAL, RATE_LIMIT_USER_PER_MIN, RATE_LIMIT_USER_PER_HOUR, RATE_LIMIT_CHAT_PER_HOUR, UNHEALTHY_FAILURE_THRESHOLD, UNHEALTHY_WARN_TTL, STREAM_EDIT_THROTTLE_MS, STREAM_PLACEHOLDER, FAST_STREAM_BUDGET_MS, FAST_STALL_TIMEOUT_MS } from "../config.js";
import { now, escapeHtml, buildUserContent, checkRateLimit } from "../utils.js";
import { sendMessageReturn, sendMessage, sendMessageSafeResult, editMessage, deleteMessage, startTypingHeartbeat, pickImageFile, downloadTelegramFile } from "../telegram.js";
import { getUser, upsertUser, getChat, saveThreadMessage, getThreadContext, updateUsageStatsAsync, resolveUserActiveConnection, trackConnectionUsage } from "../db.js";
import { normalizeError, humanizeError, shouldNotifyAdmin, tryStreamWithFallback, notifyAdminOnError } from "../ai.js";
import { buildContextMessages, getUserPersonality, consolidateMemory, consolidateChatSummary, incrementMessageCount } from "../memory.js";
import { showNoConnectionMessage } from "../menus.js";
import { safeFormatChunks, plainText, plainTextChunks } from "../formatter.js";

export async function handleAIMessage(env, ctx, message, from, chat, isGroup, threadId) {
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

  // Mark the resolved object as group/private so the prompt builder and the
  // memory consolidator know whether to attribute messages to specific speakers.
  user.is_group = isGroup;

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

  // Vision path: when the active connection is marked as image-capable and the
  // user actually sent one, download the image and hand it to the model as a
  // content part. Failure or lack of support falls back to the text placeholder
  // produced by buildUserContent ("[user sent a photo]").
  let currentTurn = userContent;
  if (connection.supports_vision === 1) {
    const image = pickImageFile(message);
    if (image) {
      const file = await downloadTelegramFile(env, image.fileId);
      if (file) currentTurn = { text: userContent, images: [{ mediaType: file.mediaType || image.mediaType, data: file.data }] };
    }
  }

  const messages = buildContextMessages(personality, user, chatRow, recentContext, currentTurn, mode);
  const streamOptions = { max_tokens: 2048, temperature: 0.7 };
  // Fast models stream with a tighter budget so the whole answer fits inside the
  // 30s ctx.waitUntil window when the webhook path runs them inline.
  if (connection.is_fast === 1) {
    streamOptions.totalBudgetMs = FAST_STREAM_BUDGET_MS;
    streamOptions.stallTimeoutMs = FAST_STALL_TIMEOUT_MS;
  }
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
          // The preview is sent as plain text with no parse_mode, so it must be
          // Markdown-stripped or the raw `**`/backticks show up while streaming.
          let preview = plainText(accumulated);
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
      const note = "\n\n⚠ Response interrupted.";
      let preview = plainText(accumulated);
      if (preview.length + note.length > MAX_TELEGRAM_LENGTH) {
        preview = preview.slice(0, MAX_TELEGRAM_LENGTH - note.length - 10) + "…";
      }
      const finalText = preview + note;
      await editMessage(env, chatId, placeholderMsgId, finalText, undefined, undefined);
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
  const chunks = safeFormatChunks(replyText, "MarkdownV2");

  let finalMsgId = placeholderMsgId;
  if (chunks.length > 1) {
    // A long answer becomes several messages. The first one replaces the
    // placeholder so the reply appears in place; the rest follow. Nothing is
    // truncated and no part exceeds the Telegram limit — safeFormatChunks
    // guarantees the length, and sendMessageReturn is the transport backstop.
    const first = chunks[0];
    const firstEdit = await editMessage(env, chatId, placeholderMsgId, first.text, undefined, first.parseMode);
    if (!firstEdit || !firstEdit.ok) {
      // The placeholder could not become the first part, so delete it and send
      // that part separately — otherwise the opening of the answer is lost.
      await deleteMessage(env, chatId, placeholderMsgId);
      const opts = {};
      if (first.parseMode) opts.parse_mode = first.parseMode;
      if (replyToId) opts.reply_to_message_id = replyToId;
      const sentFirst = await sendMessageReturn(env, chatId, first.text, opts);
      if (sentFirst && sentFirst.ok && sentFirst.result && typeof sentFirst.result.message_id === "number") {
        finalMsgId = sentFirst.result.message_id;
      }
    }
    for (let i = 1; i < chunks.length; i++) {
      const opts = {};
      if (chunks[i].parseMode) opts.parse_mode = chunks[i].parseMode;
      await sendMessageReturn(env, chatId, chunks[i].text, opts);
    }
    await saveThreadMessage(env, chatId, threadId, finalMsgId, null, "assistant", replyText);
  } else {
    const part = chunks[0];
    const finalEdit = await editMessage(env, chatId, placeholderMsgId, part.text, undefined, part.parseMode);
    if (!finalEdit || !finalEdit.ok) {
      const desc = String(finalEdit ? finalEdit.description : "").toLowerCase();
      if (desc.indexOf("not modified") === -1) {
        await deleteMessage(env, chatId, placeholderMsgId);
        // Fall back to plain, unformatted text: a refused entity must not cost
        // the user the reply.
        const plain = plainTextChunks(replyText);
        for (let i = 0; i < plain.length; i++) {
          const opts = {};
          if (i === 0 && replyToId) opts.reply_to_message_id = replyToId;
          const sentNew = await sendMessageReturn(env, chatId, plain[i].text, opts);
          if (i === 0 && sentNew && sentNew.ok && sentNew.result && typeof sentNew.result.message_id === "number") {
            finalMsgId = sentNew.result.message_id;
          }
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
        if (updatedUser) updatedUser.is_group = isGroup;
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
