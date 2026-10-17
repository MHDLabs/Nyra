#!/usr/bin/env node
// Nyra — deploy wrapper (package.json → scripts.deploy, which the
// Deploy-to-Cloudflare flow picks up as the build's deploy command).
//
// Phase 1: `npx wrangler deploy` — output is streamed and its exit code is
//          propagated: a failed deploy fails the whole flow.
// Phase 2 (best-effort, never fails the flow): GET /status on the deployed
//          Worker. That single request makes the Worker initialise its D1
//          schema, learn its public origin, and register the Telegram webhook
//          and the Mini App menu button *itself*, from its own origin and with
//          its RUNTIME secrets — so build-time and runtime configuration can
//          never disagree. (The Mini App owns "/", so the bootstrap page lives
//          at /status.) Fallbacks if this probe cannot run: the */5 cron
//          re-verifies both once the URL is known, and any later Worker-handled
//          request — including a Mini App /api/* call — teaches the origin.
//          In the worst case, open the printed Worker URL + /status in a
//          browser once to finish setup.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Extract deployed Worker URLs from wrangler output. The workers.dev URL
// (enabled by `workers_dev = true` in wrangler.toml) is preferred; custom
// domain routes are kept as fallbacks. Known non-Worker hosts are filtered.
export function extractWorkerUrls(output) {
  const denylist = /:\/\/(api\.telegram\.org|developers\.cloudflare\.com|workers\.cloudflare\.com|dash\.cloudflare\.com|www\.cloudflare\.com|github\.com|registry\.npmjs\.org|www\.npmjs\.com|nodejs\.org)\b/i;
  const seen = new Set();
  const urls = [];
  const re = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'`<>)\]]*/gi;
  let m;
  while ((m = re.exec(output)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (denylist.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  // workers.dev first — it is the canonical auto-enabled domain.
  urls.sort(function (a, b) {
    return (b.indexOf(".workers.dev") !== -1 ? 1 : 0) - (a.indexOf(".workers.dev") !== -1 ? 1 : 0);
  });
  return urls;
}

function runWranglerDeploy() {
  return new Promise(function (resolve) {
    let output = "";
    const child = spawn("npx", ["wrangler", "deploy"], {
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    child.stdout.on("data", function (chunk) { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", function (chunk) { output += chunk; process.stderr.write(chunk); });
    child.on("error", function (err) {
      console.error("[postdeploy] failed to start wrangler:", err.message);
      resolve({ code: 1, output: output });
    });
    child.on("close", function (code) {
      resolve({ code: code == null ? 1 : code, output: output });
    });
  });
}

async function probe(url) {
  const target = url.replace(/\/+$/, "") + "/status";
  try {
    const res = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30000) });
    let body = "";
    try { body = await res.text(); } catch (err) { body = ""; }
    console.log("[postdeploy] " + target + " → HTTP " + res.status);
    if (body) console.log("[postdeploy] " + body.slice(0, 500));
    return res.status < 500;
  } catch (err) {
    console.warn("[postdeploy] probe failed for " + target + ": " + err.message);
    return false;
  }
}

async function main() {
  console.log("[postdeploy] deploying with `npx wrangler deploy` …");
  const deploy = await runWranglerDeploy();
  if (deploy.code !== 0) {
    console.error("[postdeploy] wrangler deploy failed with exit code " + deploy.code);
    process.exit(deploy.code);
  }
  console.log("[postdeploy] deploy succeeded.");
  const urls = extractWorkerUrls(deploy.output);
  if (urls.length) {
    console.log("[postdeploy] Worker URL(s): " + urls.join(", "));
    for (let i = 0; i < urls.length; i++) {
      if (await probe(urls[i])) {
        console.log("[postdeploy] bootstrap OK — schema initialised, webhook and Mini App menu button registered. "
          + "Check GET /status for details; the Mini App itself is at the root URL.");
        process.exit(0);
      }
    }
    console.warn("[postdeploy] probe did not confirm the Worker yet. Open " + urls[0] + "/status once in a browser "
      + "to finish setup (schema + automatic webhook registration), or wait for the */5 cron.");
  } else {
    console.warn("[postdeploy] no Worker URL found in deploy output. Open your Worker's URL + /status once in a "
      + "browser to finish setup (schema + automatic webhook registration).");
  }
  // Post-deploy steps are best-effort: the deploy itself succeeded.
  process.exit(0);
}

// Run only when executed directly (importable for unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(function (err) {
    console.error("[postdeploy] unexpected error:", err);
    process.exit(1);
  });
}
