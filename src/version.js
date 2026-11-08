// Build identity injected at deploy time (GitHub Actions / wrangler vars).
// Falls back gracefully for local wrangler dev and one-click deploys without CI.

export const UPSTREAM_REPO = "MHDLabs/Nyra";
export const UPSTREAM_BRANCH = "main";
export const GITHUB_API = "https://api.github.com";

/**
 * Identity of the code currently running in this Worker.
 * Prefer CI-injected vars; never invent a fake SHA.
 */
export function getBuildInfo(env) {
  const sha = (env && (env.NYRA_BUILD_SHA || env.BUILD_SHA)) ? String(env.NYRA_BUILD_SHA || env.BUILD_SHA).trim() : "";
  const ref = (env && env.NYRA_BUILD_REF) ? String(env.NYRA_BUILD_REF).trim() : "";
  const time = (env && env.NYRA_BUILD_TIME) ? String(env.NYRA_BUILD_TIME).trim() : "";
  const source = (env && env.NYRA_BUILD_SOURCE) ? String(env.NYRA_BUILD_SOURCE).trim() : (sha ? "ci" : "unknown");
  return {
    sha: sha || null,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: ref || null,
    builtAt: time || null,
    source: source
  };
}

/**
 * Compare running build against the public GitHub tip of main.
 * Public repo — no token required. Failures are soft (network/API).
 */
export async function checkUpstreamUpdate(env) {
  const build = getBuildInfo(env);
  const url = GITHUB_API + "/repos/" + UPSTREAM_REPO + "/commits/" + UPSTREAM_BRANCH;
  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Nyra-OTA-Check"
      }
    });
    if (!resp.ok) {
      return {
        ok: false,
        build: build,
        error: "github_http_" + resp.status,
        updateAvailable: null
      };
    }
    const data = await resp.json();
    const tipSha = data && data.sha ? String(data.sha) : null;
    const tipMessage = data && data.commit && data.commit.message
      ? String(data.commit.message).split("\n")[0].slice(0, 120)
      : null;
    const tipDate = data && data.commit && data.commit.committer && data.commit.committer.date
      ? String(data.commit.committer.date)
      : null;
    let updateAvailable = null;
    if (build.sha && tipSha) {
      updateAvailable = build.sha.toLowerCase() !== tipSha.toLowerCase();
    } else if (!build.sha && tipSha) {
      updateAvailable = true; // unknown local build; upstream tip is known
    }
    return {
      ok: true,
      build: build,
      upstream: {
        repo: UPSTREAM_REPO,
        branch: UPSTREAM_BRANCH,
        sha: tipSha,
        shortSha: tipSha ? tipSha.slice(0, 7) : null,
        message: tipMessage,
        date: tipDate,
        htmlUrl: tipSha ? "https://github.com/" + UPSTREAM_REPO + "/commit/" + tipSha : null
      },
      updateAvailable: updateAvailable
    };
  } catch (err) {
    return {
      ok: false,
      build: build,
      error: err && err.message ? err.message : "fetch_failed",
      updateAvailable: null
    };
  }
}
