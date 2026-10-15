// Nyra — Workers AI error brain: classify a provider failure and choose the
// recovery action (retry same endpoint, rotate to the next token, switch to the
// next model, or stop). A deterministic heuristic covers the common cases; the
// free Workers AI model is consulted only for ambiguous/unclassified errors and
// its verdict is cached by error signature so the free tier is barely touched.
import { AI_BRAIN_TIMEOUT_MS, AI_BRAIN_CACHE_TTL, AI_BRAIN_MODEL } from "./config.js";

// Actions the brain may return.
//   retry_same  — the same endpoint may succeed if we try again (transient)
//   next_token  — this API key/quota is the problem; another token may work
//   next_model  — the model is the problem (not found / unsupported / empty)
//   stop        — nothing else will help; surface the error
export const BRAIN_ACTIONS = ["retry_same", "next_token", "next_model", "stop"];

// Deterministic verdicts for the well-understood categories. `exhausted` means
// the action only makes sense while another token/model still remains untried.
const HEURISTIC = {
  timeout: { action: "retry_same", reason: "transient stall" },
  network_error: { action: "retry_same", reason: "network hiccup" },
  server_error: { action: "retry_same", reason: "upstream 5xx" },
  provider_overloaded: { action: "next_token", reason: "provider overloaded" },
  rate_limited: { action: "next_token", reason: "rate limited" },
  quota_exceeded: { action: "next_token", reason: "quota exhausted" },
  daily_quota_exceeded: { action: "next_token", reason: "daily quota exhausted" },
  invalid_key: { action: "next_token", reason: "invalid key" },
  forbidden: { action: "next_token", reason: "access denied for this key" },
  model_not_found: { action: "next_model", reason: "model unavailable" },
  invalid_configuration: { action: "next_model", reason: "model rejected request" },
  empty_response: { action: "next_model", reason: "empty completion" },
  unexpected_format: { action: "next_model", reason: "malformed completion" },
  invalid_base_url: { action: "stop", reason: "bad base url" },
  no_connection: { action: "stop", reason: "no connection" },
  unknown: { action: "next_token", reason: "unclassified" }
};

function hashSignature(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function signature(input) {
  return [
    input.category || "unknown",
    input.status || "",
    (input.providerCode || "").toLowerCase(),
    (input.providerType || "").toLowerCase(),
    (input.providerMessage || "").slice(0, 120).toLowerCase()
  ].join("|");
}

export function heuristicVerdict(input) {
  const category = (input && input.category) || "unknown";
  const base = HEURISTIC[category] || HEURISTIC.unknown;
  const triedAllTokens = input && input.tokensRemaining !== undefined && input.tokensRemaining <= 0;
  const triedAllModels = input && input.modelsRemaining !== undefined && input.modelsRemaining <= 0;
  let action = base.action;
  // Degrade gracefully when the chosen resource type is exhausted: a token
  // rotation with no tokens left becomes a model switch, and a model switch with
  // no models left becomes a retry (only meaningful for transient classes).
  if (action === "next_token" && triedAllTokens) action = triedAllModels ? "retry_same" : "next_model";
  if (action === "next_model" && triedAllModels) action = triedAllTokens ? "stop" : "next_token";
  if (action === "retry_same" && base.action === "retry_same" && input && input.attempt && input.attempt >= 2) action = triedAllTokens ? "stop" : "next_token";
  return { action: action, reason: base.reason, source: "heuristic" };
}

async function askBrainAI(env, input) {
  const prompt =
    "You are a resilient API-router error classifier. A request to an LLM provider failed.\n" +
    "Error category: " + (input.category || "unknown") + "\n" +
    "HTTP status: " + (input.status || "n/a") + "\n" +
    "Provider type: " + (input.providerType || "n/a") + "\n" +
    "Provider code: " + (input.providerCode || "n/a") + "\n" +
    "Message: " + ((input.providerMessage || input.raw || "").slice(0, 300) || "n/a") + "\n" +
    "Tokens remaining: " + (input.tokensRemaining !== undefined ? input.tokensRemaining : "?") + "\n" +
    "Models remaining: " + (input.modelsRemaining !== undefined ? input.modelsRemaining : "?") + "\n\n" +
    "Choose exactly one action:\n" +
    "- retry_same: transient fault, same endpoint may succeed again\n" +
    "- next_token: this API key/quota is the problem, try another token\n" +
    "- next_model: the model is the problem, try another model\n" +
    "- stop: nothing else will help\n" +
    "Reply with ONLY compact JSON: {\"action\":\"...\",\"reason\":\"...\"}";
  const ai = env && env.AI;
  if (!ai) return null;
  const result = await Promise.race([
    ai.run(AI_BRAIN_MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 80 }),
    new Promise(function (resolve) { setTimeout(function () { resolve(null); }, AI_BRAIN_TIMEOUT_MS); })
  ]);
  if (!result) return null;
  let text = "";
  if (typeof result === "string") text = result;
  else if (result.response) text = String(result.response);
  else if (result.result && result.result.response) text = String(result.result.response);
  if (!text) return null;
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch (e) { return null; }
  if (!parsed || BRAIN_ACTIONS.indexOf(parsed.action) === -1) return null;
  return { action: parsed.action, reason: String(parsed.reason || "").slice(0, 120), source: "ai" };
}

/**
 * Decide the next recovery action for a failed provider request. Returns
 * { action, reason, source }. Never throws.
 */
export async function decideNextAction(env, input) {
  const sig = signature(input || {});
  const cacheKey = "brain:" + hashSignature(sig);
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      try { const parsed = JSON.parse(cached); if (parsed && parsed.action) return parsed; } catch (e) {}
    }
  } catch (e) {}

  let verdict = null;
  // Only consult the AI for categories the heuristic cannot confidently resolve.
  const category = (input && input.category) || "unknown";
  const confident = HEURISTIC[category] && category !== "unknown";
  if (!confident && env && env.AI) {
    try { verdict = await askBrainAI(env, input || {}); } catch (e) { verdict = null; }
  }
  if (!verdict) verdict = heuristicVerdict(input || {});

  // Remaining-resource degradation still applies to AI verdicts.
  const triedAllTokens = input && input.tokensRemaining !== undefined && input.tokensRemaining <= 0;
  const triedAllModels = input && input.modelsRemaining !== undefined && input.modelsRemaining <= 0;
  if (verdict.action === "next_token" && triedAllTokens) verdict.action = triedAllModels ? "stop" : "next_model";
  if (verdict.action === "next_model" && triedAllModels) verdict.action = triedAllTokens ? "stop" : "next_token";

  try { await env.KV.put(cacheKey, JSON.stringify(verdict), { expirationTtl: AI_BRAIN_CACHE_TTL }); } catch (e) {}
  return verdict;
}

/** Map a stream error into the brain input shape. */
export function brainInputFromError(err, category, ctx) {
  const c = ctx || {};
  return {
    category: category,
    status: err && err.status,
    providerType: err && err.providerType,
    providerCode: err && err.providerCode,
    providerMessage: err && err.providerMessage,
    raw: err && (err.message || String(err)),
    attempt: c.attempt || 0,
    tokensRemaining: c.tokensRemaining,
    modelsRemaining: c.modelsRemaining
  };
}
