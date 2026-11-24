import type { NyraEnv } from "../../types/env.js";
import { ADMIN_NOTIFY_THROTTLE_TTL, AI_REQUEST_TIMEOUT_MS, AI_STREAM_STALL_TIMEOUT_MS } from "../config.js";
import { truncate, escapeHtml, getAdminIds } from "../utils.js";
import { sendMessage } from "../telegram.js";
import { normalizeError, humanizeError } from "./errors.js";
import { generateOpenAICompatible, streamOpenAICompatible } from "./openai.js";
import { streamCloudflareAI } from "./cloudflare.js";
import { getCentralAIConfig } from "./config.js";
import { getAIConfigForUser, redactConfiguredModelKeys } from "./registry.js";
import { executeAgentTool, configuredToolDefinitions, isWebSearchConfigured } from "../tools.js";

/** All requests use the same operator-owned OpenAI-compatible endpoint and key. */
export async function generateCentralAI(env: NyraEnv, messages, options, timeoutMs) {
  const config = getCentralAIConfig(env);
  return await generateOpenAICompatible(
    config,
    config.api_key,
    messages,
    options,
    timeoutMs || AI_REQUEST_TIMEOUT_MS
  );
}

function isExplicitMemoryIntent(messages) {
  const latest = [...messages].reverse().find(message => message.role === "user");
  return !!(latest && typeof latest.content === "string" &&
    /\b(?:remember|forget|save\s+(?:this|that)\s+to\s+memory|delete\s+from\s+memory)\b|یادت|به\s+خاطر\s+بسپار|فراموش|از\s+حافظه\s+پاک/iu.test(latest.content));
}

async function* streamCentralAgent(env: NyraEnv, user, messages, options) {
  const resolved = user && user._aiConfig
    ? { config: user._aiConfig, fallbackConfig: user._fallbackAIConfig || null }
    : await getAIConfigForUser(env, user && user.telegram_id, user && user._forceModelId);
  let config = resolved.config;
  const fallbackConfig = resolved.fallbackConfig;
  let fallbackAttempted = false;
  const reasoningModel = /(^|[-/])(o[1-9]|gpt-5)/i.test(config.model);
  const definitions = reasoningModel ? [] : configuredToolDefinitions("openai-compatible", env, {
    allowReact: !!(user && user.is_group)
  });
  const conversation = messages.map(message => ({ ...message }));
  const memoryIntentAllowed = isExplicitMemoryIntent(messages);
  const deadline = Date.now() + Math.max(1000, Math.min((options && options.totalBudgetMs) || 70000, 120000));
  let usage = { in: 0, out: 0, source: "unavailable" };
  let toolsDisabled = definitions.length === 0;
  let requestAttempts = 0;

  if (reasoningModel && conversation[0]) {
    conversation[0] = {
      ...conversation[0],
      content: String(conversation[0].content) + "\n\nNative tools are not enabled for this reasoning model. Do not claim to browse, fetch pages, or modify memory."
    };
  }
  if (!isWebSearchConfigured(env) && conversation[0]) {
    conversation[0] = {
      ...conversation[0],
      content: String(conversation[0].content) + "\n\nLive web search is not configured. Never claim to be searching or to have fetched current information."
    };
  }

  for (let iteration = 0; iteration <= 4; iteration++) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) throw new Error("AI request timed out");

    const controller = new AbortController();
    const stallTimeout = Math.max(1000, Math.min(
      (options && options.stallTimeoutMs) || AI_STREAM_STALL_TIMEOUT_MS,
      remaining
    ));
    let stallTimer: any = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), stallTimeout);
    };
    armStallTimer();

    let roundText = "";
    let calls: any[] = [];
    let streamFailed: any = null;
    try {
      const streamOptions = {
        ...options,
        tools: toolsDisabled ? [] : definitions
      };
      requestAttempts++;
      const stream = config.provider === "cloudflare"
        ? streamCloudflareAI(env, config, conversation, streamOptions, controller.signal)
        : streamOpenAICompatible(config, config.api_key, conversation, streamOptions, controller.signal);
      for await (const event of stream) {
        armStallTimer();
        if (event.type === "text" && typeof event.text === "string") {
          roundText += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "tool_calls" && Array.isArray(event.toolCalls)) {
          calls = event.toolCalls;
        } else if (event.type === "usage" && event.usage) {
          usage = event.usage;
          yield { type: "usage", usage };
        }
      }
    } catch (error) {
      streamFailed = error;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }

    if (streamFailed && Number(streamFailed.status) === 429 && config.id === "groq_qwen38"
      && fallbackConfig && !fallbackAttempted && !(user && user._forceModelId)
      && roundText.length === 0 && calls.length === 0) {
      config = fallbackConfig;
      fallbackAttempted = true;
      yield { type: "fallback", from: "Groq · Qwen 3.8 27B", to: config.label };
      const fallbackController = new AbortController();
      const fallbackStallLimit = Math.max(1000, (options && options.stallTimeoutMs) || AI_STREAM_STALL_TIMEOUT_MS);
      let fallbackTimer: any = null;
      const armFallbackTimer = () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        const budgetLeft = deadline - Date.now();
        if (budgetLeft <= 0) { fallbackController.abort(); return; }
        fallbackTimer = setTimeout(() => fallbackController.abort(), Math.max(1, Math.min(fallbackStallLimit, budgetLeft)));
      };
      armFallbackTimer();
      streamFailed = null;
      try {
        requestAttempts++;
        const fallbackStream = config.provider === "cloudflare"
          ? streamCloudflareAI(env, config, conversation, {
            ...options, tools: toolsDisabled ? [] : definitions
          }, fallbackController.signal)
          : streamOpenAICompatible(config, config.api_key, conversation, {
            ...options, tools: toolsDisabled ? [] : definitions
          }, fallbackController.signal);
        for await (const event of fallbackStream) {
          armFallbackTimer();
          if (event.type === "text" && typeof event.text === "string") {
            roundText += event.text;
            yield { type: "text", text: event.text };
          } else if (event.type === "tool_calls" && Array.isArray(event.toolCalls)) {
            calls = event.toolCalls;
          } else if (event.type === "usage" && event.usage) {
            usage = event.usage;
            yield { type: "usage", usage };
          }
        }
      } catch (fallbackError) {
        streamFailed = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        (streamFailed as any).fallbackAttempted = true;
        (streamFailed as any).originalRateLimit = true;
      } finally { if (fallbackTimer) clearTimeout(fallbackTimer); }
    }

    if (streamFailed) {
      // Some OpenAI-compatible servers reject tools. Retry once against the
      // exact same endpoint and model, with tools disabled for this request.
      if (iteration === 0 && !toolsDisabled && streamFailed.status === 400 && roundText.length === 0 && calls.length === 0) {
        toolsDisabled = true;
        if (conversation[0]) {
          conversation[0] = {
            ...conversation[0],
            content: String(conversation[0].content) + "\n\nThis endpoint does not support tools for this request. Do not claim to browse, fetch pages, or modify memory."
          };
        }
        continue;
      }
      const failure = streamFailed instanceof Error ? streamFailed : new Error(String(streamFailed));
      (failure as any).requestAttempts = requestAttempts;
      if (fallbackAttempted || (failure as any).fallbackAttempted) {
        (failure as any).fallbackAttempted = true;
        (failure as any).originalRateLimit = true;
      }
      throw failure;
    }

    if (!calls.length) {
      yield { type: "done", usage, attempts: requestAttempts };
      return;
    }

    const callIds = new Set<string>();
    for (const call of calls) {
      if (!call || typeof call.id !== "string" || !call.id || call.id.length > 100 ||
          !call.function || typeof call.function.name !== "string" || !call.function.name) {
        throw new Error("Malformed provider tool call");
      }
      if (callIds.has(call.id)) throw new Error("Duplicate provider tool-call ID");
      callIds.add(call.id);
    }
    if (iteration === 4) throw new Error("Tool-call iteration limit reached");

    conversation.push({ role: "assistant", content: roundText || null, tool_calls: calls });
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const name = call.function.name;
      let toolResult;
      try {
        if (index >= 4) throw new Error("Tool-call batch limit is four");
        if (name === "remember_fact" || name === "forget_fact") {
          if (!memoryIntentAllowed) throw new Error("Memory changes require an explicit user request");
          if (user && user.is_group) throw new Error("Personal memory tools are unavailable in group chats");
        }
        toolResult = await executeAgentTool(
          env,
          user && user.telegram_id,
          name,
          call.function.arguments,
          { chatId: user && user._toolChatId, messageId: user && user._toolMessageId }
        );
      } catch (error) {
        toolResult = JSON.stringify({
          error: String(error && (error.message || error) || "Tool failed").slice(0, 240)
        });
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: toolResult });
    }
  }

  throw new Error("Agent execution ended without a final answer");
}

/** Buffered compatibility helper for non-Telegram callers and unit tests. */
export async function generateCentralAgent(env: NyraEnv, user, messages, options) {
  let text = "";
  let usage = { in: 0, out: 0, source: "unavailable" };
  for await (const event of streamCentralAgent(env, user, messages, options)) {
    if (event.type === "text" && typeof (event as any).text === "string") text += (event as any).text;
    else if (event.type === "usage") usage = (event as any).usage || usage;
  }
  return { text, usage };
}

/** Stream the single centrally configured model. No provider/model failover exists. */
export async function* streamCentralAI(env: NyraEnv, user, messages, options) {
  try {
    for await (const event of streamCentralAgent(env, user, messages, options)) {
      yield event;
    }
  } catch (error) {
    yield {
      type: "error",
      category: normalizeError(error, error && error.status),
      error,
      attempts: Number.isInteger(error && error.requestAttempts) ? error.requestAttempts : 1,
      fallbackAttempted: error && error.fallbackAttempted === true,
      originalRateLimit: error && error.originalRateLimit === true,
      partial: false
    };
  }
}

function redactCentralSecret(env: NyraEnv, value: unknown) {
  let text = String(value || "");
  const secret = typeof env.AI_API_KEY === "string" ? env.AI_API_KEY : "";
  if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
}

export async function notifyAdminOnError(env: NyraEnv, opts) {
  try {
    const admins = getAdminIds(env);
    if (admins.length === 0) return;
    const category = opts.category || "unknown";
    const throttleKey = "anotify:" + category + ":central";
    try {
      if (await env.KV.get(throttleKey) === "1") return;
      await env.KV.put(throttleKey, "1", { expirationTtl: ADMIN_NOTIFY_THROTTLE_TTL });
    } catch (err) {}
    const model = typeof env.AI_MODEL === "string" ? env.AI_MODEL : "not configured";
    const lines = [
      "🚨 <b>Nyra Error Alert</b>",
      "",
      "<b>Model:</b> <code>" + escapeHtml(model) + "</code>",
      "<b>Category:</b> <code>" + escapeHtml(category) + "</code>",
      "<b>Message:</b> " + escapeHtml(humanizeError(category)),
      "<b>Attempts:</b> " + (opts.attempts || 1)
    ];
    if (opts.raw_error) {
      const raw = await redactConfiguredModelKeys(env, redactCentralSecret(env, opts.raw_error));
      lines.push("<b>Last error:</b> <code>" + escapeHtml(truncate(raw, 300)) + "</code>");
    }
    if (opts.user_id) lines.push("<b>User:</b> <code>" + opts.user_id + "</code>");
    if (opts.chat_id) lines.push("<b>Chat:</b> <code>" + opts.chat_id + "</code>");
    lines.push("<b>Time:</b> " + new Date().toISOString());
    const message = lines.join("\n");
    for (const adminId of admins) {
      await sendMessage(env, adminId, message, { parse_mode: "HTML" });
    }
  } catch (error) {
    console.error("notifyAdminOnError failed:", redactCentralSecret(env, error && (error.message || error)));
  }
}
