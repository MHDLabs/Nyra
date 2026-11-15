import { MAX_MEMORY_ENTRY_LENGTH } from "../config.js";

export function sanitizeMemoryString(s: unknown): string {
  if (s === undefined || s === null) return "";
  let str = String(s).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (str.length > MAX_MEMORY_ENTRY_LENGTH) str = str.slice(0, MAX_MEMORY_ENTRY_LENGTH - 3) + "...";
  return str;
}

export function sanitizeMemoryFact(fact: unknown): string {
  const s = sanitizeMemoryString(fact);
  if (!s) return "";
  const lower = s.toLowerCase();
  const badPatterns = [
    "ignore previous",
    "ignore above",
    "ignore all prior",
    "ignore all previous",
    "system:",
    "assistant:",
    "new directive",
    "<|",
    "### instruction",
    "###instruction",
    "disregard previous",
    "forget your instructions"
  ];
  for (let i = 0; i < badPatterns.length; i++) {
    if (lower.indexOf(badPatterns[i]!) !== -1) return "";
  }
  return s;
}

export function dedupeArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const str = String(arr[i]).trim();
    const key = str.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(str);
    }
  }
  return result;
}

export function filterSubstrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const a = String(arr[i]);
    const al = a.toLowerCase().trim();
    if (!al) continue;
    let dominated = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const b = String(arr[j]);
      const bl = b.toLowerCase().trim();
      if (bl === al) continue;
      if (bl.length < al.length + 20) continue;
      const idx = bl.indexOf(al);
      if (idx === -1) continue;
      const beforeOk = idx === 0 || /[\s,.;:!?\-]/.test(bl[idx - 1]!);
      const afterIdx = idx + al.length;
      const afterOk = afterIdx >= bl.length || /[\s,.;:!?\-]/.test(bl[afterIdx]!);
      if (beforeOk && afterOk) {
        dominated = true;
        break;
      }
    }
    if (!dominated) result.push(a);
  }
  return result;
}
