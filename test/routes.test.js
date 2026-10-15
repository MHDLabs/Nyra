import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoutePlan } from "../src/db.js";

function route(over) {
  return Object.assign({
    route_id: "r1", telegram_id: 42, label: "Main", provider: "openai",
    base_url: "https://api.openai.com/v1", is_default: 1, enabled: 1
  }, over || {});
}

function model(id, name, opts) {
  return Object.assign({ model_id: id, route_id: "r1", model: name, is_default: 0, display_order: 100 }, opts || {});
}

function token(id, enabled, opts) {
  return Object.assign({ token_id: id, route_id: "r1", encrypted_key: "ct-" + id, key_iv: "iv-" + id, enabled: enabled, is_primary: 0, display_order: 100, consecutive_failures: 0 }, opts || {});
}

test("buildRoutePlan returns empty for null/incomplete bundle", () => {
  assert.deepEqual(buildRoutePlan(null), []);
  assert.deepEqual(buildRoutePlan({}), []);
  assert.deepEqual(buildRoutePlan({ route: null, models: [], tokens: [] }), []);
});

test("buildRoutePlan expands models x enabled tokens in order", () => {
  const bundle = {
    route: route(),
    models: [model("m1", "gpt-4o-mini"), model("m2", "gpt-4o")],
    tokens: [token("t1", 1), token("t2", 1)]
  };
  const plan = buildRoutePlan(bundle);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map(p => p.model), ["gpt-4o-mini", "gpt-4o-mini", "gpt-4o", "gpt-4o"]);
  assert.deepEqual(plan.map(p => p.token_id), ["t1", "t2", "t1", "t2"]);
  assert.equal(plan[0].connection_id, "r1:t1:m1");
  assert.equal(plan[3].connection_id, "r1:t2:m2");
  assert.equal(plan[0].is_primary, true);
  assert.ok(plan.slice(1).every(p => p.is_primary === false));
});

test("buildRoutePlan skips disabled tokens", () => {
  const bundle = {
    route: route(),
    models: [model("m1", "gpt-4o-mini")],
    tokens: [token("t1", 1), token("t2", 0), token("t3", 1)]
  };
  const plan = buildRoutePlan(bundle);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map(p => p.token_id), ["t1", "t3"]);
});

test("buildRoutePlan carries route credentials and marks synthetic connections", () => {
  const bundle = {
    route: route({ label: "Fast", provider: "anthropic", base_url: "https://api.anthropic.com" }),
    models: [model("m1", "claude-3-5-sonnet")],
    tokens: [token("t1", 1, { consecutive_failures: 3 })]
  };
  const [p] = buildRoutePlan(bundle);
  assert.equal(p.label, "Fast");
  assert.equal(p.provider, "anthropic");
  assert.equal(p.base_url, "https://api.anthropic.com");
  assert.equal(p.telegram_id, 42);
  assert.equal(p.encrypted_key, "ct-t1");
  assert.equal(p.key_iv, "iv-t1");
  assert.equal(p.is_route, true);
  assert.equal(p.is_global, 1);
  assert.equal(p.consecutive_failures, 3);
});

test("buildRoutePlan with no tokens yields empty plan", () => {
  const bundle = { route: route(), models: [model("m1", "gpt-4o-mini")], tokens: [] };
  assert.deepEqual(buildRoutePlan(bundle), []);
});
