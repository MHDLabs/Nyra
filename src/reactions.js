// Workers AI reaction classification
import { checkRateLimit, escapeHtml } from "./utils.js";
import { tg } from "./telegram.js";

const REACTION_TIMEOUT_MS = 4000; // 4s deadline
const REACTION_RATE_LIMIT_PER_MIN = 20;

// Emoji mapping for sentiment classification
const EMOJI_MAP = {
  "positive": "👍",
  "very_positive": "❤️",
  "negative": "👎",
  "very_negative": "😢",
  "neutral": "🤔",
  "funny": "😄",
  "angry": "😠",
  "surprised": "😮",
  "question": "❓"
};

/**
 * Classify message sentiment using Workers AI
 * Returns emoji or null on failure
 */
export async function classifyReaction(env, text) {
  if (!env.AI) {
    console.warn("Workers AI binding not available");
    return null;
  }

  if (!text || text.length < 3) return null;

  try {
    // Use @cf/huggingface/distilbert-sst-2-int8 for sentiment
    // or @cf/meta/llama-2-7b-chat-int8 for more nuanced classification
    const inputs = {
      text: text.substring(0, 500) // Limit input length
    };

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), REACTION_TIMEOUT_MS);
    });

    const aiPromise = env.AI.run("@cf/huggingface/distilbert-sst-2-int8", inputs);
    
    const result = await Promise.race([aiPromise, timeoutPromise]);

    if (!result || !Array.isArray(result) || result.length === 0) {
      return null;
    }

    // result format: [{ label: "POSITIVE" | "NEGATIVE", score: 0.9 }]
    const topLabel = result[0];
    if (!topLabel || !topLabel.label) return null;

    const label = topLabel.label.toLowerCase();
    const score = topLabel.score || 0;

    // Map to emoji
    if (label === "positive" && score > 0.9) return EMOJI_MAP.very_positive;
    if (label === "positive") return EMOJI_MAP.positive;
    if (label === "negative" && score > 0.9) return EMOJI_MAP.very_negative;
    if (label === "negative") return EMOJI_MAP.negative;

    return EMOJI_MAP.neutral;
  } catch (err) {
    if (err.message !== "timeout") {
      console.error("Workers AI reaction failed:", err.message);
    }
    return null;
  }
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
 * Check if message should trigger reaction
 * Only react in groups, not in private chats
 */
export function shouldReact(message, isGroup) {
  if (!isGroup) return false;
  if (!message.text && !message.caption) return false;
  
  const text = message.text || message.caption || "";
  if (text.length < 10) return false; // Too short to classify meaningfully
  
  return true;
}
