import { NYRA_VARIANTS } from "../config.js";

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export function escapeHtml(text: unknown): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeRegex(text: unknown): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

export function containsPhrase(haystack: unknown, phrase: unknown): boolean {
  if (!haystack || !phrase) return false;
  const h = String(haystack).toLowerCase();
  const p = String(phrase).toLowerCase();
  if (!p) return false;
  let idx = h.indexOf(p);
  while (idx !== -1) {
    const before = idx > 0 ? h.charAt(idx - 1) : "";
    const after = h.charAt(idx + p.length);
    const beforeOk = !before || !WORD_CHAR_RE.test(before);
    const afterOk = !after || !WORD_CHAR_RE.test(after);
    if (beforeOk && afterOk) return true;
    idx = h.indexOf(p, idx + 1);
  }
  return false;
}

export function stripTelegramHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/<\/?(?:b|i|u|s|code|pre|blockquote|tg-spoiler|a)(?:\s+[^>]*)?>/gi, "");
}

export function containsNyraWord(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/\bnyra\b/i.test(text)) return true;
  for (let i = 0; i < NYRA_VARIANTS.length; i++) {
    if (text.indexOf(NYRA_VARIANTS[i]) !== -1) return true;
  }
  return false;
}
