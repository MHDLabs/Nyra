import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldReact,
  pickReaction,
  pickLabel,
  normalizeLabel,
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

test("normalizeLabel prefers the longest label (very_positive over positive)", () => {
  assert.equal(normalizeLabel("very_positive"), "very_positive");
  assert.equal(normalizeLabel("very_negative"), "very_negative");
  assert.equal(normalizeLabel("POSITIVE"), "positive");
  assert.equal(normalizeLabel("  Question. "), "question");
  assert.equal(normalizeLabel("label: funny"), "funny");
  assert.equal(normalizeLabel("banana"), null);
  assert.equal(normalizeLabel(""), null);
  assert.equal(normalizeLabel(null), null);
});

test("pickLabel maps instruct-model labels", () => {
  assert.equal(pickLabel({ response: "very_positive" }), "very_positive");
  assert.equal(pickLabel({ response: "positive" }), "positive");
  assert.equal(pickLabel({ response: "question" }), "question");
  assert.equal(pickLabel({ response: "angry" }), "angry");
  assert.equal(pickLabel({ response: "no idea" }), null);
});

test("pickLabel maps sentiment scores to intensity", () => {
  assert.equal(pickLabel([{ label: "POSITIVE", score: 0.98 }]), "positive");
  assert.equal(pickLabel([{ label: "POSITIVE", score: 0.4 }]), "positive");
  assert.equal(pickLabel([{ label: "NEGATIVE", score: 0.95 }]), "negative");
  assert.equal(pickLabel([{ label: "NEGATIVE", score: 0.3 }]), "negative");
  assert.equal(pickLabel({ label: "positive", score: 0.2 }), "positive");
  assert.equal(pickLabel(null), null);
  assert.equal(pickLabel({}), null);
});

test("pickReaction maps instruct-model labels to Telegram-valid emoji", () => {
  assert.equal(pickReaction({ response: "very_positive" }, "I love it"), "❤");
  assert.equal(pickReaction({ response: "positive" }, "thanks"), "👍");
  assert.equal(pickReaction({ response: "question" }, "what is this"), "🤔");
  assert.equal(pickReaction({ response: "angry" }, "shut up"), "😡");
});

test("pickReaction falls back to the narrow heuristic, otherwise nothing", () => {
  assert.equal(pickReaction({}, "are you there?"), "🤔");
  assert.equal(pickReaction(null, "hahaha"), "🤣");
  assert.equal(pickReaction(null, "a plain statement"), null);
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

/** AI binding double returning a fixed instruct-model response. */
function fakeAi(label) {
  return { run: async () => ({ response: label }) };
}

function aiEnabledEnv(ai) {
  return { AI: ai, KV: fakeKv(), ADMIN_IDS: "1", DB: { prepare() { return { bind() { return this; }, async first() { return { value: "all" }; } }; } } };
}

test("classifyReaction returns the labelled emoji when it is allowed", async () => {
  const env = aiEnabledEnv(fakeAi("funny"));
  assert.equal(await classifyReaction(env, "Nyra told a great joke", await getAllowedReactions(env, 1)), "🤣");
});

test("classifyReaction returns null when the label's emoji is not allowed", async () => {
  const env = { AI: fakeAi("very_positive"), KV: fakeKv() };
  // ❤ is deliberately excluded from this chat's allowlist.
  assert.equal(await classifyReaction(env, "Nyra I love you", ["👍", "👎"]), null);
});

test("classifyReaction returns null when no reaction fits", async () => {
  const env = aiEnabledEnv({ run: async () => ({ response: "unclear" }) });
  assert.equal(await classifyReaction(env, "Nyra just a plain sentence", await getAllowedReactions(env, 1)), null);
});

test("classifyReaction never uses a sentiment model", async () => {
  const seen = [];
  const env = aiEnabledEnv({ run: async (model) => { seen.push(model); return { response: "neutral" }; } });
  const emoji = await classifyReaction(env, "Nyra سلام خوبی؟", await getAllowedReactions(env, 1));
  assert.equal(emoji, "😎");
  assert.deepEqual(seen, ["@cf/meta/llama-3.1-8b-instruct"]);
});

test("classifyReaction returns null when every emoji is disallowed in the chat", async () => {
  const env = { AI: fakeAi("positive"), KV: fakeKv() };
  assert.equal(await classifyReaction(env, "Nyra thanks", []), null);
});

test("classifyReaction returns null without an AI binding", async () => {
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

test("a custom allowlist simply drops labels it does not cover", async () => {
  const env = { AI: fakeAi("angry"), KV: fakeKv({ "react:allowed": { emoji: ["👍", "❤"] } }) };
  // 😡 is not in the custom set, so this message gets no reaction at all.
  assert.equal(await classifyReaction(env, "Nyra shut up", await getAllowedReactions(env, 1)), null);
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
  assert.equal(await classifyReaction({ AI: fakeAi("positive"), KV: fakeKv() }, "Nyra thanks", []), null);
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
