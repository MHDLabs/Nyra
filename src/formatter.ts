// Nyra — Telegram rendering facade.
//
// The bot renders Markdown → Telegram MarkdownV2. The conversion, the escaping
// and the length guarantee all live in `markdown.js`; this module is the small
// API the rest of the codebase calls, and it exists so call sites never build
// parse_mode payloads by hand.
//
// The one invariant every export upholds: whatever it returns is a message
// Telegram will accept. A returned `{ text, parseMode }` is always inside
// MAX_TELEGRAM_LENGTH, and a returned MarkdownV2 string is always balanced.
import { MAX_TELEGRAM_LENGTH } from "./config.js";
import {
  markdownToMdv2,
  stripMarkdown,
  splitMarkdownV2,
  mdv2ToPlain,
  escapeNormal,
  escapeCode
} from "./markdown.js";

/** Length of the longest string Telegram accepts in one message. */
export const TELEGRAM_TEXT_LIMIT = MAX_TELEGRAM_LENGTH;

export type TelegramParseMode = "MarkdownV2" | "HTML" | "Markdown" | null;

export type FormattedChunk = {
  text: string;
  parseMode: TelegramParseMode;
};

export type SafeFormatResult = {
  text: string;
  parseMode: TelegramParseMode;
  chunked: boolean;
  chunks: FormattedChunk[] | null;
};

/** Markdown table → monospace box-drawing `pre` block (Telegram has no table entity). */
export function formatTable(rows: ReadonlyArray<ReadonlyArray<unknown>> | null | undefined): string {
  if (!rows || rows.length === 0) return "";
  const header =
    "| " + rows[0].map(function (c) { return String(c || ""); }).join(" | ") + " |";
  const sep = "| " + rows[0].map(function () { return "---"; }).join(" | ") + " |";
  const body = rows
    .slice(1)
    .map(function (row) {
      return "| " + row.map(function (c) { return String(c || ""); }).join(" | ") + " |";
    })
    .join("\n");
  return markdownToMdv2([header, sep, body].filter(Boolean).join("\n"));
}

export function formatList(
  items: ReadonlyArray<unknown> | null | undefined,
  numbered = false
): string {
  if (!items || items.length === 0) return "";
  return items
    .map(function (item, i) {
      return (numbered ? i + 1 + "\\." : "•") + " " + markdownToMdv2(String(item));
    })
    .join("\n");
}

/** Fenced code block. The language tag must be a bare identifier for Telegram. */
export function formatCodeBlock(code: unknown, language = ""): string {
  const lang = /^[A-Za-z0-9_+#.-]+$/.test(String(language || "")) ? language : "";
  return (
    "```" +
    lang +
    "\n" +
    escapeCode(String(code == null ? "" : code).replace(/\s+$/, "")) +
    "\n```"
  );
}

/**
 * Quote block. MarkdownV2 has no expandable-quote entity — `<blockquote>` is
 * HTML-mode syntax and Telegram rejects the `>` under MarkdownV2 with
 * "Character '>' is reserved" (verified against the live API). So this emits
 * the MarkdownV2 quote form, where each line starts with `>`.
 * `expandable` is accepted and ignored to keep the old call signature working.
 */
export function formatExpandableQuote(text: unknown, _expandable?: boolean): string {
  const inner = markdownToMdv2(String(text == null ? "" : text));
  return inner
    .split("\n")
    .map(function (line) {
      return line ? "> " + line : ">";
    })
    .join("\n");
}

/** Escape a plain string so it can be embedded in a MarkdownV2 message. */
export function escapeMarkdownV2(text: unknown): string {
  return escapeNormal(String(text == null ? "" : text));
}

/**
 * Markdown source → MarkdownV2. Kept under its historic name because the AI
 * turn is the only caller; it is a full conversion, not a regex pass.
 */
export function enhanceFormatting(text: unknown): string {
  return markdownToMdv2(String(text == null ? "" : text));
}

/** Plain, readable text from Markdown (no entities, no backslashes). */
export function plainText(text: unknown): string {
  return stripMarkdown(String(text == null ? "" : text));
}

/**
 * Render Markdown for a single Telegram message.
 * Returns { text, parseMode, chunked, chunks }. `text` ALWAYS fits
 * MAX_TELEGRAM_LENGTH; when the source does not, `chunks` holds every part and
 * `chunked` is true so the caller can send them in order instead of dropping
 * the tail.
 */
export function safeFormat(text: unknown, parseMode: string = "MarkdownV2"): SafeFormatResult {
  const src = text == null ? "" : String(text);
  if (parseMode !== "MarkdownV2") {
    return { text: src, parseMode: null, chunked: false, chunks: null };
  }
  const chunks = splitMarkdownV2(src, MAX_TELEGRAM_LENGTH) as FormattedChunk[];
  if (chunks.length === 1) {
    return {
      text: chunks[0].text,
      parseMode: chunks[0].parseMode,
      chunked: false,
      chunks: null
    };
  }
  let head = chunks[0].text;
  let mode: TelegramParseMode = chunks[0].parseMode;
  const ellipsis = "…";
  if (head.length + ellipsis.length > MAX_TELEGRAM_LENGTH) {
    head = mdv2ToPlain(head).slice(0, MAX_TELEGRAM_LENGTH - ellipsis.length);
    mode = null;
  }
  return { text: head + ellipsis, parseMode: mode, chunked: true, chunks: chunks };
}

/**
 * Render Markdown as an ordered list of fitting messages. Each entry is
 * { text, parseMode } and every `text` is guaranteed <= MAX_TELEGRAM_LENGTH, so
 * the caller can hand them straight to Telegram without re-checking anything.
 */
export function safeFormatChunks(text: unknown, parseMode: string = "MarkdownV2"): FormattedChunk[] {
  const src = text == null ? "" : String(text);
  if (parseMode !== "MarkdownV2") return splitPlainChunks(src, MAX_TELEGRAM_LENGTH);
  return splitMarkdownV2(src, MAX_TELEGRAM_LENGTH) as FormattedChunk[];
}

/**
 * Render Markdown as plain, unformatted messages. Used when a MarkdownV2
 * payload is refused by Telegram, so the reply still arrives readable.
 */
export function plainTextChunks(text: unknown, maxLen: number = MAX_TELEGRAM_LENGTH): FormattedChunk[] {
  return splitPlainChunks(text, maxLen);
}

/** Hard split for text with no entity semantics. Applies the same counter. */
export function splitPlainChunks(text: unknown, maxLen: number = MAX_TELEGRAM_LENGTH): FormattedChunk[] {
  const src = text == null ? "" : String(text);
  const limit = Math.max(64, Number(maxLen) || MAX_TELEGRAM_LENGTH);
  const body = Math.max(1, limit - 20);
  if (src.length <= limit) return [{ text: src, parseMode: null }];
  const parts: string[] = [];
  let remaining = src;
  while (remaining.length > body) {
    let cut = remaining.lastIndexOf("\n\n", body);
    if (cut < body * 0.5) cut = remaining.lastIndexOf("\n", body);
    if (cut < body * 0.5) cut = remaining.lastIndexOf(" ", body);
    if (cut < body * 0.5) cut = body;
    const take = remaining[cut] === "\n" ? cut + 1 : cut;
    parts.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  if (remaining.length) parts.push(remaining);
  const total = parts.length;
  const prefixWidth = 2 * String(total).length + 4;
  const fits = parts.every(function (p) {
    return p.length + prefixWidth <= limit;
  });
  return parts.map(function (p, i) {
    return {
      text: fits ? "[" + (i + 1) + "/" + total + "]\n" + p : p,
      parseMode: null
    };
  });
}
