import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeBindings, assertImportExtensionPattern } from "../src/ts-smoke/entry.ts";
import type { SmokeEnv } from "../src/ts-smoke/entry.ts";

describe("TypeScript tooling smoke", () => {
  it("runs under tsx with node:test", () => {
    assert.equal(assertImportExtensionPattern().includes(".js"), true);
  });

  it("describeBindings lists expected Cloudflare resources", () => {
    const env = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      NYRA_QUEUE: {} as Queue,
      NYRA_DLQ: {} as Queue,
      AI: {} as Ai,
      ASSETS: {} as Fetcher
    } satisfies SmokeEnv;
    const names = describeBindings(env);
    assert.deepEqual(names, ["DB", "KV", "NYRA_QUEUE", "NYRA_DLQ", "AI", "ASSETS"]);
  });
});
