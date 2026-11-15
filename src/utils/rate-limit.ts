import { MEMORY_RATE_BUCKET_MAX_AGE_MS } from "../config.js";

const memoryRateBuckets = new Map<string, number>();

export function checkMemoryRate(key: string, limit: number, windowMs: number): boolean {
  const nowMs = Date.now();
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const bucketKey = key + ":" + bucketStart;
  const current = memoryRateBuckets.get(bucketKey) || 0;
  if (current >= limit) return false;
  memoryRateBuckets.set(bucketKey, current + 1);
  if (memoryRateBuckets.size > 5000) {
    const keysToDelete: string[] = [];
    for (const k of memoryRateBuckets.keys()) {
      const idx = k.lastIndexOf(":");
      const bStart = parseInt(k.slice(idx + 1), 10);
      if (nowMs - bStart > MEMORY_RATE_BUCKET_MAX_AGE_MS) keysToDelete.push(k);
      if (keysToDelete.length > 2500) break;
    }
    for (const k of keysToDelete) memoryRateBuckets.delete(k);
  }
  return true;
}

type RateLimitEnv = {
  KV: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
};

export async function checkRateLimit(
  env: RateLimitEnv,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const windowMs = windowSeconds * 1000;
  const nowMs = Date.now();
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const bucketKey = "rl:" + key + ":" + bucketStart;
  try {
    const raw = await env.KV.get(bucketKey);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    if (current >= limit) return false;
    await env.KV.put(bucketKey, String(current + 1), { expirationTtl: windowSeconds + 60 });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("checkRateLimit failed:", message);
    return true;
  }
}
