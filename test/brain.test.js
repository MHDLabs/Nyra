import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicVerdict, BRAIN_ACTIONS, brainInputFromError } from "../src/brain.js";

test("BRAIN_ACTIONS exposes the four valid actions", () => {
  assert.deepEqual(BRAIN_ACTIONS.slice().sort(), ["next_model", "next_token", "retry_same", "stop"]);
});

test("heuristicVerdict: transient errors retry the same endpoint", () => {
  assert.equal(heuristicVerdict({ category: "timeout" }).action, "retry_same");
  assert.equal(heuristicVerdict({ category: "network_error" }).action, "retry_same");
  assert.equal(heuristicVerdict({ category: "server_error" }).action, "retry_same");
});

test("heuristicVerdict: key/quota errors rotate the token", () => {
  assert.equal(heuristicVerdict({ category: "rate_limited" }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "quota_exceeded" }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "daily_quota_exceeded" }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "invalid_key" }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "forbidden" }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "provider_overloaded" }).action, "next_token");
});

test("heuristicVerdict: model errors switch the model", () => {
  assert.equal(heuristicVerdict({ category: "model_not_found" }).action, "next_model");
  assert.equal(heuristicVerdict({ category: "invalid_configuration" }).action, "next_model");
  assert.equal(heuristicVerdict({ category: "empty_response" }).action, "next_model");
  assert.equal(heuristicVerdict({ category: "unexpected_format" }).action, "next_model");
});

test("heuristicVerdict: fatal errors stop", () => {
  assert.equal(heuristicVerdict({ category: "invalid_base_url" }).action, "stop");
  assert.equal(heuristicVerdict({ category: "no_connection" }).action, "stop");
});

test("heuristicVerdict: unknown category defaults to token rotation", () => {
  const v = heuristicVerdict({ category: "unknown" });
  assert.equal(v.action, "next_token");
  assert.equal(v.source, "heuristic");
  assert.deepEqual(heuristicVerdict({}).action, "next_token");
  assert.deepEqual(heuristicVerdict(null).action, "next_token");
});

test("heuristicVerdict degrades token rotation when no tokens remain", () => {
  assert.equal(heuristicVerdict({ category: "rate_limited", tokensRemaining: 0 }).action, "next_model");
  assert.equal(heuristicVerdict({ category: "rate_limited", tokensRemaining: 0, modelsRemaining: 0 }).action, "retry_same");
});

test("heuristicVerdict degrades model switch when no models remain", () => {
  assert.equal(heuristicVerdict({ category: "model_not_found", modelsRemaining: 0 }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "model_not_found", modelsRemaining: 0, tokensRemaining: 0 }).action, "stop");
});

test("heuristicVerdict gives up on repeated transient retries", () => {
  assert.equal(heuristicVerdict({ category: "timeout", attempt: 2 }).action, "next_token");
  assert.equal(heuristicVerdict({ category: "timeout", attempt: 2, tokensRemaining: 0 }).action, "stop");
});

test("brainInputFromError maps error fields and context", () => {
  const err = { status: 429, providerType: "rate_limit_error", providerCode: "rate_limit_exceeded", providerMessage: "slow down", message: "boom" };
  const input = brainInputFromError(err, "rate_limited", { attempt: 1, tokensRemaining: 2, modelsRemaining: 3 });
  assert.equal(input.category, "rate_limited");
  assert.equal(input.status, 429);
  assert.equal(input.providerType, "rate_limit_error");
  assert.equal(input.providerCode, "rate_limit_exceeded");
  assert.equal(input.providerMessage, "slow down");
  assert.equal(input.raw, "boom");
  assert.equal(input.attempt, 1);
  assert.equal(input.tokensRemaining, 2);
  assert.equal(input.modelsRemaining, 3);
});

test("brainInputFromError tolerates missing error/context", () => {
  const input = brainInputFromError(null, "timeout", null);
  assert.equal(input.category, "timeout");
  assert.equal(input.status, null);
  assert.equal(input.attempt, 0);
});
