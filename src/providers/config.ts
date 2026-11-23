import type { NyraEnv } from "../../types/env.js";

export type CentralAIConfig = {
  base_url: string;
  model: string;
  api_key: string;
  supports_vision: 0 | 1;
};

/**
 * Resolve Nyra's centrally configured AI endpoint and model.
 *
 * Credentials and model selection are operator-owned Worker configuration.
 * This function never reads user records or D1 and never returns the API key
 * to a caller-facing response.
 */
export function getCentralAIConfig(env: NyraEnv): CentralAIConfig {
  const apiKey = typeof env.AI_API_KEY === "string" ? env.AI_API_KEY.trim() : "";
  const model = typeof env.AI_MODEL === "string" ? env.AI_MODEL.trim() : "";
  const rawBaseUrl = typeof env.AI_BASE_URL === "string" ? env.AI_BASE_URL.trim() : "";
  const baseUrl = (rawBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

  if (!apiKey) throw configurationError("AI_API_KEY is not configured");
  if (!model) throw configurationError("AI_MODEL is not configured");

  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { throw configurationError("AI_BASE_URL must be an absolute URL"); }
  const localHttp = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw configurationError("AI_BASE_URL must use HTTPS except for localhost development");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configurationError("AI_BASE_URL must not contain credentials, query parameters, or a fragment");
  }

  const supportsVision = String(env.AI_SUPPORTS_VISION || "").toLowerCase() === "true"
    || String(env.AI_SUPPORTS_VISION || "") === "1";

  return {
    base_url: baseUrl,
    model,
    api_key: apiKey,
    supports_vision: supportsVision ? 1 : 0
  };
}

function configurationError(message: string) {
  const error: any = new Error(message);
  error.category = "invalid_configuration";
  return error;
}
