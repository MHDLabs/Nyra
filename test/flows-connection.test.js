import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFlowMessage, handleFlowSkip } from "../src/flows/connection.js";
import { bytesToBase64 } from "../src/utils.js";
import { encryptCredential } from "../src/crypto.js";

/**
 * In-memory KV + D1 stub. The connection wizard only touches KV for flow state
 * and never queries D1 while advancing steps, so D1 is a tripwire: reaching it
 * means a step called something it should not have.
 */
function fakeEnv() {
  const kv = new Map();
  const env = {
    ADMIN_IDS: "111",
    ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(5)),
    sent: [],
    deleted: [],
    TELEGRAM_BOT_TOKEN: "1:test",
    KV: {
      async get(key, type) {
        const raw = kv.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { kv.delete(key); }
    },
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { throw new Error("unexpected D1 first(): " + sql); },
          async run() { throw new Error("unexpected D1 run(): " + sql); }
        };
      }
    }
  };
  env.kv = kv;
  return env;
}

/** Intercept Telegram API calls so the wizard runs offline. */
function withTelegram(env, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").pop();
    const payload = options && options.body ? JSON.parse(options.body) : {};
    if (method === "sendMessage" || method === "editMessageText") {
      env.sent.push({ method: method, text: payload.text || "", keyboard: payload.reply_markup || null });
    } else if (method === "deleteMessage") {
      env.deleted.push(payload.message_id);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { "Content-Type": "application/json" }
    });
  };
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; });
}

const MESSAGE = { text: "", message_id: 10 };
const FROM = { id: 111, first_name: "Admin" };
const CHAT = { id: 111, type: "private" };

function lastText(env) { return env.sent[env.sent.length - 1].text; }

/**
 * REGRESSION: the add-model wizard used to advance 1..6 and then throw
 * ReferenceError at the label step, because the Phase C split moved the
 * prompt renderers into connection-prompts.js without adding the import
 * back into connection.js. Every step after "provider" was dead, and the
 * unit tests could not see it because they never drive the wizard.
 */
test("add-model wizard runs provider → label → description → base_url → api_key → model → capabilities → review", async () => {
  const env = fakeEnv();
  await withTelegram(env, async () => {
    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "My Groq" }), FROM, CHAT, {
      step: "label", flowType: "add", provider: "openai-compatible", source: "set"
    });

    assert.match(lastText(env), /Step 3\/7/, "label step must render the description prompt");
    assert.equal((await env.KV.get("flow:111", "json")).step, "description");

    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "for quick tasks" }), FROM, CHAT, await env.KV.get("flow:111", "json"));
    assert.match(lastText(env), /Step 4\/7/, "description step must render the base URL prompt");
    assert.equal((await env.KV.get("flow:111", "json")).label, "My Groq");

    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "https://api.groq.com/openai/v1" }), FROM, CHAT, await env.KV.get("flow:111", "json"));
    assert.match(lastText(env), /Step 5\/7/, "base URL step must render the API key prompt");

    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "sk-secret" }), FROM, CHAT, await env.KV.get("flow:111", "json"));
    assert.match(lastText(env), /Step 6\/7/, "API key step must render the model prompt");
    assert.equal(env.deleted.length, 1, "the API key message must be deleted");

    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "qwen/qwen3.8-27b" }), FROM, CHAT, await env.KV.get("flow:111", "json"));
    assert.match(lastText(env), /Step 7\/7/, "model step must render the capability prompt");
    assert.match(lastText(env), /accept images/);

    const state = await env.KV.get("flow:111", "json");
    state.supports_vision = 0;
    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "no" }), FROM, CHAT, state);
    assert.match(lastText(env), /Review/, "capability step must render the review");
    assert.match(lastText(env), /My Groq/);
  });
});

test("edit-model wizard renders every edit step", async () => {
  const env = fakeEnv();
  await withTelegram(env, async () => {
    const base = {
      step: "edit_label", flowType: "edit", connectionId: "c1", source: "set",
      label: "Groq", description: "fast", provider: "openai-compatible",
      base_url: "https://api.groq.com/openai/v1", model: "qwen/qwen3.8-27b",
      supports_vision: 0, key_updated: false
    };
    const { ct, iv } = await encryptCredential(env, 111, "sk-old");

    await handleFlowMessage(env, null, Object.assign({}, MESSAGE, { text: "Groq 2" }), FROM, CHAT, Object.assign({}, base, { encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /Send a new description/);

    await handleFlowSkip(env, CHAT.id, FROM.id, Object.assign({}, base, { step: "edit_description", encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /Step 4\/7|Base URL/, "edit_description skip must render the base URL prompt");

    await handleFlowSkip(env, CHAT.id, FROM.id, Object.assign({}, base, { step: "edit_base_url", encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /Step 5\/6/, "edit_base_url skip must render the API key prompt");

    await handleFlowSkip(env, CHAT.id, FROM.id, Object.assign({}, base, { step: "edit_api_key", encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /Step 6\/6/, "edit_api_key skip must render the model prompt");

    await handleFlowSkip(env, CHAT.id, FROM.id, Object.assign({}, base, { step: "edit_model", encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /accept images/, "edit_model skip must render the capability prompt");
    assert.equal((await env.KV.get("flow:111", "json")).step, "edit_capabilities");

    await handleFlowSkip(env, CHAT.id, FROM.id, Object.assign({}, base, { step: "edit_capabilities", encrypted_key: ct, key_iv: iv }));
    assert.match(lastText(env), /Review/, "edit_capabilities skip must render the review");
    assert.equal((await env.KV.get("flow:111", "json")).step, "edit_confirm");
  });
});
