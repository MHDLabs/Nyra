import type { NyraEnv } from "../../types/env.js";
import { isAdmin, now } from "../utils.js";
import { getCentralAIConfig } from "./config.js";

export type ModelConfig = {
  id: string; label: string; provider: string; base_url: string; model: string;
  api_key: string; supports_vision: 0 | 1;
};

const FALLBACK_ID = "cloudflare_qwen38";
function configError(message: string, category = "invalid_configuration"): Error {
  const error: any = new Error(message); error.category = category; return error;
}
function encryptionSecret(env: NyraEnv): string {
  const secret = String(env.NYRA_MODEL_ENCRYPTION_KEY || "").trim();
  if (secret.length < 32) throw configError("Set a stable NYRA_MODEL_ENCRYPTION_KEY secret (at least 32 characters) before saving provider keys.");
  return secret;
}
function toBase64(bytes: Uint8Array): string {
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes;
}
async function cryptoKey(env: NyraEnv, usage: ("encrypt" | "decrypt")[]): Promise<CryptoKey> {
  const material = new TextEncoder().encode("nyra-model-registry-v1:" + encryptionSecret(env));
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usage);
}
async function encryptKey(env: NyraEnv, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env, ["encrypt"]), new TextEncoder().encode(secret));
  return { encrypted: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}
async function decryptKey(env: NyraEnv, encrypted: string, iv: string): Promise<string> {
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await cryptoKey(env, ["decrypt"]), fromBase64(encrypted));
  return new TextDecoder().decode(clear);
}

export function validateModelBaseUrl(input: unknown): string {
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!raw || raw.length > 500) throw configError("Base URL is required and must be at most 500 characters.");
  let parsed: URL; try { parsed = new URL(raw); } catch { throw configError("Base URL must be an absolute URL."); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw configError("Base URL must use HTTPS (HTTP is allowed only for localhost).");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw configError("Base URL cannot contain credentials, query parameters, or a fragment.");
  if (/[{}]|ACCOUNT_ID/i.test(parsed.pathname)) throw configError("Replace the Cloudflare ACCOUNT_ID placeholder with the real account ID.");
  return raw;
}
function publicModel(row: any) {
  return {
    id: String(row.id), label: String(row.label || row.id), provider: String(row.provider || "openai-compatible"),
    model: String(row.model || ""), base_url: String(row.base_url || ""), enabled: Number(row.enabled) === 1,
    user_selectable: Number(row.user_selectable) === 1, fallback_only: Number(row.fallback_only) === 1,
    is_default: Number(row.is_default) === 1, supports_vision: Number(row.supports_vision) === 1,
    builtin: Number(row.builtin) === 1, has_api_key: !!(row.encrypted_api_key && row.key_iv)
  };
}
export async function getAdminModelList(env: NyraEnv) {
  const result = await env.DB.prepare("SELECT * FROM ai_models ORDER BY builtin DESC, display_order, created_at, id").all();
  return (result.results || []).map(publicModel);
}
export async function getSelectableModels(env: NyraEnv, userId: number | string) {
  const admin = isAdmin(env, userId);
  const result = await env.DB.prepare("SELECT id,label,model,enabled,user_selectable,fallback_only,is_default,encrypted_api_key,key_iv,base_url FROM ai_models WHERE enabled=1 ORDER BY is_default DESC,display_order,created_at").all();
  return (result.results || []).filter((row: any) => row.encrypted_api_key && row.key_iv && row.base_url
    && !/[{}]|ACCOUNT_ID/i.test(String(row.base_url))
    && !Number(row.fallback_only) && (admin || Number(row.user_selectable) === 1))
    .map((row: any) => ({ id: String(row.id), label: String(row.label), model: String(row.model), is_default: Number(row.is_default) === 1 }));
}
export async function setUserSelectedModel(env: NyraEnv, userId: number | string, modelId: string): Promise<boolean> {
  const admin = isAdmin(env, userId);
  const row = await env.DB.prepare("SELECT id FROM ai_models WHERE id=? AND enabled=1 AND fallback_only=0 AND encrypted_api_key IS NOT NULL AND key_iv IS NOT NULL AND base_url<>'' AND base_url NOT LIKE '%ACCOUNT_ID%' AND base_url NOT LIKE '%{%' AND base_url NOT LIKE '%}%' AND (?=1 OR user_selectable=1)")
    .bind(modelId, admin ? 1 : 0).first();
  if (!row) return false;
  await env.DB.prepare("UPDATE users SET selected_model_id=?,updated_at=? WHERE telegram_id=?").bind(modelId, now(), userId).run();
  return true;
}
export async function setModelApiKey(env: NyraEnv, modelId: string, apiKey: string): Promise<void> {
  const value = String(apiKey || "").trim();
  if (value.length < 8 || value.length > 4096) throw configError("API key length is invalid.");
  const encrypted = await encryptKey(env, value);
  const result = await env.DB.prepare("UPDATE ai_models SET encrypted_api_key=?,key_iv=?,encryption_version=1,updated_at=? WHERE id=?")
    .bind(encrypted.encrypted, encrypted.iv, now(), modelId).run();
  if (!result?.meta || result.meta.changes === 0) throw configError("Model not found.");
}
export async function updateModelAdmin(env: NyraEnv, modelId: string, patch: Record<string, unknown>): Promise<void> {
  const current = await env.DB.prepare("SELECT * FROM ai_models WHERE id=?").bind(modelId).first();
  if (!current) throw configError("Model not found.");
  const sets: string[] = []; const values: unknown[] = [];
  const add = (column: string, value: unknown) => { sets.push(column + "=?"); values.push(value); };
  if (patch.label !== undefined) { const v=String(patch.label || "").trim(); if(!v||v.length>80)throw configError("Model label must be 1–80 characters."); add("label",v); }
  if (patch.base_url !== undefined) add("base_url",validateModelBaseUrl(patch.base_url));
  if (patch.model !== undefined) { if(Number(current.builtin))throw configError("Built-in model IDs cannot be changed."); const v=String(patch.model||"").trim(); if(!v||v.length>160)throw configError("Model ID must be 1–160 characters."); add("model",v); }
  if (patch.enabled !== undefined) add("enabled",patch.enabled===true||patch.enabled===1?1:0);
  if (patch.user_selectable !== undefined && !Number(current.fallback_only)) add("user_selectable",patch.user_selectable===true||patch.user_selectable===1?1:0);
  if (patch.supports_vision !== undefined) add("supports_vision",patch.supports_vision===true||patch.supports_vision===1?1:0);
  if (sets.length) { sets.push("updated_at=?"); values.push(now(),modelId); await env.DB.prepare("UPDATE ai_models SET "+sets.join(",")+" WHERE id=?").bind(...values).run(); }
}
export async function setModelEnabled(env: NyraEnv, modelId: string, enabled: boolean): Promise<void> {
  await updateModelAdmin(env, modelId, { enabled });
}
export async function setModelVisibility(env: NyraEnv, modelId: string, userSelectable: boolean): Promise<void> {
  await updateModelAdmin(env, modelId, { user_selectable: userSelectable });
}
export async function setDefaultModel(env: NyraEnv, modelId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM ai_models WHERE id=? AND enabled=1 AND fallback_only=0 AND encrypted_api_key IS NOT NULL AND key_iv IS NOT NULL").bind(modelId).first();
  if (!row) throw configError("The default model must be enabled and have an API key configured.");
  validateModelBaseUrl(row.base_url);
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_models SET is_default=0,updated_at=?").bind(now()),
    env.DB.prepare("UPDATE ai_models SET is_default=1,updated_at=? WHERE id=?").bind(now(),modelId)
  ]);
}
export async function createCustomModel(env: NyraEnv, input: Record<string, unknown>): Promise<string> {
  const label=String(input.label||"").trim(), model=String(input.model||"").trim(), base=validateModelBaseUrl(input.base_url);
  if(!label||label.length>80)throw configError("Model name must be 1–80 characters.");
  if(!model||model.length>160)throw configError("Model ID must be 1–160 characters.");
  const random=crypto.getRandomValues(new Uint8Array(8));
  const id="custom_"+Array.from(random).map(n=>n.toString(16).padStart(2,"0")).join("");
  const ts=now();
  await env.DB.prepare("INSERT INTO ai_models (id,label,provider,model,base_url,enabled,user_selectable,fallback_only,is_default,supports_vision,builtin,display_order,created_at,updated_at) VALUES (?,?,'openai-compatible',?,?,0,?,0,0,?,0,100,?,?)")
    .bind(id,label,model,base,input.user_selectable===false?0:1,input.supports_vision===true?1:0,ts,ts).run();
  if(String(input.api_key||"").trim())await setModelApiKey(env,id,String(input.api_key));
  return id;
}
export async function deleteCustomModel(env: NyraEnv, modelId: string): Promise<void> {
  const row=await env.DB.prepare("SELECT builtin FROM ai_models WHERE id=?").bind(modelId).first();
  if(!row)throw configError("Model not found.");
  if(Number(row.builtin))throw configError("Built-in models cannot be deleted.");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET selected_model_id=NULL,updated_at=? WHERE selected_model_id=?").bind(now(),modelId),
    env.DB.prepare("DELETE FROM ai_models WHERE id=?").bind(modelId)
  ]);
}
async function buildConfig(row: any, env: NyraEnv): Promise<ModelConfig> {
  return {
    id:String(row.id),label:String(row.label||row.id),provider:String(row.provider||"openai-compatible"),
    base_url:validateModelBaseUrl(row.base_url),model:String(row.model),api_key:await decryptKey(env,row.encrypted_api_key,row.key_iv),
    supports_vision:Number(row.supports_vision)===1?1:0
  };
}
export async function getAIConfigForUser(env: NyraEnv, userId: number|string|null|undefined, forcedModelId?: string|null): Promise<{config:ModelConfig;fallbackConfig:ModelConfig|null}> {
  const legacyFallback = () => {
    const old=getCentralAIConfig(env);
    return {config:{id:"legacy_env",label:old.model,provider:"legacy",base_url:old.base_url,model:old.model,api_key:old.api_key,supports_vision:old.supports_vision},fallbackConfig:null};
  };
  let rows: any[];
  try { const result=await env.DB.prepare("SELECT * FROM ai_models ORDER BY is_default DESC,display_order,created_at").all(); rows=result.results||[]; }
  catch { return legacyFallback(); }
  const admin=userId!=null&&isAdmin(env,userId);
  const usable=(row:any,allowFallback:boolean)=>!!row&&Number(row.enabled)===1&&!!row.encrypted_api_key&&!!row.key_iv&&!!row.base_url
    && !/[{}]|ACCOUNT_ID/i.test(String(row.base_url))
    && (Number(row.fallback_only)!==1||allowFallback)
    && (admin||Number(row.user_selectable)===1||allowFallback);
  let selected:any=null;
  if(forcedModelId) {
    selected=rows.find(row=>row.id===forcedModelId&&usable(row,forcedModelId===FALLBACK_ID))||null;
    if(!selected) throw configError("The requested retry model is not configured and enabled.", "no_connection");
  } else if(userId!=null){
    try { const user=await env.DB.prepare("SELECT selected_model_id FROM users WHERE telegram_id=?").bind(userId).first(); if(user?.selected_model_id)selected=rows.find(row=>row.id===user.selected_model_id&&usable(row,false))||null; } catch {}
  }
  if(!selected)selected=rows.find(row=>Number(row.is_default)===1&&usable(row,false))||null;
  if(!selected)return legacyFallback();
  const config=await buildConfig(selected,env);
  let fallbackConfig:ModelConfig|null=null;
  if(!forcedModelId&&config.id==="groq_qwen38"&&config.provider==="groq"){
    const fallback=rows.find(row=>row.id===FALLBACK_ID&&usable(row,true));
    if(fallback){try{fallbackConfig=await buildConfig(fallback,env);}catch(error){console.error("Cloudflare fallback config unavailable:",error instanceof Error?error.message:String(error));}}
  }
  return {config,fallbackConfig};
}
export async function redactConfiguredModelKeys(env: NyraEnv, input: unknown): Promise<string> {
  let value=String(input||"");
  try {
    const result=await env.DB.prepare("SELECT encrypted_api_key,key_iv FROM ai_models WHERE encrypted_api_key IS NOT NULL AND key_iv IS NOT NULL").all();
    for(const row of (result.results || []) as any[]){try{const key=await decryptKey(env,row.encrypted_api_key,row.key_iv);if(key)value=value.split(key).join("[REDACTED]");}catch{}}
  } catch {}
  return value.replace(/Bearer\s+[^\s"'<>]+/gi,"Bearer [REDACTED]");
}
