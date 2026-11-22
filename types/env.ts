/**
 * Runtime Env used by application modules.
 * Binding types come from worker-configuration.d.ts globals (D1Database, etc.).
 */
export type NyraEnv = {
  DB: D1Database;
  KV: KVNamespace;
  NYRA_QUEUE: Queue;
  NYRA_DLQ: Queue;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_API_KEY?: string;
  AI_SUPPORTS_VISION?: string;
  ASSETS: Fetcher;
  ADMIN_IDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SECRET?: string;
  ENCRYPTION_KEY?: string;
  ADMIN_PANEL_PASSWORD?: string;
  TELEGRAM_BOT_ID?: string;
  TELEGRAM_BOT_USERNAME?: string;
  NYRA_BUILD_SHA?: string;
  NYRA_BUILD_REF?: string;
  NYRA_BUILD_TIME?: string;
  NYRA_BUILD_SOURCE?: string;
  [key: string]: unknown;
};
