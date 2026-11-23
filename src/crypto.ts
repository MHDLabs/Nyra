// Nyra — Telegram webhook secret validation.
export type CryptoEnv = {
  TELEGRAM_SECRET?: string | null;
  TELEGRAM_BOT_TOKEN?: string | null;
};

/** Return the configured Telegram webhook/setup secret or null. */
export async function getWebhookSecret(env: CryptoEnv): Promise<string | null> {
  const secret = env.TELEGRAM_SECRET;
  if (typeof secret !== "string") return null;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate only secrets still required by the retained Telegram runtime. */
export function validateSecrets(env: CryptoEnv): string[] | null {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN || !String(env.TELEGRAM_BOT_TOKEN).trim()) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.TELEGRAM_SECRET || !String(env.TELEGRAM_SECRET).trim()) missing.push("TELEGRAM_SECRET");
  return missing.length ? missing : null;
}
