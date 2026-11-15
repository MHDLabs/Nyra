/**
 * TypeScript smoke module for Task 2 tooling verification.
 * Production entry remains src/index.js until a later migration task.
 */

/** Minimal binding surface used only to prove Cloudflare.Env merges. */
export type SmokeEnv = {
  DB: D1Database;
  KV: KVNamespace;
  NYRA_QUEUE: Queue;
  NYRA_DLQ: Queue;
  AI: Ai;
  ASSETS: Fetcher;
};

export function describeBindings(env: SmokeEnv): string[] {
  const names: string[] = [];
  if (env.DB) names.push("DB");
  if (env.KV) names.push("KV");
  if (env.NYRA_QUEUE) names.push("NYRA_QUEUE");
  if (env.NYRA_DLQ) names.push("NYRA_DLQ");
  if (env.AI) names.push("AI");
  if (env.ASSETS) names.push("ASSETS");
  return names;
}

/** Preferred import style for TS sources targeting Wrangler/ESM. */
export function assertImportExtensionPattern(): string {
  return "use .js import specifiers in TypeScript sources";
}
