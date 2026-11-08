import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBuildInfo, UPSTREAM_REPO, UPSTREAM_BRANCH } from "../src/version.js";

describe("build identity", () => {
  it("returns null SHA when env has no build metadata", () => {
    const info = getBuildInfo({});
    assert.equal(info.sha, null);
    assert.equal(info.shortSha, null);
    assert.equal(info.source, "unknown");
  });

  it("reads CI-injected vars", () => {
    const info = getBuildInfo({
      NYRA_BUILD_SHA: "abcdef0123456789",
      NYRA_BUILD_REF: "main",
      NYRA_BUILD_TIME: "2026-11-08T12:00:00Z",
      NYRA_BUILD_SOURCE: "github-actions"
    });
    assert.equal(info.sha, "abcdef0123456789");
    assert.equal(info.shortSha, "abcdef0");
    assert.equal(info.ref, "main");
    assert.equal(info.source, "github-actions");
  });

  it("points at the public upstream repo", () => {
    assert.equal(UPSTREAM_REPO, "MHDLabs/Nyra");
    assert.equal(UPSTREAM_BRANCH, "main");
  });
});
