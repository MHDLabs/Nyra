import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWorkerUrls } from "../scripts/postdeploy.mjs";
import { parseAdminIds } from "../src/utils.js";

test("extractWorkerUrls finds the workers.dev URL and prefers it first", () => {
  const output = [
    "wrangler deploy",
    "Uploaded nyra (1.23 sec)",
    "Deployed nyra triggers (2026-01-01)",
    "  https://chat.example.com/hook",
    "  https://nyra.abc123.workers.dev",
    "Current Version ID: 1234-5678",
    "Docs: https://developers.cloudflare.com/workers/"
  ].join("\n");
  const urls = extractWorkerUrls(output);
  assert.ok(urls.includes("https://nyra.abc123.workers.dev"));
  assert.ok(urls.includes("https://chat.example.com/hook"));
  assert.equal(urls[0], "https://nyra.abc123.workers.dev");
  assert.ok(!urls.includes("https://developers.cloudflare.com/workers/"));
});

test("extractWorkerUrls strips trailing punctuation and dedupes", () => {
  const urls = extractWorkerUrls("see https://nyra.x.workers.dev. then https://nyra.x.workers.dev, again");
  assert.deepEqual(urls, ["https://nyra.x.workers.dev"]);
});

test("extractWorkerUrls filters known non-Worker hosts", () => {
  const output = [
    "https://api.telegram.org/bot123/getWebhookInfo",
    "https://dash.cloudflare.com/abc/workers",
    "https://nyra.zzz.workers.dev"
  ].join(" ");
  assert.deepEqual(extractWorkerUrls(output), ["https://nyra.zzz.workers.dev"]);
});

test("parseAdminIds accepts only numeric entries", () => {
  const r = parseAdminIds("123, 456 ,abc,");
  assert.deepEqual(r.valid, ["123", "456"]);
  assert.deepEqual(r.invalid, ["abc"]);
  assert.equal(r.configured, true);
});

test("parseAdminIds reports unconfigured and invalid-only input", () => {
  assert.equal(parseAdminIds("").configured, false);
  assert.equal(parseAdminIds(undefined).configured, false);
  const r = parseAdminIds("@user, 12.5");
  assert.equal(r.configured, false);
  assert.equal(r.valid.length, 0);
  assert.equal(r.invalid.length, 2);
});
