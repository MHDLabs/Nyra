import { CALLBACK_ID_MAX } from "../config.js";
import { truncate } from "./text.js";

export function safeCallbackId(id: unknown): string {
  if (!id) return "";
  const s = String(id);
  if (s.length <= CALLBACK_ID_MAX) return s;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return "h" + Math.abs(hash).toString(36) + "_" + s.slice(-8);
}

function isOnlyEmojiOrSymbols(text: string): boolean {
  if (!text) return false;
  const cleaned = String(text).replace(/\s/g, "");
  if (!cleaned) return false;
  return !/[a-zA-Z0-9\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/.test(cleaned);
}

export type UserContentMessage = {
  text?: string;
  caption?: string;
  sticker?: { emoji?: string };
  photo?: readonly unknown[];
  album_photo_file_ids?: readonly string[];
  animation?: unknown;
  video?: unknown;
  voice?: unknown;
  document?: unknown;
  reply_to_message?: {
    text?: string;
    sticker?: { emoji?: string };
  };
};

export function buildUserContent(message: UserContentMessage): string {
  const text = ((message.text || message.caption || "") + "").trim();
  const hasSticker = !!message.sticker;
  const hasPhoto = !!(message.photo && message.photo.length);
  const hasAnimation = !!message.animation;
  const hasVideo = !!message.video;
  const hasVoice = !!message.voice;
  const hasDocument = !!message.document;

  let replyPrefix = "";
  if (message.reply_to_message) {
    const r = message.reply_to_message;
    if (r.sticker) {
      const em = r.sticker.emoji || "";
      replyPrefix = em ? "[replying to sticker: " + em + "] " : "[replying to a sticker] ";
    } else if (r.text) {
      replyPrefix = "[replying to: " + truncate(r.text, 80) + "] ";
    }
  }

  if (hasSticker && !text) {
    const em = message.sticker && message.sticker.emoji ? message.sticker.emoji : "";
    return replyPrefix + (em ? "[sticker: " + em + "]" : "[sticker]");
  }

  const albumCount = Array.isArray(message.album_photo_file_ids)
    ? message.album_photo_file_ids.length
    : 0;
  if (!text) {
    if (hasPhoto) {
      return replyPrefix + (albumCount > 1
        ? "[user sent a photo album with " + albumCount + " images]"
        : "[user sent a photo]");
    }
    if (hasAnimation) return replyPrefix + "[user sent a GIF]";
    if (hasVideo) return replyPrefix + "[user sent a video]";
    if (hasVoice) return replyPrefix + "[user sent a voice message]";
    if (hasDocument) return replyPrefix + "[user sent a file]";
    return replyPrefix ? replyPrefix.trim() : "";
  }

  if (isOnlyEmojiOrSymbols(text)) {
    return replyPrefix + "[user sent emoji: " + text + "]";
  }

  return replyPrefix + text + (albumCount > 1 ? " [photo album: " + albumCount + " images]" : "");
}

function rawSplitForTelegram(inputText: string, budget: number): string[] {
  const parts: string[] = [];
  let remaining = inputText;
  while (remaining.length > budget) {
    let splitAt = -1;
    const windowEnd = Math.min(budget, remaining.length);
    for (let i = windowEnd - 2; i >= Math.floor(budget * 0.4); i--) {
      if (remaining[i] === "\n" && remaining[i + 1] === "\n") {
        splitAt = i + 2;
        break;
      }
    }
    if (splitAt === -1) {
      for (let i = windowEnd - 1; i >= Math.floor(budget * 0.4); i--) {
        if (remaining[i] === "\n") {
          splitAt = i + 1;
          break;
        }
      }
    }
    if (splitAt === -1) {
      for (let i = windowEnd - 1; i >= Math.floor(budget * 0.4); i--) {
        if (remaining[i] === " ") {
          splitAt = i + 1;
          break;
        }
      }
    }
    if (splitAt === -1) splitAt = windowEnd;
    const chunk = remaining.slice(0, splitAt);
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      const lastFence = chunk.lastIndexOf("```");
      const afterFence = chunk.slice(lastFence + 3);
      const match = afterFence.match(/^([a-zA-Z0-9_+#.-]+)/);
      const lang = match ? match[1] : "";
      parts.push(chunk + "\n```");
      remaining = "```" + lang + "\n" + remaining.slice(splitAt);
      continue;
    }
    parts.push(chunk);
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) parts.push(remaining);
  const cleaned: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i]!.trim().length > 0) cleaned.push(parts[i]!);
  }
  return cleaned.length > 0 ? cleaned : parts;
}

export function splitForTelegram(inputText: string | null | undefined, maxLen: number): string[] {
  if (!inputText) return [""];
  if (inputText.length <= maxLen) return [inputText];
  const FENCE_RESERVE = 4;
  let counterReserve = 6;
  let parts: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const budget = Math.max(1, maxLen - counterReserve - FENCE_RESERVE);
    parts = rawSplitForTelegram(inputText, budget);
    const needed = 2 * String(parts.length).length + 4;
    if (needed <= counterReserve) break;
    counterReserve = needed;
  }
  const total = parts.length;
  if (total > 1) {
    return parts.map(function (p, i) {
      return "[" + (i + 1) + "/" + total + "]\n" + p;
    });
  }
  return parts;
}
