import { test } from "node:test";
import assert from "node:assert/strict";
import { getSetting, setSetting, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections } from "../src/db.js";

/**
 * Minimal in-memory D1 stub covering the app_settings + ai_connections queries
 * used by the settings helpers, plus the ON CONFLICT upsert in setSetting.
 */
function fakeEnv() {
  const settings = new Map();
  const conns = [];
  return {
    settings,
    conns,
    DB: {
      prepare(sql) {
        return {
          _args: [],
          bind(...args) { this._args = args; return this; },
          async first() {
            if (sql.indexOf("FROM app_settings") !== -1) {
              const key = this._args[0];
              return settings.has(key) ? { value: settings.get(key) } : null;
            }
            if (sql.indexOf("ai_connections") !== -1) {
              const uid = this._args[0];
              return { c: conns.filter(c => c.telegram_id === uid && c.is_global === 0).length };
            }
            return null;
          },
          async run() {
            if (sql.indexOf("INSERT INTO app_settings") !== -1) {
              settings.set(this._args[0], this._args[1]);
            }
            return { success: true };
          }
        };
      }
    }
  };
}

test("getSetting returns the stored value or fallback", async () => {
  const env = fakeEnv();
  assert.equal(await getSetting(env, "missing", "def"), "def");
  await setSetting(env, "allow_personal_models", "1", 7);
  assert.equal(await getSetting(env, "allow_personal_models", "0"), "1");
});

test("setSetting coerces values to strings", async () => {
  const env = fakeEnv();
  await setSetting(env, "personal_model_limit", 9, 1);
  assert.equal(env.settings.get("personal_model_limit"), "9");
});

test("isPersonalModelsAllowed only true for 1/true", async () => {
  const env = fakeEnv();
  assert.equal(await isPersonalModelsAllowed(env), false, "default off");
  await setSetting(env, "allow_personal_models", "1", 1);
  assert.equal(await isPersonalModelsAllowed(env), true);
  await setSetting(env, "allow_personal_models", "true", 1);
  assert.equal(await isPersonalModelsAllowed(env), true);
  await setSetting(env, "allow_personal_models", "0", 1);
  assert.equal(await isPersonalModelsAllowed(env), false);
});

test("getPersonalModelLimit defaults to 5 and rejects invalid values", async () => {
  const env = fakeEnv();
  assert.equal(await getPersonalModelLimit(env), 5);
  await setSetting(env, "personal_model_limit", "12", 1);
  assert.equal(await getPersonalModelLimit(env), 12);
  await setSetting(env, "personal_model_limit", "abc", 1);
  assert.equal(await getPersonalModelLimit(env), 5);
  await setSetting(env, "personal_model_limit", "0", 1);
  assert.equal(await getPersonalModelLimit(env), 5);
});

test("countPersonalConnections counts only the user's non-global connections", async () => {
  const env = fakeEnv();
  env.conns.push({ telegram_id: 1, is_global: 0 });
  env.conns.push({ telegram_id: 1, is_global: 0 });
  env.conns.push({ telegram_id: 1, is_global: 1 });
  env.conns.push({ telegram_id: 2, is_global: 0 });
  assert.equal(await countPersonalConnections(env, 1), 2);
  assert.equal(await countPersonalConnections(env, 2), 1);
  assert.equal(await countPersonalConnections(env, 3), 0);
});

test("settings helpers never throw when D1 errors", async () => {
  const env = { DB: { prepare() { throw new Error("db down"); } } };
  assert.equal(await getSetting(env, "k", "fb"), "fb");
  assert.equal(await isPersonalModelsAllowed(env), false);
  assert.equal(await getPersonalModelLimit(env), 5);
  assert.equal(await countPersonalConnections(env, 1), 0);
  assert.equal(await setSetting(env, "k", "v"), false);
});
