import { test } from "node:test";
import assert from "node:assert/strict";
import { getSetting, setSetting } from "../src/db.js";

/**
 * Minimal in-memory D1 stub covering the app_settings helpers and upsert.
 */
function fakeEnv() {
  const settings = new Map();
  return {
    settings,
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

test("settings helpers never throw when D1 errors", async () => {
  const env = { DB: { prepare() { throw new Error("db down"); } } };
  assert.equal(await getSetting(env, "k", "fb"), "fb");
  assert.equal(await isPersonalModelsAllowed(env), false);
  assert.equal(await getPersonalModelLimit(env), 5);
  assert.equal(await countPersonalConnections(env, 1), 0);
  assert.equal(await setSetting(env, "k", "v"), false);
});

