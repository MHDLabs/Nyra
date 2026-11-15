// Build identity injected at deploy time (GitHub Actions / wrangler vars).
// Falls back gracefully for local wrangler dev and one-click deploys without CI.

import type { NyraEnv } from "../types/env.js";

export const UPSTREAM_REPO = "MHDLabs/Nyra";
export const UPSTREAM_BRANCH = "main";
export const GITHUB_API = "https://api.github.com";

export type BuildInfo = {
  sha: string | null;
  shortSha: string | null;
  ref: string | null;
  builtAt: string | null;
  source: string;
};

export type UpstreamCheckResult = {
  ok: boolean;
  build: BuildInfo;
  error?: string;
  updateAvailable: boolean | null;
  upstream?: {
    repo: string;
    branch: string;
    sha: string | null;
    shortSha: string | null;
    message: string | null;
    date: string | null;
  };
};

/**
 * Identity of the code currently running in this Worker.
 * Prefer CI-injected vars; never invent a fake SHA.
 */
export function getBuildInfo(env: NyraEnv | null | undefined): BuildInfo {
  const sha =
    env && (env.NYRA_BUILD_SHA || (env as { BUILD_SHA?: string }).BUILD_SHA)
      ? String(env.NYRA_BUILD_SHA || (env as { BUILD_SHA?: string }).BUILD_SHA).trim()
      : "";
  const ref = env && env.NYRA_BUILD_REF ? String(env.NYRA_BUILD_REF).trim() : "";
  const time = env && env.NYRA_BUILD_TIME ? String(env.NYRA_BUILD_TIME).trim() : "";
  const source = env && env.NYRA_BUILD_SOURCE
    ? String(env.NYRA_BUILD_SOURCE).trim()
    : sha
      ? "ci"
      : "unknown";
  return {
    sha: sha || null,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: ref || null,
    builtAt: time || null,
    source
  };
}

/**
 * Compare running build against the public GitHub tip of main.
 * Public repo — no token required. Failures are soft (network/API).
 */
export async function checkUpstreamUpdate(env: NyraEnv | null | undefined): Promise<UpstreamCheckResult> {
  const build = getBuildInfo(env);
  const url = GITHUB_API + "/repos/" + UPSTREAM_REPO + "/commits/" + UPSTREAM_BRANCH;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Nyra-OTA-Check"
      }
    });
    if (!resp.ok) {
      return {
        ok: false,
        build,
        error: "github_http_" + resp.status,
        updateAvailable: null
      };
    }
    const data: unknown = await resp.json();
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const tipSha =
      record && typeof record.sha === "string" ? String(record.sha) : null;
    const commit =
      record && typeof record.commit === "object" && record.commit
        ? (record.commit as Record<string, unknown>)
        : null;
    const tipMessage =
      commit && typeof commit.message === "string"
        ? String(commit.message).split("\n")[0].slice(0, 120)
        : null;
    const committer =
      commit && typeof commit.committer === "object" && commit.committer
        ? (commit.committer as Record<string, unknown>)
        : null;
    const tipDate =
      committer && typeof committer.date === "string" ? String(committer.date) : null;
    let updateAvailable: boolean | null = null;
    if (build.sha && tipSha) {
      updateAvailable = build.sha.toLowerCase() !== tipSha.toLowerCase();
    } else if (!build.sha && tipSha) {
      updateAvailable = true;
    }
    return {
      ok: true,
      build,
      updateAvailable,
      upstream: {
        repo: UPSTREAM_REPO,
        branch: UPSTREAM_BRANCH,
        sha: tipSha,
        shortSha: tipSha ? tipSha.slice(0, 7) : null,
        message: tipMessage,
        date: tipDate
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      build,
      error: message.slice(0, 120),
      updateAvailable: null
    };
  }
}
