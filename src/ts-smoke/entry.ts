/**
 * TypeScript smoke module for the current Cloudflare Worker binding surface.
 */

/** Minimal binding surface used only to prove Cloudflare.Env merges. */
export type SmokeEnv = {
  DB: D1Database;
  KV: KVNamespace;
  NYRA_QUEUE: Queue;
  NYRA_DLQ: Queue;
  ASSETS: Fetcher;
};

export function describeBindings(env: SmokeEnv): string[] {
  const names: string[] = [];
  if (env.DB) names.push("DB");
  if (env.KV) names.push("KV");
  if (env.NYRA_QUEUE) names.push("NYRA_QUEUE");
  if (env.NYRA_DLQ) names.push("NYRA_DLQ");
  if (env.ASSETS) names.push("ASSETS");
  return names;
}

/** Preferred import style for TS sources targeting Wrangler/ESM. */
export function assertImportExtensionPattern(): string {
  return "use .js import specifiers in TypeScript sources";
}
