import type { NyraEnv } from "../../types/env.js";
import { ADMIN_NOTIFY_THROTTLE_TTL, AI_PRIMARY_ATTEMPT_TIMEOUT_MS } from "../config.js";
import { truncate, escapeHtml, getAdminIds } from "../utils.js";
import { sendMessage } from "../telegram.js";
import { normalizeError, humanizeError } from "./errors.js";
import { generateOpenAICompatible } from "./openai.js";
import { getCentralAIConfig } from "./config.js";
import { executeAgentTool, configuredToolDefinitions, isWebSearchConfigured } from "../tools.js";

/** All requests use the same operator-owned OpenAI-compatible endpoint and key. */
export async function generateWithConnection(env: NyraEnv, _legacyConnection, messages, options, timeoutMs) {
  const config = getCentralAIConfig(env);
  return await generateOpenAICompatible(config, config.api_key, messages, options, timeoutMs || AI_PRIMARY_ATTEMPT_TIMEOUT_MS);
}

/** Execute tool calls against the same configured model and endpoint. */
export async function generateAgentWithConnection(env: NyraEnv, user, _legacyConnection, messages, options) {
  const config = getCentralAIConfig(env);
  const reasoningModel = /(^|[-/])(o[1-9]|gpt-5)/i.test(config.model);
  const definitions = reasoningModel ? [] : configuredToolDefinitions("openai-compatible", env);
  const conversation = messages.map(message => ({ ...message }));
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

  const latestUserMessage = [...messages].reverse().find(message => message.role === "user");
  const memoryIntentAllowed = !!(latestUserMessage && typeof latestUserMessage.content === "string" &&
    /\b(?:remember|forget|save\s+(?:this|that)\s+to\s+memory|delete\s+from\s+memory)\b|یادت|به\s+خاطر\s+بسپار|فراموش|از\s+حافظه\s+پاک/iu.test(latestUserMessage.content));
  const deadline = Date.now() + Math.max(1000, Math.min((options && options.totalBudgetMs) || 70000, 120000));
  let usage = { in: 0, out: 0, source: "unavailable" };

  for (let iteration = 0; iteration <= 4; iteration++) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) throw new Error("AI request timed out");
    let result;
    try {
      result = await generateOpenAICompatible(
        config,
        config.api_key,
        conversation,
        { ...options, tools: definitions },
        Math.min(remaining, 30000)
      );
    } catch (error) {
      // Some OpenAI-compatible endpoints do not implement function calling.
      // Retry once against the SAME endpoint/model, without tools.
      if (iteration === 0 && definitions.length > 0 && error && error.status === 400) {
        const plain = conversation.map(message => ({ ...message }));
        if (plain[0]) {
          plain[0] = { ...plain[0], content: String(plain[0].content) + "\n\nTools are unsupported by this endpoint for this request. Do not claim to browse or modify memory." };
        }
        const fallback = await generateOpenAICompatible(config, config.api_key, plain, options, Math.min(remaining, 30000));
        return { text: fallback.text || "", usage: fallback.usage || usage };
      }
      throw error;
    }

    usage = result.usage || usage;
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    if (calls.length === 0) return { text: result.text || "", usage };

    const callIds = new Set();
    for (const call of calls) {
      if (!call || typeof call.id !== "string" || !call.id || call.id.length > 100 ||
          !call.function || typeof call.function.name !== "string") {
        throw new Error("Malformed provider tool call");
      }
      if (callIds.has(call.id)) throw new Error("Duplicate provider tool-call ID");
      callIds.add(call.id);
    }
    if (iteration === 4) throw new Error("Tool-call iteration limit reached");

    conversation.push({ role: "assistant", content: result.text || null, tool_calls: calls });
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const name = call.function.name;
      const args = call.function.arguments;
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
          args,
          { chatId: user && user._toolChatId, messageId: user && user._toolMessageId }
        );
      } catch (error) {
        toolResult = JSON.stringify({ error: String(error && (error.message || error) || "Tool failed").slice(0, 240) });
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: toolResult });
    }
  }
  throw new Error("Agent execution ended without a final answer");
}

/**
 * One configured endpoint, one model, one API key. There is deliberately no
 * connection discovery, route traversal, provider switching, or model fallback.
 */
export async function* tryAgentWithFallback(env: NyraEnv, user, messages, options) {
  let safeConnection: any = {
    connection_id: "central",
    label: "Central AI",
    provider: "openai-compatible",
    model: typeof env.AI_MODEL === "string" ? env.AI_MODEL : "unconfigured"
  };
  try {
    const config = getCentralAIConfig(env);
    safeConnection = {
      connection_id: config.connection_id,
      label: config.label,
      provider: config.provider,
      model: config.model
    };
    const result = await generateAgentWithConnection(env, user, config, messages, options);
    if (result.text) yield { type: "text", text: result.text };
    yield { type: "done", connection: safeConnection, usage: result.usage, attempts: 1, fallbackUsed: false };
  } catch (error) {
    yield {
      type: "error",
      category: normalizeError(error, error && error.status),
      error,
      connection: safeConnection,
      attempts: 1,
      fallbackUsed: false,
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
    if (opts.raw_error) lines.push("<b>Last error:</b> <code>" + escapeHtml(truncate(redactCentralSecret(env, opts.raw_error), 300)) + "</code>");
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
