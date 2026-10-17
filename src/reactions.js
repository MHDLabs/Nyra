// Nyra — cosmetic reaction classifier.
//
// Optional and fire-and-forget: when someone names Nyra in a group, the bot may
// attach a single emoji reaction. Classification must therefore be cheap, must
// never block the real reply, and must degrade to "no reaction" on any failure.
//
// The previous implementation used a 2-label sentiment model
// (@cf/huggingface/distilbert-sst-2-int8 → POSITIVE/NEGATIVE), so the only
// reachable emojis were 👍❤️👎😢🤔: neutral/funny/angry/surprised/question were
// dead code and every question got a thumbs-up. This asks a small instruct
// model for one of nine labels and falls back to sentiment only if that fails.
import { checkRateLimit, containsNyraWord } from "./utils.js";
import { tg } from "./telegram.js";

const REACTION_TIMEOUT_MS = 4000; // 4s deadline per AI call
const REACTION_RATE_LIMIT_PER_MIN = 20;
const CLASSIFY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SENTIMENT_MODEL = "@cf/huggingface/distilbert-sst-2-int8";

// Every label here has an emoji, and every emoji is reachable.
const EMOJI_MAP = {
  "very_positive": "❤️",
  "positive": "👍",
  "funny": "😄",
  "surprised": "😮",
  "question": "❓",
  "neutral": "🤔",
  "angry": "😠",
  "negative": "👎",
  "very_negative": "😢"
};

const LABELS = Object.keys(EMOJI_MAP);

const CLASSIFY_SYSTEM_PROMPT = [
  "You label one chat message so a bot can pick a single emoji reaction.",
  "Answer with EXACTLY ONE word from this list and nothing else:",
  "very_positive, positive, funny, surprised, question, neutral, angry, negative, very_negative.",
  "very_positive = love or warm praise; positive = approval or thanks;",
  "funny = joke or light teasing; surprised = astonishment;",
  "question = the message asks something; neutral = plain statement;",
  "angry = hostility or insult; negative = displeasure or complaint;",
  "very_negative = grief or strong hurt."
].join(" ");

/**
 * Classify a message and return an emoji, or null when nothing fits.
 * Falls back to binary sentiment if the label model is unavailable.
 */
export async function classifyReaction(env, text) {
  if (!env.AI) {
    console.warn("Workers AI binding not available");
    return null;
  }

  if (!text || text.length < 3) return null;
  const sample = text.substring(0, 500); // Limit input length

  // Preferred path: one of nine labels, so the whole EMOJI_MAP is usable.
  try {
    const result = await withTimeout(env.AI.run(CLASSIFY_MODEL, {
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: "Message:\n\"\"\"" + sample + "\"\"\"\nLabel:" }
      ],
      max_tokens: 8,
      temperature: 0
    }), REACTION_TIMEOUT_MS);
    const emoji = pickReaction(result, sample);
    if (emoji) return emoji;
  } catch (err) {
    if (err.message !== "timeout") console.error("Workers AI reaction labels failed:", err.message);
  }

  // Fallback: binary sentiment, normalized through the same mapper.
  try {
    const result = await withTimeout(env.AI.run(SENTIMENT_MODEL, { text: sample }), REACTION_TIMEOUT_MS);
    return pickReaction(result, sample);
  } catch (err) {
    if (err.message !== "timeout") console.error("Workers AI reaction sentiment failed:", err.message);
    return null;
  }
}

/**
 * Map a raw model result to an emoji. Pure — exported so it is testable without
 * Workers AI. Accepts every shape the AI binding can return:
 *   { response: "very_positive" }        (instruct / text generation)
 *   [{ label: "POSITIVE", score: 0.98 }] (text classification)
 *   { label: "positive", score: 0.4 }    (classification fallback)
 */
export function pickReaction(result, text) {
  // Instruct / text-generation shape: { response: "very_positive" }
  if (result && typeof result === "object" && typeof result.response === "string") {
    const label = normalizeLabel(result.response);
    if (label) return EMOJI_MAP[label];
  }
  // Classification shapes: [{ label, score }] or { label, score }.
  const entry = Array.isArray(result) ? result[0] : (result && result.label ? result : null);
  if (entry && entry.label) {
    const raw = String(entry.label).toLowerCase();
    const score = Number(entry.score) || 0;
    // Binary sentiment models only know positive/negative, so they carry no
    // intensity in the label — the score has to supply it. Checked before the
    // generic mapping so "positive" + 0.98 still becomes ❤️ rather than 👍.
    if (raw === "positive") return score > 0.9 ? EMOJI_MAP.very_positive : EMOJI_MAP.positive;
    if (raw === "negative") return score > 0.9 ? EMOJI_MAP.very_negative : EMOJI_MAP.negative;
    // Any other label that names one of ours is authoritative: it already states
    // the intensity, so "very_positive" must not be reduced to "positive".
    const named = normalizeLabel(raw);
    if (named) return EMOJI_MAP[named];
  }
  return heuristicReaction(text);
}

/**
 * Normalize free-form model output to one of LABELS. Longest-first so
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
  const ordered = LABELS.slice().sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < ordered.length; i++) {
    if (candidates.indexOf(ordered[i]) !== -1) return ordered[i];
  }
  return null;
}

/**
 * Deterministic last resort. Deliberately narrow: it only fires when the text
 * is unambiguous, otherwise returns null (= no reaction) rather than guessing.
 * A wrong emoji is worse than none.
 */
export function heuristicReaction(text) {
  const s = String(text || "");
  if (s.indexOf("?") !== -1 || s.indexOf("؟") !== -1) return EMOJI_MAP.question;
  if (/(خخ+|ههه+|haha|hehe|lol|lmao)/i.test(s)) return EMOJI_MAP.funny;
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
 * Attempt to set reaction on a message
 * Independent execution - failure must not block main response
 */
export async function trySetReaction(env, ctx, chatId, messageId, text) {
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

      // Classify
      const emoji = await classifyReaction(env, text);
      if (!emoji) return;

      // Set reaction via Bot API
      const result = await tg(env, "setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: emoji }],
        is_big: false
      });

      if (!result || !result.ok) {
        console.log("Failed to set reaction:", result?.description || "unknown");
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
 * Check if message should trigger reaction.
 * Groups only, and strictly only when the message actually addresses Nyra by
 * name (Nyra / نیرا / نيرا). Without this, the bot reacted to every message in
 * a busy group, which is exactly the reported bug.
 */
export function shouldReact(message, isGroup) {
  if (!isGroup) return false;
  const text = ((message.text || message.caption || "") + "").trim();
  if (!text) return false;
  if (text.length < 3) return false; // Nothing meaningful to classify
  return containsNyraWord(text);
}
