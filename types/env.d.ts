/// <reference path="../worker-configuration.d.ts" />

/**
 * Application secrets and deploy metadata merged into Cloudflare.Env.
 * Resource bindings come from worker-configuration.d.ts (wrangler types).
 */
declare namespace Cloudflare {
  interface Env {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_SECRET?: string;
    ADMIN_PANEL_PASSWORD?: string;
    NYRA_BUILD_SHA?: string;
    NYRA_BUILD_REF?: string;
    NYRA_BUILD_TIME?: string;
    NYRA_BUILD_SOURCE?: string;
  }
}

/** Convenient alias for handlers: env parameter type. */
type NyraEnv = Cloudflare.Env;

export type { NyraEnv };
