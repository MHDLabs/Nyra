import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldReact,
  setProcessingReaction,
  clearProcessingReaction,
  heuristicReaction,
  isTelegramReaction,
  normalizeReactionEmoji,
  parseReactions,
  getAllowedReactions,
  getConfiguredReactions,
  setConfiguredReactions,
  clearConfiguredReactions,
  classifyReaction,
  extractMessageText,
  TELEGRAM_ALLOWED_REACTIONS,
  DEFAULT_REACTIONS,
  REACTION_LABELS
} from "../src/reactions.js";


test("processing reaction adds a temporary hourglass and removes it after completion", async () => {
  const calls = [];
  const kv = fakeKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { available_reactions: [{ type: "emoji", emoji: "⏳" }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  try {
    const env = { TELEGRAM_BOT_TOKEN: "1:test", KV: kv };
    await setProcessingReaction(env, 123, 45);
    await clearProcessingReaction(env, 123, 45);
    const set = calls.find((call) => call.method === "setMessageReaction" && call.body.reaction.length === 1);
    const clear = calls.find((call) => call.method === "setMessageReaction" && call.body.reaction.length === 0);
    assert.deepEqual(set.body.reaction, [{ type: "emoji", emoji: "⏳" }]);
    assert.equal(clear.body.chat_id, 123);
    assert.equal(clear.body.message_id, 45);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processing reaction skips chats that explicitly disallow the hourglass", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push(method);
    return new Response(JSON.stringify({ ok: true, result: { available_reactions: [] } }), { status: 200 });
  };
  try {
    await setProcessingReaction({ TELEGRAM_BOT_TOKEN: "1:test", KV: fakeKv() }, 456, 78);
    assert.deepEqual(calls, ["getChat"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shouldReact never reacts in private chats", () => {
  assert.equal(shouldReact({ text: "hey Nyra how are you" }, { id: 1, type: "private" }), false);
  assert.equal(shouldReact({ text: "hey Nyra how are you" }, false), false);
});

test("shouldReact ignores group messages that do not name Nyra", () => {
  assert.equal(shouldReact({ text: "good morning everyone, what's up" }, { id: 1, type: "group" }), false);
  assert.equal(shouldReact({ text: "this is a totally unrelated message" }, { id: 1, type: "supergroup" }), false);
});

test("shouldReact reacts only when Nyra is named", () => {
  assert.equal(shouldReact({ text: "Nyra can you help me?" }, { id: 1, type: "group" }), true);
  assert.equal(shouldReact({ text: "nyra, are you there?" }, { id: 1, type: "supergroup" }), true);
  assert.equal(shouldReact({ text: "یه سوال از نیرا دارم" }, { id: 1, type: "group" }), true);
  assert.equal(shouldReact({ text: "کجا بودی نيرا" }, { id: 1, type: "group" }), true);
});

test("shouldReact handles captions and empty input", () => {
  assert.equal(shouldReact({ caption: "Nyra look at this" }, { id: 1, type: "group" }), true);
  assert.equal(shouldReact({ caption: "just a photo" }, { id: 1, type: "group" }), false);
  assert.equal(shouldReact({}, { id: 1, type: "group" }), false);
  assert.equal(shouldReact({ text: "   " }, { id: 1, type: "group" }), false);
  assert.equal(shouldReact({ text: "ny" }, { id: 1, type: "group" }), false);
});

test("shouldReact does not match partial words", () => {
  assert.equal(shouldReact({ text: "the nyrablade is sharp" }, { id: 1, type: "group" }), false);
  assert.equal(shouldReact({ text: "nyras" }, { id: 1, type: "group" }), false);
});

test("shouldReact skips chats that forbid reactions", () => {
  assert.equal(shouldReact({ text: "Nyra are you there" }, { id: 1, type: "group", available_reactions: [] }), false);
  assert.equal(shouldReact({ text: "Nyra are you there" }, { id: 1, type: "group", available_reactions: [{ type: "emoji", emoji: "👍" }] }), true);
  assert.equal(shouldReact({ text: "Nyra are you there" }, { id: 1, type: "group" }), true);
});

test("extractMessageText includes the quoted message for short replies", () => {
  assert.equal(extractMessageText({ text: " Nyra? " }), "Nyra?");
  assert.equal(extractMessageText({ caption: "photo of Nyra" }), "photo of Nyra");
  assert.equal(extractMessageText({ text: "چرا؟", reply_to_message: { text: "Nyra چیه" } }), "چرا؟\nNyra چیه");
  assert.equal(extractMessageText({ reply_to_message: { text: "Nyra سلام" } }), "Nyra سلام");
  assert.equal(extractMessageText({}), "");
  assert.equal(extractMessageText(null), "");
});

test("heuristicReaction handles Persian punctuation and laughter", () => {
  assert.equal(heuristicReaction("چطوری؟"), "question");
  assert.equal(heuristicReaction("خخخخ"), "funny");
  assert.equal(heuristicReaction("lmao"), "funny");
  assert.equal(heuristicReaction("nothing special"), null);
  assert.equal(heuristicReaction(""), null);
});

test("every default reaction emoji is a valid Telegram reaction", () => {
  for (const label of REACTION_LABELS) {
    assert.equal(isTelegramReaction(DEFAULT_REACTIONS[label]), true, label + " -> " + DEFAULT_REACTIONS[label]);
  }
});

test("the previously-invalid default emoji are gone", () => {
  assert.equal(isTelegramReaction("😄"), false);
  assert.equal(isTelegramReaction("😮"), false);
  assert.equal(isTelegramReaction("❓"), false);
  assert.equal(isTelegramReaction("😂"), false);
  assert.equal(isTelegramReaction(""), false);
  assert.equal(isTelegramReaction(null), false);
});

test("normalizeReactionEmoji strips the variation selector", () => {
  assert.equal(normalizeReactionEmoji("❤️"), "❤");
  assert.equal(normalizeReactionEmoji("👍"), "👍");
  assert.equal(normalizeReactionEmoji("❤‍🔥"), "❤‍🔥");
  assert.equal(normalizeReactionEmoji("🍕"), null);
  assert.equal(normalizeReactionEmoji(""), null);
});

test("parseReactions drops emoji Telegram will not accept", () => {
  const parsed = parseReactions("👍, ❤️ ❓ 😄😂 🍕");
  assert.deepEqual(parsed.allowed, ["👍", "❤"]);
  assert.equal(parsed.ignored, 3);
  assert.deepEqual(parseReactions(["👍", "👍", "🔥"]).allowed, ["👍", "🔥"]);
  assert.deepEqual(parseReactions("").allowed, []);
});

test("TELEGRAM_ALLOWED_REACTIONS has no duplicates and includes the defaults", () => {
  assert.equal(new Set(TELEGRAM_ALLOWED_REACTIONS).size, TELEGRAM_ALLOWED_REACTIONS.length);
  for (const label of REACTION_LABELS) {
    assert.ok(TELEGRAM_ALLOWED_REACTIONS.includes(DEFAULT_REACTIONS[label]), label);
  }
});

/** Minimal in-memory KV double, enough for the allowlist bookkeeping. */
function fakeKv(initial) {
  const store = Object.assign({}, initial || {});
  return {
    // Mirrors real KV: `get(key, "json")` hands back parsed data, not a string.
    get: async (key, type) => {
      const value = key in store ? store[key] : null;
      if (value !== null && type === "json" && typeof value === "string") {
        try { return JSON.parse(value); } catch (err) { return null; }
      }
      return value;
    },
    put: async (key, value) => { store[key] = value; },
    delete: async (key) => { delete store[key]; },
    _store: store
  };
}

test("getAllowedReactions returns the defaults when nothing is configured or rejected", async () => {
  const allowed = await getAllowedReactions({ KV: fakeKv() }, 42);
  assert.deepEqual(allowed, REACTION_LABELS.map((label) => DEFAULT_REACTIONS[label]));
});

test("getAllowedReactions honours an admin-configured allowlist", async () => {
  const env = { KV: fakeKv({ "react:allowed": { emoji: "👍,❤️,🍕" } }) };
  assert.deepEqual(await getAllowedReactions(env, 42), ["👍", "❤"]);
});

test("getAllowedReactions drops emoji already rejected in this chat only", async () => {
  const env = { KV: fakeKv({ "react:reject:42": ["🤔"] }) };
  const allowed = await getAllowedReactions(env, 42);
  assert.equal(allowed.includes("🤔"), false);
  assert.equal(allowed.includes("👍"), true);
  // A different chat is unaffected.
  const other = await getAllowedReactions(env, 7);
  assert.equal(other.includes("🤔"), true);
});

test("getAllowedReactions never throws when KV is missing", async () => {
  const allowed = await getAllowedReactions({}, 42);
  assert.equal(allowed.length, REACTION_LABELS.length);
});

test("classifyReaction uses deterministic heuristics and respects the allowlist", async () => {
  const env = { KV: fakeKv() };
  const allowed = await getAllowedReactions(env, 1);
  assert.equal(await classifyReaction(env, "Nyra hahaha", allowed), "🤣");
  assert.equal(await classifyReaction(env, "Nyra are you there?", allowed), "🤔");
  assert.equal(await classifyReaction(env, "Nyra just a plain sentence", allowed), null);
});

test("classifyReaction returns null when a heuristic emoji is not allowed", async () => {
  assert.equal(await classifyReaction({ KV: fakeKv() }, "Nyra are you there?", ["👍", "👎"]), null);
});

test("classifyReaction does not depend on Workers AI", async () => {
  let calls = 0;
  const env = { KV: fakeKv(), AI: { run: async () => { calls++; return { response: "neutral" }; } } };
  const emoji = await classifyReaction(env, "Nyra سلام خوبی؟", await getAllowedReactions(env, 1));
  assert.equal(emoji, "🤔");
  assert.equal(calls, 0);
});

test("classifyReaction returns null when every emoji is disallowed in the chat", async () => {
  assert.equal(await classifyReaction({ KV: fakeKv() }, "Nyra are you there?", []), null);
});

test("classifyReaction returns null for ordinary text without a heuristic", async () => {
  assert.equal(await classifyReaction({ KV: fakeKv() }, "Nyra hello there", ["👍"]), null);
});

test("setConfiguredReactions stores valid emoji and reports the ignored ones", async () => {
  const env = { KV: fakeKv() };
  const parsed = await setConfiguredReactions(env, "👍 ❤️ 😄 ❓");
  assert.deepEqual(parsed.allowed, ["👍", "❤"]);
  assert.equal(parsed.ignored, 2);
  assert.deepEqual(await getAllowedReactions(env, 1), ["👍", "❤"]);
});

test("setConfiguredReactions with nothing valid falls back to the defaults", async () => {
  const env = { KV: fakeKv({ "react:allowed": { emoji: ["👍"] } }) };
  const parsed = await setConfiguredReactions(env, "😄 ❓");
  assert.deepEqual(parsed.allowed, []);
  // Override cleared, so the built-in set applies again.
  assert.equal(await getConfiguredReactions(env), null);
  assert.equal((await getAllowedReactions(env, 1)).includes("👍"), true);
});

test("clearConfiguredReactions restores the built-in set", async () => {
  const env = { KV: fakeKv() };
  await setConfiguredReactions(env, "👍 ❤");
  assert.deepEqual(await getAllowedReactions(env, 1), ["👍", "❤"]);
  await clearConfiguredReactions(env);
  assert.deepEqual(await getAllowedReactions(env, 1), REACTION_LABELS.map((label) => DEFAULT_REACTIONS[label]));
});

test("a custom allowlist simply drops heuristic reactions it does not cover", async () => {
  const env = { KV: fakeKv({ "react:allowed": { emoji: ["👍", "❤"] } }) };
  assert.equal(await classifyReaction(env, "Nyra are you there?", await getAllowedReactions(env, 1)), null);
});

test("getAllowedReactions honours the chat's own Telegram reaction set", async () => {
  const env = { KV: fakeKv() };
  const chat = { id: 42, type: "group", available_reactions: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }] };
  assert.deepEqual(await getAllowedReactions(env, chat), ["👍"]);
  // 🔥 is allowed by Telegram but not one of our label emoji, so it is not offered.
  assert.equal(chat.available_reactions.length, 2);
});

test("getAllowedReactions returns nothing when the chat forbids reactions", async () => {
  const env = { KV: fakeKv() };
  const chat = { id: 42, type: "group", available_reactions: [] };
  assert.deepEqual(await getAllowedReactions(env, chat), []);
  assert.equal(await classifyReaction({ KV: fakeKv() }, "Nyra thanks", []), null);
});

test("a missing available_reactions field means every reaction is allowed", async () => {
  const env = { KV: fakeKv() };
  const chat = { id: 42, type: "group" };
  assert.deepEqual(await getAllowedReactions(env, chat), REACTION_LABELS.map((label) => DEFAULT_REACTIONS[label]));
});

test("getAllowedReactions is unrestricted when the Telegram set is unknown", async () => {
  // No TELEGRAM_BOT_TOKEN, so getChat cannot be called: impose no limit rather
  // than silently disabling reactions.
  const allowed = await getAllowedReactions({ KV: fakeKv() }, 999);
  assert.equal(allowed.length, REACTION_LABELS.length);
});

test("getAllowedReactions uses the cached Telegram set for a bare chat id", async () => {
  const cached = JSON.stringify({ emoji: ["👍", "😎"] });
  const env = { KV: fakeKv({ "react:chat:42": cached }) };
  assert.deepEqual(await getAllowedReactions(env, 42), ["👍", "😎"]);
});
