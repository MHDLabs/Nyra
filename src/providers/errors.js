// Provider error taxonomy: turn an opaque network/provider failure into one
// of a fixed set of categories, and map that category to text the user can
// actually act on. Kept dependency-free so every other module can import it.
import { truncate } from "../utils.js";

export function normalizeError(err, httpStatus) {
  const status = httpStatus || (err && err.status);
  const providerType = (err && err.providerType ? String(err.providerType) : "").toLowerCase();
  const providerCode = (err && err.providerCode ? String(err.providerCode) : "").toLowerCase();
  const providerMessage = (err && err.providerMessage ? String(err.providerMessage) : "").toLowerCase();
  const providerRaw = (err && err.providerRaw ? String(err.providerRaw) : "").toLowerCase();
  const providerName = (err && err.providerName ? String(err.providerName) : "").toLowerCase();
  const baseMessage = err ? String(err.message || err).toLowerCase() : "";
  const combined = baseMessage + " " + providerMessage + " " + providerRaw + " " + providerType + " " + providerCode;

  if (err && err.category === "empty_response") return "empty_response";
  if (err && err.category === "unexpected_format") return "unexpected_format";

  if (providerCode === "insufficient_quota" || providerType === "insufficient_quota" || combined.indexOf("insufficient_quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("exceeded your current quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("billing") !== -1 && combined.indexOf("quota") !== -1) return "quota_exceeded";
  if (combined.indexOf("payment required") !== -1) return "quota_exceeded";
  if (combined.indexOf("free-models-per-day") !== -1 || combined.indexOf("free_models_per_day") !== -1) return "daily_quota_exceeded";
  if (combined.indexOf("daily limit") !== -1 && combined.indexOf("free") !== -1) return "daily_quota_exceeded";
  if (combined.indexOf("provider returned error") !== -1 && status === 429) return "provider_overloaded";
  if (combined.indexOf("resource exhausted") !== -1) return "provider_overloaded";
  if (combined.indexOf("upstream") !== -1 && status === 429) return "provider_overloaded";
  if (providerName && status === 429 && combined.indexOf("rate limit") === -1) return "provider_overloaded";
  if (status === 529) return "provider_overloaded";
  if (status) {
    if (status === 401) return "invalid_key";
    if (status === 402) return "quota_exceeded";
    if (status === 403) return "forbidden";
    if (status === 404) return "model_not_found";
    if (status === 429) return "rate_limited";
    if (status === 400) {
      if (providerCode === "model_not_found") return "model_not_found";
      if (providerType === "invalid_request_error" && combined.indexOf("model") !== -1) return "model_not_found";
      return "invalid_configuration";
    }
    if (status >= 500 && status < 600) return "server_error";
  }
  if (!err) return "unknown";
  if (providerType === "authentication_error" || providerType === "invalid_api_key" || providerType === "unauthorized") return "invalid_key";
  if (providerType === "permission_error" || providerType === "permission_denied" || providerType === "forbidden") return "forbidden";
  if (providerType === "not_found_error" || providerCode === "model_not_found" || providerType === "model_not_found") return "model_not_found";
  if (providerType === "rate_limit_error" || providerType === "rate_limit_exceeded" || providerCode === "rate_limit_exceeded") return "rate_limited";
  if (providerType === "overloaded_error" || providerType === "api_error") return "server_error";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  if (combined.indexOf("timeout") !== -1 || combined.indexOf("timed out") !== -1 || combined.indexOf("aborted") !== -1 || combined.indexOf("abort") !== -1) return "timeout";
  if (combined.indexOf("empty response") !== -1) return "empty_response";
  if (combined.indexOf("unexpected response format") !== -1) return "unexpected_format";
  if (combined.indexOf("invalid api key") !== -1 || combined.indexOf("incorrect api key") !== -1 || combined.indexOf("invalid x-api-key") !== -1) return "invalid_key";
  if (combined.indexOf("invalid_api_key") !== -1 || combined.indexOf("authentication") !== -1 || combined.indexOf("unauthorized") !== -1) return "invalid_key";
  if (combined.indexOf("permission") !== -1 || combined.indexOf("forbidden") !== -1) return "forbidden";
  if (combined.indexOf("model not found") !== -1 || combined.indexOf("does not exist") !== -1 || combined.indexOf("unknown model") !== -1) return "model_not_found";
  if (combined.indexOf("rate limit") !== -1 || combined.indexOf("too many requests") !== -1) return "rate_limited";
  if (combined.indexOf("unsupported") !== -1 && combined.indexOf("parameter") !== -1) return "invalid_configuration";
  if (combined.indexOf("network") !== -1 || combined.indexOf("fetch failed") !== -1 || combined.indexOf("econnrefused") !== -1 || combined.indexOf("enotfound") !== -1) return "network_error";
  if (combined.indexOf("json") !== -1 || combined.indexOf("parse") !== -1 || combined.indexOf("format") !== -1) return "unexpected_format";
  if (combined.indexOf("url") !== -1 || combined.indexOf("endpoint") !== -1) return "invalid_base_url";
  return "unknown";
}

export function humanizeError(category) {
  const map = {
    invalid_key: "Invalid API key. Contact the administrator.",
    forbidden: "The provider denied access.",
    model_not_found: "The configured model was not found.",
    rate_limited: "Provider rate limit reached. Wait a moment and try again.",
    quota_exceeded: "The provider account has a billing issue.",
    daily_quota_exceeded: "The daily free-tier quota for this model is exhausted. Try again tomorrow.",
    provider_overloaded: "The provider is temporarily overloaded. Try again in a few minutes.",
    timeout: "The model did not respond in time after multiple attempts. Please try again.",
    network_error: "Could not reach the provider after multiple attempts. Please try again.",
    server_error: "The provider returned a server error. Try again later.",
    unexpected_format: "The model returned an unexpected response after multiple attempts. Please try again.",
    empty_response: "The model returned an empty response after multiple attempts. Please try again.",
    invalid_base_url: "The Base URL is invalid.",
    invalid_configuration: "The connection configuration is invalid.",
    no_connection: "No AI model is available yet. Please ask an administrator to configure one.",
    unknown: "The request failed after multiple attempts. Please try again."
  };
  return map[category] || map.unknown;
}

export function isRetryableCategory(category) {
  return category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "unexpected_format" ||
    category === "empty_response";
}

export function shouldNotifyAdmin(category) {
  return category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "unexpected_format" ||
    category === "empty_response" ||
    category === "unknown";
}

export async function parseProviderError(resp) {
  let errText = "";
  try { errText = await resp.text(); } catch (e) {}
  let parsed = null;
  try { parsed = JSON.parse(errText); } catch (e) {}
  const err = new Error("HTTP " + resp.status + ": " + truncate(errText, 200));
  err.status = resp.status;
  if (parsed) {
    if (parsed.error) {
      if (typeof parsed.error === "string") err.providerMessage = parsed.error;
      else if (typeof parsed.error === "object") {
        err.providerMessage = parsed.error.message || null;
        err.providerType = parsed.error.type || null;
        err.providerCode = parsed.error.code || null;
        if (parsed.error.metadata && typeof parsed.error.metadata === "object") {
          err.providerName = parsed.error.metadata.provider_name || null;
          if (parsed.error.metadata.raw) {
            err.providerRaw = typeof parsed.error.metadata.raw === "string" ? parsed.error.metadata.raw : JSON.stringify(parsed.error.metadata.raw);
          }
        }
      }
    }
    if (parsed.type && typeof parsed.type === "string" && !err.providerType) err.providerType = parsed.type;
    if (parsed.code && typeof parsed.code === "string" && !err.providerCode) err.providerCode = parsed.code;
    if (parsed.message && !err.providerMessage) err.providerMessage = String(parsed.message);
  }
  return err;
}
