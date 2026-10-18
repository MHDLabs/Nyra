// Fallback orchestration. `tryStreamWithFallback` is the only streaming entry
// point the rest of the app uses: it resolves the user's route (or, failing
// that, their ordered connections), walks the plan, and reports terminal
// failure as a `{ type: "error" }` event rather than throwing, so a partial
// answer already delivered to the user is never lost.
import { AI_PRIMARY_ATTEMPT_TIMEOUT_MS, AI_MAX_PRIMARY_ATTEMPTS, AI_RETRY_DELAYS_MS, AI_STREAM_STALL_TIMEOUT_MS, AI_STREAM_TOTAL_BUDGET_MS, UNHEALTHY_FAILURE_THRESHOLD, ADMIN_NOTIFY_THROTTLE_TTL } from "../config.js";
import { truncate, escapeHtml, sleep, getAdminIds } from "../utils.js";
import { decryptCredential } from "../crypto.js";
import { sendMessage } from "../telegram.js";
import { getEnabledUserConnections, recordConnectionFailure, recordConnectionSuccess, resolveUserActiveRoute, buildRoutePlan, recordRouteTokenFailure, recordRouteTokenSuccess } from "../db.js";
import { decideNextAction, brainInputFromError } from "../brain.js";
import { normalizeError, isRetryableCategory } from "./errors.js";
import { generateOpenAICompatible } from "./openai.js";
import { generateAnthropic } from "./anthropic.js";
import { streamProviderResponse } from "./stream.js";

export async function generateWithConnection(env, connection, messages, options, timeoutMs) {
  const ownerId = connection.telegram_id !== undefined && connection.telegram_id !== null ? connection.telegram_id : 0;
  const apiKey = await decryptCredential(env, ownerId, connection.encrypted_key, connection.key_iv);
  const timeout = timeoutMs || AI_PRIMARY_ATTEMPT_TIMEOUT_MS;
  if (connection.provider === "anthropic") return await generateAnthropic(connection, apiKey, messages, options, timeout);
  return await generateOpenAICompatible(connection, apiKey, messages, options, timeout);
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
      const verdict = await decideNextAction(env, brainInputFromError(lastError, lastCategory, { attempt: totalAttempts, tokensRemaining: totalResources - 1 - i, modelsRemaining: totalResources - 1 - i }));
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
      const verdict = await decideNextAction(env, brainInputFromError(lastError, lastCategory, { attempt: attempt + 1, tokensRemaining: attemptTokensLeft, modelsRemaining: attemptModelsLeft }));
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
