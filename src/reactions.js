// Nyra — cosmetic reaction classifier.
//
// Optional and fire-and-forget: when someone names Nyra in a group, the bot may
// attach a single emoji reaction. Classification must therefore be cheap, must
// never block the real reply, and must degrade to "no reaction" on any failure.
//
// Two hard-won constraints shape this module:
//
// 1. Telegram only accepts reactions from a fixed emoji set; anything else is
//    rejected with 400 REACTION_INVALID. TELEGRAM_ALLOWED_REACTIONS mirrors that
//    set, and nothing reaches `setMessageReaction` without passing through it —
//    not model output, not the heuristic, not admin configuration.
//
// 2. A binary sentiment model must NEVER sit in the fallback path. An earlier
//    version fell back to @cf/huggingface/distilbert-sst-2-int8, which is
//    English-only: on Persian text it answers NEGATIVE at high confidence for
//    almost everything, so every message naming Nyra got the same 👎. When the
//    label model produces nothing usable, the correct answer is no reaction.
//
// Allowed-reaction resolution has two layers, most specific first: an
// admin-configured global list, else the built-in defaults — and regardless of
// layer, an emoji Telegram has already refused in a given chat is remembered and
// skipped for that chat.
import { checkRateLimit, containsNyraWord } from "./utils.js";
import { tg } from "./telegram.js";
const REACTION_TIMEOUT_MS = 4000; // 4s deadline per AI call
const REACTION_RATE_LIMIT_PER_MIN = 20;
const REJECT_CACHE_TTL_S = 3600; // remember a chat's rejected emoji for an hour
const LAST_REACTION_TTL_S = 300; // anti-repeat window per chat
const CLASSIFY_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/**
 * Every emoji Telegram accepts as a message reaction, in one place so the gate
 * in `isTelegramReaction` cannot drift from the documented set.
 * Ref: Bot API ReactionTypeEmoji.
 */
export const TELEGRAM_ALLOWED_REACTIONS = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉",
  "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥",
  "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋",
  "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝",
  "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷", "🤷‍♂", "🤷‍♀", "😡"
];

/**
 * Default label -> emoji map. Every emoji here is in TELEGRAM_ALLOWED_REACTIONS,
 * so nothing in this map can be refused as REACTION_INVALID. The previous map
 * used 😄, 😮 and ❓, none of which Telegram accepts, so those three labels were
 * unreachable no matter how well the model classified them.
 */
export const DEFAULT_REACTIONS = {
  "very_positive": "❤",
  "positive": "👍",
  "funny": "🤣",
  "surprised": "🤯",
  "question": "🤔",
  "neutral": "😎",
  "angry": "😡",
  "negative": "👎",
  "very_negative": "😢"
};

/** Labels, in the order the classifier is asked to choose from. */
export const REACTION_LABELS = Object.keys(DEFAULT_REACTIONS);

/**
 * Per-label alternates, used only to break an immediate repeat so the bot does
 * not stamp an identical reaction on consecutive messages.
 */
const LABEL_ALTERNATES = {
  "very_positive": ["🥰", "😍"],
  "positive": ["👏", "🤝"],
  "funny": ["😁", "😈"],
  "surprised": ["😱", "🤯"],
  "question": ["🤨"],
  "neutral": ["😐", "🙈"],
  "angry": ["🤬"],
  "negative": ["💔"],
  "very_negative": ["😭"]
};

const CLASSIFY_SYSTEM_PROMPT = [
  "You label one chat message so a bot can pick a single emoji reaction.",
  "The message may be in any language, including Persian/Farsi, English, or a mix.",
  "Judge the intent of the message, not the language it is written in.",
  "Answer with EXACTLY ONE word from this list and nothing else:",
  "very_positive, positive, funny, surprised, question, neutral, angry, negative, very_negative.",
  "very_positive = love or warm praise; positive = approval or thanks;",
  "funny = joke or light teasing; surprised = astonishment;",
  "question = the message asks something; neutral = plain statement;",
  "angry = hostility or insult; negative = displeasure or complaint;",
  "very_negative = grief or strong hurt.",
  "If the message does not clearly fit one label, answer neutral."
].join(" ");

/** True when Telegram accepts this emoji as a reaction. */
export function isTelegramReaction(emoji) {
  return TELEGRAM_ALLOWED_REACTIONS.indexOf(String(emoji || "")) !== -1;
}

/**
 * Normalize an emoji to the exact form Telegram accepts, or null when it is not
 * a valid reaction. Strips the variation selector U+FE0F (Telegram's set lists
 * "❤", not "❤️") while leaving ZWJ sequences such as "❤‍🔥" intact.
 */
export function normalizeReactionEmoji(value) {
  if (!value) return null;
  const raw = String(value).replace(/\uFE0F/g, "").trim();
  if (!raw) return null;
  if (isTelegramReaction(raw)) return raw;
  for (let i = 0; i < TELEGRAM_ALLOWED_REACTIONS.length; i++) {
    if (TELEGRAM_ALLOWED_REACTIONS[i].replace(/\uFE0F/g, "") === raw) return TELEGRAM_ALLOWED_REACTIONS[i];
  }
  return null;
}

/**
 * Parse an admin-configured reaction list (an array, or a comma/space separated
 * string) into de-duplicated, Telegram-valid emoji. Invalid entries are dropped
 * and counted so the caller can report what was ignored.
 */
export function parseReactions(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? "" : input).split(/[\s,]+/);
  const allowed = [];
  let ignored = 0;
  for (let i = 0; i < raw.length; i++) {
    const token = String(raw[i] == null ? "" : raw[i]).trim();
    if (!token) continue;
    const emoji = normalizeReactionEmoji(token);
    if (!emoji) { ignored++; continue; }
    if (allowed.indexOf(emoji) === -1) allowed.push(emoji);
  }
  return { allowed: allowed, ignored: ignored };
}

const ALLOWED_KEY = "react:allowed";

/** Read the admin-configured allowlist from KV, or null when none is set. */
export async function getConfiguredReactions(env) {
  if (!env || !env.KV || typeof env.KV.get !== "function") return null;
  try {
    const stored = await env.KV.get(ALLOWED_KEY, "json");
    if (!stored) return null;
    const parsed = parseReactions(stored.emoji !== undefined ? stored.emoji : stored).allowed;
    return parsed.length ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * Store the admin-configured allowlist. Invalid emoji are dropped and reported,
 * and an empty selection clears the override (falling back to the defaults)
 * rather than disabling reactions entirely — use an explicit empty list via the
 * API for that.
 */
export async function setConfiguredReactions(env, input) {
  const parsed = parseReactions(input);
  if (!env || !env.KV || typeof env.KV.put !== "function") return parsed;
  if (!parsed.allowed.length) { await clearConfiguredReactions(env); return parsed; }
  await env.KV.put(ALLOWED_KEY, JSON.stringify({ emoji: parsed.allowed }));
  return parsed;
}

/** Remove the admin override so the built-in defaults apply again. */
export async function clearConfiguredReactions(env) {
  if (!env || !env.KV || typeof env.KV.delete !== "function") return;
  try {
    await env.KV.delete(ALLOWED_KEY);
  } catch (err) {
    console.error("Failed to clear reaction allowlist:", err.message);
  }
}

/** Emoji Telegram has already rejected in this chat (remembered for an hour). */
async function readRejectedReactions(env, chatId) {
  if (!env || !env.KV || typeof env.KV.get !== "function") return [];
  try {
    const stored = await env.KV.get("react:reject:" + chatId, "json");
    const list = Array.isArray(stored) ? stored : (stored && Array.isArray(stored.emoji) ? stored.emoji : []);
    return list.map(String);
  } catch (err) {
    return [];
  }
}

/** Remember that Telegram refused `emoji` as a reaction in this chat. */
async function rememberRejectedReaction(env, chatId, emoji) {
  if (!env || !env.KV || typeof env.KV.put !== "function") return;
  try {
    const current = await readRejectedReactions(env, chatId);
    if (current.indexOf(emoji) !== -1) return;
    current.push(emoji);
    await env.KV.put("react:reject:" + chatId, JSON.stringify(current.slice(-40)), { expirationTtl: REJECT_CACHE_TTL_S });
  } catch (err) {
    // Cache maintenance is best-effort.
  }
}

const CHAT_SET_KEY = "react:chat:";
const CHAT_SET_TTL_S = 3600; // Telegram-side reaction set, re-read hourly

/**
 * Emoji from a `available_reactions` array. Entries are ChatReaction:
 * ReactionTypeEmoji carries `emoji`, ReactionTypeCustomEmoji carries only an id
 * and is not usable here, so it is skipped.
 */
function reactionEmojiFromChat(chat) {
  const list = chat && chat.available_reactions;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const emoji = normalizeReactionEmoji(entry && entry.type === "emoji" ? entry.emoji : null);
    if (emoji && out.indexOf(emoji) === -1) out.push(emoji);
  }
  return out;
}

/**
 * Which emoji Telegram itself permits in this chat, via getChat's
 * `available_reactions`, cached for an hour per chat.
 *
 * Returns:
 *   array  — the emoji Telegram allows here (empty = the chat forbids reactions)
 *   null   — unknown (no token, API failure, or network error) → impose no limit
 */
export async function fetchChatReactionSet(env, chatId) {
  if (!env || chatId === undefined || chatId === null) return null;
  if (env.KV && typeof env.KV.get === "function") {
    try {
      const cached = await env.KV.get(CHAT_SET_KEY + chatId, "json");
      if (cached && Array.isArray(cached.emoji)) return cached.emoji.map(String);
    } catch (err) {
      // Fall through and ask Telegram.
    }
  }
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const info = await tg(env, "getChat", { chat_id: chatId });
    if (!info || !info.ok || !info.result) return null;
    // The field is absent in older Bot API versions, which means "all allowed".
    const set = Array.isArray(info.result.available_reactions) ? reactionEmojiFromChat(info.result) : null;
    if (set && env.KV && typeof env.KV.put === "function") {
      try {
        await env.KV.put(CHAT_SET_KEY + chatId, JSON.stringify({ emoji: set }), { expirationTtl: CHAT_SET_TTL_S });
      } catch (err) {
        // Caching is best-effort.
      }
    }
    return set;
  } catch (err) {
    return null;
  }
}

/**
 * The emoji this chat permits, most specific source first: an admin-configured
 * global allowlist, else the built-in defaults — minus any emoji Telegram has
 * already rejected here, and intersected with the emoji Telegram says this chat
 * allows. An empty array means "react with nothing".
 *
 * `chat` may be a Chat/ChatFullInfo object or a bare chat id. Pass the object
 * when available: its `available_reactions` avoids a getChat round trip.
 */
export async function getAllowedReactions(env, chat) {
  const chatId = (chat && typeof chat === "object") ? chat.id : chat;
  const configured = await getConfiguredReactions(env);
  const base = configured || REACTION_LABELS.map(function (label) { return DEFAULT_REACTIONS[label]; });

  const rejected = (chatId === undefined || chatId === null) ? [] : await readRejectedReactions(env, chatId);
  let allowed = base.filter(function (emoji) { return rejected.indexOf(emoji) === -1; });

  // Telegram's own per-chat restriction wins: a chat may forbid reactions
  // entirely, or allow only a handful, and we must stay inside that set.
  const telegramSet = (chat && typeof chat === "object") ? reactionEmojiFromChat(chat)
    : (chatId === undefined || chatId === null ? null : await fetchChatReactionSet(env, chatId));
  if (telegramSet) {
    // Empty array = the chat forbids reactions, so nothing may be applied.
    allowed = allowed.filter(function (emoji) { return telegramSet.indexOf(emoji) !== -1; });
  }
  return allowed;
}

/** Restrict the default label -> emoji map to the emoji allowed in this chat. */
function restrictMapToAllowed(allowed) {
  const out = {};
  for (let i = 0; i < REACTION_LABELS.length; i++) {
    const label = REACTION_LABELS[i];
    if (allowed.indexOf(DEFAULT_REACTIONS[label]) !== -1) out[label] = DEFAULT_REACTIONS[label];
  }
  return out;
}

/** The label a default-reaction emoji belongs to (for anti-repeat lookups). */
function labelForEmoji(emoji) {
  for (let i = 0; i < REACTION_LABELS.length; i++) {
    if (DEFAULT_REACTIONS[REACTION_LABELS[i]] === emoji) return REACTION_LABELS[i];
  }
  return null;
}

/**
 * Swap in a different emoji for the same label when this chat just saw it, so
 * the bot does not repeat itself. Returns the original when there is no allowed
 * alternate.
 */
async function avoidRepeatedReaction(env, chatId, label, emoji, allowed) {
  if (!env || !env.KV || typeof env.KV.get !== "function" || typeof env.KV.put !== "function") return emoji;
  if (chatId === undefined || chatId === null) return emoji;
  try {
    const key = "react:last:" + chatId;
    const previous = await env.KV.get(key);
    if (previous && previous === emoji) {
      const alternates = (label && LABEL_ALTERNATES[label]) || [];
      for (let i = 0; i < alternates.length; i++) {
        if (allowed.indexOf(alternates[i]) !== -1) { emoji = alternates[i]; break; }
      }
    }
    await env.KV.put(key, emoji, { expirationTtl: LAST_REACTION_TTL_S });
  } catch (err) {
    // Anti-repeat is cosmetic; never fail the reaction over it.
  }
  return emoji;
}

/**
 * Classify a message and return one allowed emoji, or null when nothing fits.
 *
 * There is deliberately no sentiment fallback. A binary sentiment model is
 * English-only and answered NEGATIVE for nearly every Persian message, which is
 * what made the bot react 👎 to everything. If the label model yields nothing
 * usable, only the narrow heuristic is tried, and failing that: no reaction.
 */
export async function classifyReaction(env, text, allowed) {
  if (!env.AI) {
    console.warn("Workers AI binding not available");
    return null;
  }
  if (!text || text.length < 3) return null;
  const sample = text.substring(0, 500); // Limit input length

  // An explicit array is authoritative; an empty one means "nothing allowed".
  const whitelist = Array.isArray(allowed) ? allowed : await getAllowedReactions(env, null);
  const map = restrictMapToAllowed(whitelist);
  // Every label's emoji is unavailable in this chat: nothing may be applied.
  if (Object.keys(map).length === 0) return null;

  let label = null;
  try {
    const result = await withTimeout(env.AI.run(CLASSIFY_MODEL, {
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: "Message:\n\"\"\"" + sample + "\"\"\"\nLabel:" }
      ],
      max_tokens: 8,
      temperature: 0
    }), REACTION_TIMEOUT_MS);
    label = pickLabel(result);
  } catch (err) {
    if (err.message !== "timeout") console.error("Workers AI reaction labels failed:", err.message);
  }

  if (!label) label = heuristicReaction(sample);
  if (!label) return null;
  // A label whose emoji this chat forbids is a legitimate "no reaction".
  return map[label] || null;
}

/**
 * Map a raw model result to one of REACTION_LABELS, or null. Pure — exported so
 * it is testable without Workers AI. Accepts every shape the AI binding returns:
 *   { response: "very_positive" }        (instruct / text generation)
 *   [{ label: "POSITIVE", score: 0.98 }] (text classification)
 *   { label: "positive", score: 0.4 }    (classification fallback)
 */
export function pickLabel(result) {
  // Instruct / text-generation shape: { response: "very_positive" }
  if (result && typeof result === "object" && typeof result.response === "string") {
    const label = normalizeLabel(result.response);
    if (label) return label;
  }
  // Classification shapes: [{ label, score }] or { label, score }.
  const entry = Array.isArray(result) ? result[0] : (result && result.label ? result : null);
  if (entry && entry.label) {
    // A label we recognise already states its own intensity, so it is
    // authoritative: "very_positive" must not be flattened to "positive".
    const named = normalizeLabel(entry.label);
    if (named) return named;
    // Only reached if a binary sentiment model is ever used again: those know
    // just positive/negative, so the score has to supply the intensity.
    const raw = String(entry.label).toLowerCase();
    const score = Number(entry.score) || 0;
    if (raw === "positive" || raw === "label_1") return score > 0.9 ? "very_positive" : "positive";
    if (raw === "negative" || raw === "label_0") return score > 0.9 ? "very_negative" : "negative";
  }
  return null;
}

/**
 * Convenience wrapper: model result -> default emoji, falling back to the
 * heuristic. New code should prefer `classifyReaction`, which also applies the
 * chat's allowed-reaction list.
 */
export function pickReaction(result, text) {
  const label = pickLabel(result);
  if (label) return DEFAULT_REACTIONS[label];
  const heuristic = heuristicReaction(text);
  return heuristic ? DEFAULT_REACTIONS[heuristic] : null;
}

/**
 * Normalize free-form model output to one of REACTION_LABELS. Longest-first so
 * "very_positive" is not shadowed by "positive".
 *
 * Punctuation and whitespace become separators, and the whole cleaned phrase is
 * also offered underscore-joined as a candidate. Without that second candidate,
 * "very_positive" splits into ["very", "positive"] and silently degrades to
 * "positive" — the exact intensity distinction this label set exists to make.
 */
export function normalizeLabel(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!cleaned) return null;
  const candidates = [cleaned.replace(/ /g, "_")].concat(cleaned.split(" "));
  const ordered = REACTION_LABELS.slice().sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < ordered.length; i++) {
    if (candidates.indexOf(ordered[i]) !== -1) return ordered[i];
  }
  return null;
}

/**
 * Deterministic last resort. Deliberately narrow: it only fires when the text is
 * unambiguous, otherwise returns null (= no reaction) rather than guessing. A
 * wrong emoji is worse than none, and this is the only fallback — a sentiment
 * model used to sit here and labelled nearly every Persian message NEGATIVE.
 */
export function heuristicReaction(text) {
  const s = String(text || "");
  if (s.indexOf("?") !== -1 || s.indexOf("؟") !== -1) return "question";
  if (/(خخ+|ههه+|haha|hehe|lol|lmao)/i.test(s)) return "funny";
  return null;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error("timeout")); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Attempt to set a reaction on a message.
 * Independent execution — failure must not block the main response.
 *
 * `chat` is the Chat object; its id drives rate limiting and the per-chat
 * allowed/rejected reaction bookkeeping.
 */
export async function trySetReaction(env, ctx, chat, messageId, text) {
  const chatId = (chat && typeof chat === "object") ? chat.id : chat;
  if (chatId === undefined || chatId === null) return;

  // Must be in background - never block main response
  const promise = (async () => {
    try {
      // Rate limit check
      const rateKey = "reaction:" + chatId;
      const rateOk = await checkRateLimit(env, rateKey, REACTION_RATE_LIMIT_PER_MIN, 60);
      if (!rateOk) {
        console.log("Reaction rate limit hit for chat", chatId);
        return;
      }

      // Classify against what this chat allows; null means "no reaction at all".
      // The Chat object is preferred over the bare id: its available_reactions
      // avoids a getChat round trip on the hot path.
      const allowed = await getAllowedReactions(env, chat);
      let emoji = await classifyReaction(env, text, allowed);
      if (!emoji) return;

      emoji = await avoidRepeatedReaction(env, chatId, labelForEmoji(emoji), emoji, allowed);
      // Final gate: only a Telegram-valid emoji may reach the API.
      if (!isTelegramReaction(emoji)) return;

      // Set reaction via Bot API
      const result = await tg(env, "setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: emoji }],
        is_big: false
      });

      if (!result || !result.ok) {
        const description = (result && result.description) ? String(result.description) : "unknown";
        // Telegram itself refused this emoji for this chat: remember it so the
        // same emoji is never attempted here again.
        if (description.indexOf("REACTION_INVALID") !== -1) {
          await rememberRejectedReaction(env, chatId, emoji);
        }
        console.log("Failed to set reaction:", description);
      }
    } catch (err) {
      // Silent fail - reactions are optional
      console.error("Reaction execution failed:", err.message);
    }
  })();

  // Fire and forget
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(promise);
  }
}

/**
 * The text a message contributes to classification, including a quoted reply.
 * Short replies carry their meaning in the quoted message, so including it keeps
 * the label accurate for things like a bare "چرا؟" answering a question.
 */
export function extractMessageText(message) {
  if (!message) return "";
  const own = ((message.text || message.caption || "") + "").trim();
  const quoted = message.reply_to_message ? ((message.reply_to_message.text || message.reply_to_message.caption || "") + "").trim() : "";
  if (!quoted) return own;
  return own ? own + "\n" + quoted : quoted;
}

/** True when the chat is a group or supergroup (accepts a boolean too). */
export function isGroupChat(chat) {
  if (chat === true) return true;
  if (!chat || typeof chat !== "object") return false;
  return chat.type === "group" || chat.type === "supergroup";
}

/**
 * Check if a message should trigger a reaction.
 *
 * Groups only, and strictly only when the message actually addresses Nyra by
 * name (Nyra / نیرا / نيرا). Without this the bot reacted to every message in a
 * busy group, which was an earlier reported bug. A chat that forbids reactions
 * (`available_reactions` present but empty) is skipped as well.
 */
export function shouldReact(message, chat) {
  if (!isGroupChat(chat)) return false;
  if (chat && typeof chat === "object" && Array.isArray(chat.available_reactions) && chat.available_reactions.length === 0) return false;
  const text = extractMessageText(message);
  if (!text) return false;
  if (text.length < 3) return false; // Nothing meaningful to classify
  return containsNyraWord(text);
}
