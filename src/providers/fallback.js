// Fallback orchestration. `tryStreamWithFallback` is the only streaming entry
// point the rest of the app uses: it resolves the user's route (or, failing
// that, their ordered connections), walks the plan, and reports terminal
// failure as a `{ type: "error" }` event rather than throwing, so a partial
// answer already delivered to the user is never lost.
import { AI_PRIMARY_ATTEMPT_TIMEOUT_MS, AI_MAX_PRIMARY_ATTEMPTS, AI_RETRY_DELAYS_MS, AI_STREAM_STALL_TIMEOUT_MS, AI_STREAM_TOTAL_BUDGET_MS, UNHEALTHY_FAILURE_THRESHOLD, ADMIN_NOTIFY_THROTTLE_TTL } from "../config.js";
import { truncate, escapeHtml, sleep, getAdminIds } from "../utils.js";
import { decryptCredential } from "../crypto.js";
import { sendMessage } from "../telegram.js";
import { getEnabledUserConnections, recordConnectionFailure, recordConnectionSuccess, resolveUserActiveRoute, buildRoutePlan, recordRouteTokenFailure, recordRouteTokenSuccess, canUseWorkersAI, getWorkersAIModel } from "../db.js";
import { decideNextAction, brainInputFromError } from "../brain.js";
import { normalizeError, humanizeError, isRetryableCategory } from "./errors.js";
import { generateOpenAICompatible } from "./openai.js";
import { generateAnthropic } from "./anthropic.js";
import { streamProviderResponse } from "./stream.js";
import { executeAgentTool, configuredToolDefinitions, isWebSearchConfigured } from "../tools.js";

export async function generateWithConnection(env, connection, messages, options, timeoutMs) {
  const ownerId = connection.telegram_id !== undefined && connection.telegram_id !== null ? connection.telegram_id : 0;
  const apiKey = await decryptCredential(env, ownerId, connection.encrypted_key, connection.key_iv);
  const timeout = timeoutMs || AI_PRIMARY_ATTEMPT_TIMEOUT_MS;
  if (connection.provider === "anthropic") return await generateAnthropic(connection, apiKey, messages, options, timeout);
  return await generateOpenAICompatible(connection, apiKey, messages, options, timeout);
}

/** Execute native tool requests and continue the same provider conversation. */
export async function generateAgentWithConnection(env, user, connection, messages, options) {
  const provider = connection.provider === "anthropic" ? "anthropic" : "openai-compatible";
  if (provider === "openai-compatible" && /(^|[-/])(o[1-9]|gpt-5)/i.test(connection.model || "")) {
    const unsupported = messages.map(message => ({ ...message }));
    unsupported[0] = { ...unsupported[0], content: String(unsupported[0].content) + "\n\nThis reasoning model is not sent native tools on this request. Do not claim to browse, fetch pages, or modify memory; explain the limitation briefly when relevant." };
    return await generateWithConnection(env, connection, unsupported, options, Math.min((options && options.totalBudgetMs) || 30000, 30000));
  }
  const definitions = configuredToolDefinitions(provider, env);
  const conversation = messages.map(message => ({ ...message }));
  // When live search is unavailable the model must be told so explicitly. Left
  // to itself it will happily answer "let me search…" and then produce a reply
  // that never mentions the failure, which reads as a silent hang.
  const searchUnavailable = !isWebSearchConfigured(env);
  if (searchUnavailable && conversation[0]) {
    conversation[0] = { ...conversation[0], content: String(conversation[0].content) +
      "\n\nLive web search is NOT available in this deployment. If the user asks you to search, look something up, or find current information, say plainly that live search is not configured and answer from your own knowledge if you can. Never say you are searching, and never output a placeholder like \"one moment\"." };
  }
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user");
  const memoryIntentAllowed = !!(latestUserMessage && typeof latestUserMessage.content === "string" &&
    /\b(?:remember|forget|save\s+(?:this|that)\s+to\s+memory|delete\s+from\s+memory)\b|یادت|به\s+خاطر\s+بسپار|فراموش|از\s+حافظه\s+پاک/iu.test(latestUserMessage.content));
  const maxIterations = 4;
  const deadline = Date.now() + ((options && options.totalBudgetMs) || 70000);
  let usage = { in: 0, out: 0, source: "unavailable" };
  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) throw new Error("Agent execution timed out");
    let result;
    try {
      result = await generateWithConnection(env, connection, conversation,
        { ...options, tools: definitions }, Math.min(remaining, 30000));
    } catch (err) {
      // Some OpenAI-compatible models reject the tool parameter. Retry once
      // without tools rather than implying that an unsupported model acted.
      if (iteration === 0 && err.status === 400) {
        const fallback = conversation.map(m => ({ ...m }));
        fallback[0] = { ...fallback[0], content: String(fallback[0].content) + "\n\nNative tools are unavailable for this model. Do not claim to browse, fetch pages, or modify memory." };
        return await generateWithConnection(env, connection, fallback, options, Math.min(remaining, 30000));
      }
      throw err;
    }
    usage = result.usage || usage;
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    if (!calls.length) return { text: result.text || "", usage };
    const callIds = new Set();
    for (const call of calls) {
      const valid = provider === "anthropic"
        ? call && typeof call.id === "string" && call.id.length > 0 && call.id.length <= 100 && typeof call.name === "string"
        : call && typeof call.id === "string" && call.id.length > 0 && call.id.length <= 100 && call.function && typeof call.function.name === "string";
      if (!valid) throw new Error("Malformed provider tool call");
      if (callIds.has(call.id)) throw new Error("Duplicate provider tool-call ID");
      callIds.add(call.id);
    }
    if (iteration === maxIterations) throw new Error("Tool-call iteration limit reached");

    if (provider === "anthropic") {
      conversation.push({ role: "assistant", content: result.assistantMessage });
      const toolResults = [];
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex];
        let content;
        try {
          if (callIndex >= 4) throw new Error("Tool-call batch limit is four");
          if (call.name === "remember_fact" || call.name === "forget_fact") {
            if (!memoryIntentAllowed) throw new Error("Memory changes require an explicit user request");
            if (user && user.is_group) throw new Error("Personal memory tools are unavailable in group chats");
          }
          content = await executeAgentTool(env, user.telegram_id, call.name, call.input);
        }
        catch (err) { content = JSON.stringify({ error: String(err.message || "Tool failed").slice(0, 240) }); }
        toolResults.push({ type: "tool_result", tool_use_id: call.id, content });
      }
      conversation.push({ role: "user", content: toolResults });
    } else {
      conversation.push({ role: "assistant", content: result.text || null, tool_calls: calls });
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex];
        const name = call && call.function && call.function.name;
        const args = call && call.function && call.function.arguments;
        let content;
        try {
          if (callIndex >= 4) throw new Error("Tool-call batch limit is four");
          if (name === "remember_fact" || name === "forget_fact") {
            if (!memoryIntentAllowed) throw new Error("Memory changes require an explicit user request");
            if (user && user.is_group) throw new Error("Personal memory tools are unavailable in group chats");
          }
          content = await executeAgentTool(env, user.telegram_id, name, args);
        }
        catch (err) { content = JSON.stringify({ error: String(err.message || "Tool failed").slice(0, 240) }); }
        conversation.push({ role: "tool", tool_call_id: String(call.id || "").slice(0, 100), content });
      }
    }
  }
  throw new Error("Agent execution ended without a final answer");
}

/** Tool-capable equivalent of the streaming fallback entry point. */
export async function* tryAgentWithFallback(env, user, messages, options) {
  const budget = (options && options.totalBudgetMs) || AI_STREAM_TOTAL_BUDGET_MS;
  const deadline = Date.now() + budget;
  const bundle = user ? await resolveUserActiveRoute(env, user) : null;
  let candidates = bundle ? buildRoutePlan(bundle) : await getEnabledUserConnections(env, user.telegram_id);
  if (!bundle && user && user.active_connection_id) {
    candidates = candidates.slice();
    const index = candidates.findIndex(c => c.connection_id === user.active_connection_id);
    if (index > 0) candidates.unshift(candidates.splice(index, 1)[0]);
  }
  const fallbackEnabled = !user || user.fallback_enabled !== 0;
  if (!fallbackEnabled && candidates.length > 1) candidates = candidates.slice(0, 1);
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const connection = candidates[i];
    if (Date.now() + 1000 >= deadline) break;
    try {
      const result = await generateAgentWithConnection(env, user, connection, messages,
        { ...options, totalBudgetMs: deadline - Date.now() });
      if (connection.is_route && connection.token_id) await recordRouteTokenSuccess(env, connection.token_id);
      else if (connection.connection_id) await recordConnectionSuccess(env, connection.connection_id);
      if (result.text) yield { type: "text", text: result.text };
      yield { type: "done", connection, usage: result.usage, attempts: i + 1, fallbackUsed: i > 0 };
      return;
    } catch (error) {
      lastError = error;
      const category = normalizeError(error, error.status);
      if (connection.is_route && connection.token_id) await recordRouteTokenFailure(env, connection.token_id);
      else if (connection.connection_id) await recordConnectionFailure(env, connection.connection_id);
      if (i + 1 < candidates.length) {
        const verdict = await decideNextAction(env, { ...brainInputFromError(error, category, { attempt: i + 1, tokensRemaining: candidates.length - i - 1, modelsRemaining: candidates.length - i - 1 }), userId: user && user.telegram_id });
        if (verdict.action === "stop") break;
      }
    }
  }
  if ((candidates.length === 0 || fallbackEnabled) && await canUseWorkersAI(env, user && user.telegram_id) && Date.now() + 1000 < deadline) {
    try {
      const model = await getWorkersAIModel(env);
      const promptMessages = messages.map(message => ({ role: message.role, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }));
      if (promptMessages.length) promptMessages[0].content += "\n\nThis Workers AI fallback has no native tool-calling capability for this request. Do not claim to have searched the web, fetched a page, or modified memory; state the limitation if relevant.";
      let timer;
      let response;
      try {
        response = await Promise.race([
          env.AI.run(model, { messages: promptMessages, max_tokens: (options && options.max_tokens) || 2048, temperature: options && options.temperature }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Workers AI request timed out")), Math.min(15000, deadline - Date.now())); })
        ]);
      } finally { if (timer) clearTimeout(timer); }
      const text = typeof response === "string" ? response : response && (response.response || (response.result && response.result.response));
      if (typeof text !== "string" || !text.trim()) throw new Error("Workers AI returned no text");
      yield { type: "text", text };
      yield { type: "done", connection: { connection_id: "workers-ai:" + model, label: "Workers AI", provider: "cloudflare", model }, usage: null, attempts: candidates.length + 1, fallbackUsed: true };
      return;
    } catch (error) { lastError = error; }
  }
  yield { type: "error", category: normalizeError(lastError, lastError && lastError.status), error: lastError, connection: candidates[0], attempts: candidates.length, fallbackUsed: false };
}

export async function* tryStreamWithFallback(env, user, messages, options) {
  const fallbackEnabled = !user || user.fallback_enabled !== 0;
  const budgetStart = Date.now();
  const totalBudgetMs = (options && options.totalBudgetMs) || AI_STREAM_TOTAL_BUDGET_MS;
  const stallTimeoutBase = (options && options.stallTimeoutMs) || AI_STREAM_STALL_TIMEOUT_MS;

  // Preferred path: a user route (ordered model × token fallback plan).
  const bundle = user ? await resolveUserActiveRoute(env, user) : null;
  if (bundle) {
    yield* streamViaRoute(env, user, bundle, messages, options, totalBudgetMs, stallTimeoutBase, budgetStart, fallbackEnabled);
    return;
  }

  const conns = await getEnabledUserConnections(env, user.telegram_id);
  if (conns.length === 0) {
    yield { type: "error", category: "no_connection", error: null, connection: null, attempts: 0, fallbackUsed: false, partial: false };
    return;
  }

  let primaryConn = null;
  if (user && user.active_connection_id) {
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].connection_id === user.active_connection_id) { primaryConn = conns[i]; break; }
    }
  }
  if (!primaryConn) {
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].is_global === 1 && conns[i].is_default === 1) { primaryConn = conns[i]; break; }
    }
  }
  const ordered = [];
  if (primaryConn) ordered.push(primaryConn);
  for (let i = 0; i < conns.length; i++) {
    if (ordered.indexOf(conns[i]) === -1) ordered.push(conns[i]);
  }

  let lastError = null;
  let lastCategory = "unknown";
  let lastConn = null;
  let totalAttempts = 0;
  const totalResources = ordered.length;

  for (let i = 0; i < ordered.length; i++) {
    const conn = ordered[i];
    const isPrimary = i === 0;
    if (!isPrimary) {
      if (!fallbackEnabled && !isRetryableCategory(lastCategory)) break;
      if ((conn.consecutive_failures || 0) >= UNHEALTHY_FAILURE_THRESHOLD) continue;
    }
    const budgetRemaining = totalBudgetMs - (Date.now() - budgetStart);
    if (budgetRemaining < 3000) break;

    const maxAttemptsForConn = isPrimary ? AI_MAX_PRIMARY_ATTEMPTS : 1;

    for (let attempt = 0; attempt < maxAttemptsForConn; attempt++) {
      const remaining = totalBudgetMs - (Date.now() - budgetStart);
      if (remaining < 3000) break;
      if (attempt > 0) {
        const delay = AI_RETRY_DELAYS_MS[attempt - 1] || 1000;
        await sleep(delay);
      }
      totalAttempts++;
      const stallTimeout = Math.min(stallTimeoutBase, totalBudgetMs - (Date.now() - budgetStart));
      let currentUsage = null;
      let attemptYielded = false;

      try {
        for await (const event of streamProviderResponse(env, conn, messages, options, stallTimeout)) {
          if (event.type === "text") {
            attemptYielded = true;
            yield { type: "text", text: event.text };
          } else if (event.type === "usage") {
            currentUsage = event.usage;
          }
        }
        await recordConnectionSuccess(env, conn.connection_id);
        yield { type: "done", connection: conn, usage: currentUsage, attempts: totalAttempts, fallbackUsed: !isPrimary };
        return;
      } catch (err) {
        lastError = err;
        lastCategory = normalizeError(err, err.status);
        lastConn = conn;
        await recordConnectionFailure(env, conn.connection_id);
      }

      if (attemptYielded) {
        yield { type: "error", category: lastCategory, error: lastError, connection: lastConn, attempts: totalAttempts, fallbackUsed: !isPrimary, partial: true };
        return;
      }
      // Non-retryable means do not repeat this same connection. It does not
      // mean stop the entire chain: the error brain below may rotate to a
      // different token/model/connection (for example, forbidden → next_token).
    }

    if (!isRetryableCategory(lastCategory) && !fallbackEnabled) break;
    // Consult the brain so a non-retryable failure still advances when sensible.
    if (i + 1 < ordered.length) {
      const verdict = await decideNextAction(env, { ...brainInputFromError(lastError, lastCategory, { attempt: totalAttempts, tokensRemaining: totalResources - 1 - i, modelsRemaining: totalResources - 1 - i }), userId: user && user.telegram_id });
      if (verdict.action === "stop") break;
    }
  }

  yield { type: "error", category: lastCategory, error: lastError, connection: lastConn || primaryConn, attempts: totalAttempts, fallbackUsed: false, partial: false };
}

/** Stream through a user route: ordered model × token plan, brain-guided. */
export async function* streamViaRoute(env, user, bundle, messages, options, totalBudgetMs, stallTimeoutBase, budgetStart, fallbackEnabled) {
  const plan = buildRoutePlan(bundle);
  if (plan.length === 0) {
    yield { type: "error", category: "no_connection", error: null, connection: null, attempts: 0, fallbackUsed: false, partial: false };
    return;
  }
  const modelIds = [];
  for (let i = 0; i < bundle.models.length; i++) if (modelIds.indexOf(bundle.models[i].model_id) === -1) modelIds.push(bundle.models[i].model_id);
  const tokenIds = [];
  for (let i = 0; i < bundle.tokens.length; i++) if (bundle.tokens[i].enabled === 1) tokenIds.push(bundle.tokens[i].token_id);

  let lastError = null;
  let lastCategory = "unknown";
  let lastConn = null;
  let totalAttempts = 0;

  for (let i = 0; i < plan.length; i++) {
    const conn = plan[i];
    const isPrimary = i === 0;
    if (!isPrimary && !fallbackEnabled && !isRetryableCategory(lastCategory)) break;
    if ((conn.consecutive_failures || 0) >= UNHEALTHY_FAILURE_THRESHOLD) continue;
    if (totalBudgetMs - (Date.now() - budgetStart) < 3000) break;

    const maxAttemptsForConn = isPrimary ? AI_MAX_PRIMARY_ATTEMPTS : 1;
    let advanceToModel = null;

    for (let attempt = 0; attempt < maxAttemptsForConn; attempt++) {
      if (totalBudgetMs - (Date.now() - budgetStart) < 3000) break;
      if (attempt > 0) await sleep(AI_RETRY_DELAYS_MS[attempt - 1] || 1000);
      totalAttempts++;
      const stallTimeout = Math.min(stallTimeoutBase, totalBudgetMs - (Date.now() - budgetStart));
      let currentUsage = null;
      let attemptYielded = false;

      try {
        for await (const event of streamProviderResponse(env, conn, messages, options, stallTimeout)) {
          if (event.type === "text") { attemptYielded = true; yield { type: "text", text: event.text }; }
          else if (event.type === "usage") { currentUsage = event.usage; }
        }
        await recordRouteTokenSuccess(env, conn.token_id);
        yield { type: "done", connection: conn, usage: currentUsage, attempts: totalAttempts, fallbackUsed: !isPrimary };
        return;
      } catch (err) {
        lastError = err;
        lastCategory = normalizeError(err, err.status);
        lastConn = conn;
        await recordRouteTokenFailure(env, conn.token_id);
      }

      if (attemptYielded) {
        yield { type: "error", category: lastCategory, error: lastError, connection: lastConn, attempts: totalAttempts, fallbackUsed: !isPrimary, partial: true };
        return;
      }

      const attemptTokensLeft = tokenIds.length - tokenIds.indexOf(conn.token_id) - 1;
      const attemptModelsLeft = modelIds.length - modelIds.indexOf(conn.model_id) - 1;
      const verdict = await decideNextAction(env, { ...brainInputFromError(lastError, lastCategory, { attempt: attempt + 1, tokensRemaining: attemptTokensLeft, modelsRemaining: attemptModelsLeft }), userId: user && user.telegram_id });
      if (verdict.action === "stop") {
        yield { type: "error", category: lastCategory, error: lastError, connection: lastConn, attempts: totalAttempts, fallbackUsed: !isPrimary, partial: false };
        return;
      }
      if (verdict.action === "retry_same" && attempt + 1 < maxAttemptsForConn) continue;
      if (verdict.action === "next_model" && attemptModelsLeft > 0) {
        advanceToModel = modelIds[modelIds.indexOf(conn.model_id) + 1];
      }
      break;
    }

    // After the per-conn attempts, jump to the next model block if instructed.
    if (advanceToModel) {
      while (i + 1 < plan.length && plan[i + 1].model_id !== advanceToModel) i++;
    }
  }

  yield { type: "error", category: lastCategory, error: lastError, connection: lastConn, attempts: totalAttempts, fallbackUsed: false, partial: false };
}

export async function notifyAdminOnError(env, opts) {
  try {
    const admins = getAdminIds(env);
    if (admins.length === 0) return;
    const connectionId = opts.connection_id || "none";
    const category = opts.category || "unknown";
    const throttleKey = "anotify:" + category + ":" + connectionId;
    try {
      const existing = await env.KV.get(throttleKey);
      if (existing === "1") return;
      await env.KV.put(throttleKey, "1", { expirationTtl: ADMIN_NOTIFY_THROTTLE_TTL });
    } catch (err) {}
    const lines = [];
    lines.push("🚨 <b>Nyra Error Alert</b>");
    lines.push("");
    if (opts.connection_label) lines.push("<b>Connection:</b> " + escapeHtml(opts.connection_label));
    if (opts.provider) lines.push("<b>Provider:</b> " + escapeHtml(opts.provider));
    if (opts.model) lines.push("<b>Model:</b> <code>" + escapeHtml(opts.model) + "</code>");
    lines.push("<b>Category:</b> <code>" + escapeHtml(category) + "</code>");
    lines.push("<b>Message:</b> " + escapeHtml(humanizeError(category)));
    lines.push("<b>Attempts:</b> " + (opts.attempts || 0));
    if (opts.raw_error) lines.push("<b>Last error:</b> <code>" + escapeHtml(truncate(String(opts.raw_error), 300)) + "</code>");
    if (opts.user_id) lines.push("<b>User:</b> <code>" + opts.user_id + "</code>");
    if (opts.chat_id) lines.push("<b>Chat:</b> <code>" + opts.chat_id + "</code>");
    if (opts.fallback_used) lines.push("<b>Fallback:</b> used");
    lines.push("<b>Time:</b> " + new Date().toISOString());
    const text = lines.join("\n");
    for (let i = 0; i < admins.length; i++) {
      await sendMessage(env, admins[i], text, { parse_mode: "HTML" });
    }
  } catch (err) { console.error("notifyAdminOnError failed:", err.message); }
}
