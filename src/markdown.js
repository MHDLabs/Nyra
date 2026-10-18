// Nyra — Markdown → Telegram MarkdownV2 conversion.
//
// Why this module exists: the model answers in Markdown, but Telegram does NOT
// accept Markdown as a parse_mode. It accepts MarkdownV2, which is a different
// language with one unforgiving rule — every one of its 18 reserved characters
// MUST be backslash-escaped in normal text, and the escape set changes inside
// `code`/`pre` entities (only ` and \ are escaped there). Getting this wrong is
// not cosmetic: the Bot API answers HTTP 400 "can't parse entities" and the
// whole message is dropped. That is how raw Markdown ends up on screen.
//
// So conversion is not a regex substitution. It is a real scan that re-emits
// balanced entities, and it is *total*: an unterminated marker, an empty link
// target or a stray backslash is emitted as literal escaped text rather than
// left dangling. Every string this module returns is valid MarkdownV2.
//
// The module also owns the length guarantee. Telegram rejects any message over
// 4096 characters, and escaping makes text LONGER (one byte per reserved char),
// so splitting before conversion and hoping is not enough. splitMarkdownV2()
// measures the real converted length and only ever returns chunks that fit.

// Telegram's MarkdownV2 reserved set for normal (non-entity) text. Backslash is
// included because it is the escape character itself: an unescaped lone `\`
// would swallow the next character.
const MDV2_RESERVED = "_*[]()~`>#+-=|{}.!\\";
const MDV2_RESERVED_SET = (function () {
  const set = Object.create(null);
  for (let i = 0; i < MDV2_RESERVED.length; i++) set[MDV2_RESERVED[i]] = true;
  return set;
})();

// Escape every reserved character. Safe for any input, including already
// escaped text (a backslash becomes `\\`, which Telegram renders as one).
export function escapeNormal(value) {
  const s = value == null ? "" : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (MDV2_RESERVED_SET[c]) out += "\\";
    out += c;
  }
  return out;
}

// Inside `code` and `pre` only the backtick and the backslash are escaped.
export function escapeCode(value) {
  const s = value == null ? "" : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "`" || c === "\\") out += "\\";
    out += c;
  }
  return out;
}

// Inside the `( )` of a link only the closing paren and the backslash need it.
function escapeUrl(value) {
  const s = value == null ? "" : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ")" || c === "\\") out += "\\";
    out += c;
  }
  return out;
}

export function reservedCount(value) {
  const s = value == null ? "" : String(value);
  let n = 0;
  for (let i = 0; i < s.length; i++) if (MDV2_RESERVED_SET[s[i]]) n++;
  return n;
}

// Cheapest honest upper bound on the converted length of a source string: every
// reserved character can gain at most one escape byte, and entity markers only
// ever shrink. Used to avoid converting text just to measure it.
export function mdv2UpperBound(value) {
  const s = value == null ? "" : String(value);
  return s.length + reservedCount(s);
}

// Strip the escapes from a MarkdownV2 string to get readable plain text. Used
// as the fallback when Telegram refuses an entity, so the reply still arrives
// readable instead of being lost or shown with visible backslashes.
export function mdv2ToPlain(value) {
  const s = value == null ? "" : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    out += c;
  }
  return out;
}

function runLength(s, i, ch) {
  let n = 0;
  while (i + n < s.length && s[i + n] === ch) n++;
  return n;
}

// Find the index of an unescaped closing run of exactly `run` marker characters.
// `run === 1` rejects a position that is part of a longer run, so `*a**` does
// not close a single-asterisk entity on the first asterisk of a double one.
function findClose(s, from, marker, run) {
  const needle = marker.repeat(run);
  let j = from;
  while (j < s.length) {
    const idx = s.indexOf(needle, j);
    if (idx === -1) return -1;
    if (idx > from && s[idx - 1] !== "\\") {
      if (run === 1 && s[idx + 1] === marker) { j = idx + 1; continue; }
      if (idx === from && s[idx + run] === marker) { j = idx + 1; continue; }
      if (idx === from) { j = idx + 1; continue; }
      return idx;
    }
    j = idx + 1;
  }
  return -1;
}

// `[label](target)` with balanced brackets and parens. Returns null unless the
// whole construct is present and the target is non-empty.
function parseLink(s, i) {
  if (s[i] !== "[") return null;
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0 || j >= s.length) return null;
  if (s[j + 1] !== "(") return null;
  let k = j + 2;
  let parens = 1;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "(") parens++;
    else if (c === ")") { parens--; if (parens === 0) break; }
  }
  if (parens !== 0) return null;
  const label = s.slice(i + 1, j);
  const url = s.slice(j + 2, k);
  if (!url || !label) return null;
  return { label: label, url: url, end: k + 1 };
}

// A bare URL becomes an explicit link so it stays clickable after escaping.
const BARE_URL_RE = /^(https?:\/\/[^\s<>"'`]+)/i;
function parseBareUrl(s, i) {
  if (s[i] !== "h" && s[i] !== "H") return null;
  const m = BARE_URL_RE.exec(s.slice(i, i + 2048));
  if (!m) return null;
  let url = m[1].replace(/[.,;:!?)\]]+$/, "");
  if (url.length < 9) return null;
  return { label: url, url: url, end: i + url.length };
}

// Inline pass: emphasis, code spans, links. Recursive so nested emphasis inside
// bold/italic is converted too.
function inlineToMdv2(text) {
  const s = text == null ? "" : String(text);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === "\\" && i + 1 < s.length) { out += escapeNormal(s[i + 1]); i += 2; continue; }

    if (c === "`") {
      const run = runLength(s, i, "`");
      const closer = s.indexOf("`".repeat(run), i + run);
      if (closer !== -1 && closer > i + run) {
        let inner = s.slice(i + run, closer);
        // Markdown trims one leading/trailing space in a code span.
        if (inner.length > 2 && inner[0] === " " && inner[inner.length - 1] === " " && inner.trim()) {
          inner = inner.slice(1, -1);
        }
        out += "`" + escapeCode(inner) + "`";
        i = closer + run;
        continue;
      }
    }

    if (c === "!" && s[i + 1] === "[") {
      const link = parseLink(s, i + 1);
      if (link) { out += "[" + inlineToMdv2(link.label) + "](" + escapeUrl(link.url) + ")"; i = link.end; continue; }
    }
    if (c === "[") {
      const link = parseLink(s, i);
      if (link) { out += "[" + inlineToMdv2(link.label) + "](" + escapeUrl(link.url) + ")"; i = link.end; continue; }
    }
    if (c === "h" || c === "H") {
      const bare = parseBareUrl(s, i);
      if (bare) { out += "[" + escapeNormal(bare.label) + "](" + escapeUrl(bare.url) + ")"; i = bare.end; continue; }
    }

    // Emphasis. Markdown's markers are NOT MarkdownV2's: `*x*` is italic in
    // Markdown but BOLD in MarkdownV2, so the marker has to be re-chosen rather
    // than copied through. Without this, every italic answer renders bold.
    // Output table: `*x*` bold, `_x_` italic, `__x__` underline, `~x~` strike.
    if (c === "*" || c === "_" || c === "~") {
      const openRun = Math.min(runLength(s, i, c), 2);
      const closer = findClose(s, i + openRun, c, openRun);
      if (closer !== -1) {
        const closeRun = Math.min(runLength(s, closer, c), 2);
        const take = Math.min(openRun, closeRun);
        let marker;
        if (c === "~") marker = "~";
        else if (c === "*") marker = take >= 2 ? "*" : "_";
        else marker = take >= 2 ? "__" : "_";
        out += marker + inlineToMdv2(s.slice(i + openRun, closer)) + marker;
        i = closer + closeRun;
        continue;
      }
    }

    if (c === "|" && s[i + 1] === "|") {
      const closer = findClose(s, i + 2, "|", 2);
      if (closer !== -1) {
        out += "||" + inlineToMdv2(s.slice(i + 2, closer)) + "||";
        i = closer + 2;
        continue;
      }
    }

    out += escapeNormal(c);
    i++;
  }
  return out;
}

// A fence opener. The info string is accepted loosely (it may contain spaces and
// punctuation, e.g. ```` ```c++ ````): Telegram only allows a plain identifier as
// a language tag, so anything else is dropped at conversion time. Requiring a
// bare identifier here instead would fail to recognise the fence at all and the
// whole block would be inline-escaped as prose.
const FENCE_RE = /^\s*(`{3,}|~{3,})[ \t]*([^`~]*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^\s{0,3}(?:(?:[-*_])\s*){3,}$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

function splitTableRow(line) {
  let body = line.trim();
  if (body[0] === "|") body = body.slice(1);
  if (body[body.length - 1] === "|") body = body.slice(0, -1);
  return body.split("|").map(function (cell) { return cell.trim(); });
}

// Render collected table rows as one aligned `pre` block. MarkdownV2 has no
// table entity, and letting pipe characters through escaped reads as noise.
function emitTable(rows) {
  const widths = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] || 0, row[i].length);
  }
  const lines = rows.map(function (row) {
    const cells = [];
    for (let i = 0; i < widths.length; i++) cells.push((row[i] || "").padEnd(widths[i], " "));
    return cells.join(" | ").replace(/\s+$/, "");
  });
  return "```\n" + escapeCode(lines.join("\n")) + "\n```";
}

/**
 * Convert Markdown source to valid Telegram MarkdownV2.
 * Total: never throws, always returns a balanced string.
 */
export function markdownToMdv2(value) {
  const src = (value == null ? "" : String(value)).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. The language tag is dropped when it is not a plain
    // identifier, because Telegram only accepts alphanumerics there.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const markerChar = fence[1][0];
      const minLen = fence[1].length;
      const lang = /^[A-Za-z0-9_+#.-]+$/.test(fence[2].trim()) ? fence[2].trim() : "";
      const body = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i];
        if (candidate.length >= minLen && candidate.trim() === markerChar.repeat(candidate.trim().length) && candidate.trim()[0] === markerChar) {
          i++;
          break;
        }
        body.push(candidate);
        i++;
      }
      out.push("```" + lang + "\n" + escapeCode(body.join("\n")) + "\n```");
      continue;
    }

    // Table: a pipe row followed by a separator row.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const rows = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(emitTable(rows));
      continue;
    }

    if (RULE_RE.test(line) && line.trim() !== "") { out.push("\\—\\—\\—"); i++; continue; }

    const heading = HEADING_RE.exec(line);
    if (heading && heading[2]) {
      // A heading is already bold in MarkdownV2, and entities of the same type
      // cannot nest: "# h with **bold**" would emit `*h with *bold**`, where the
      // first `*` closes the heading early and the rest is unparseable (the live
      // API answers "Can't find end of Bold entity"). Bold inside a heading is
      // visually redundant, so its markers are dropped before conversion.
      const text = heading[2].replace(/\*\*([^*\n]+)\*\*/g, "$1");
      out.push("*" + inlineToMdv2(text) + "*");
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        quoted.push(m[1] === "" ? ">" : ">" + inlineToMdv2(m[1]));
        i++;
      }
      out.push(quoted.join("\n"));
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const indent = " ".repeat(Math.min(6, Math.floor(bullet[1].length / 2) * 2));
      out.push(indent + "•" + (bullet[3] ? " " + inlineToMdv2(bullet[3]) : ""));
      i++;
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      const indent = " ".repeat(Math.min(6, Math.floor(ordered[1].length / 2) * 2));
      // The dot after an ordered marker is reserved and must be escaped.
      out.push(indent + ordered[2] + "\\." + (ordered[3] ? " " + inlineToMdv2(ordered[3]) : ""));
      i++;
      continue;
    }

    out.push(inlineToMdv2(line));
    i++;
  }

  return out.join("\n");
}

/**
 * Readable plain text from Markdown source. Used for the streaming preview,
 * for the popup title of an over-long reply and as the last-resort fallback, so
 * the user never sees raw `**` or backticks.
 */
export function stripMarkdown(value) {
  let s = value == null ? "" : String(value);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/```[A-Za-z0-9_+#.-]*\n?([\s\S]*?)```/g, function (m, code) { return code.replace(/\s+$/, ""); });
  s = s.replace(/~~~[A-Za-z0-9_+#.-]*\n?([\s\S]*?)~~~/g, function (m, code) { return code.replace(/\s+$/, ""); });
  s = s.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*([-*+])\s+/gm, "• ");
  s = s.replace(/^\s*(\d{1,9})[.)]\s+/gm, "$1. ");
  s = s.replace(/^\s{0,3}(?:(?:[-*_])\s*){3,}$/gm, "");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, "$1");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");
  s = s.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "$1");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Split Markdown source into chunks that each convert to at most `maxLen`
 * MarkdownV2 characters. The split happens on the SOURCE, never on converted
 * output, so no chunk can contain half an entity — splitting converted text is
 * the classic way to produce "can't parse entities" from a long reply.
 * Every returned chunk is already converted: { text, parseMode }.
 */
export function splitMarkdownV2(value, maxLen) {
  const src = value == null ? "" : String(value);
  const limit = Math.max(64, Number(maxLen) || 4096);
  // Reserved headroom for the "[i/total]\n" counter, which is added AFTER the
  // split (its digit width is only known once the part count is known) and for
  // the byte growth that fence reconstruction and table padding can add.
  const counterReserve = 20;
  const cap = limit - counterReserve;
  if (mdv2UpperBound(src) <= cap) return [{ text: markdownToMdv2(src), parseMode: "MarkdownV2" }];

  const parts = [];
  let remaining = src;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 2000) {
    if (mdv2UpperBound(remaining) <= cap) { parts.push(remaining); break; }
    // Grow the longest prefix whose upper bound still fits.
    let lo = 1;
    let hi = remaining.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (mdv2UpperBound(remaining.slice(0, mid)) <= cap) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    // Back off to a natural boundary when one is close to the cut.
    let cut = best;
    const window = remaining.slice(0, best);
    for (const boundary of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(boundary);
      if (at > best * 0.5) { cut = at + boundary.length; break; }
    }
    if (cut < 1) cut = 1;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (parts.length === 0) parts.push("");

  const converted = parts.map(function (part) {
    const text = markdownToMdv2(part);
    // The upper bound is conservative but not exact (fence reconstruction and
    // table padding add bytes). Verify for real, and degrade to plain text
    // rather than ever handing Telegram an over-long or unbalanced payload.
    if (text.length <= limit - counterReserve) return { text: text, parseMode: "MarkdownV2" };
    const plain = stripMarkdown(part);
    return { text: plain.length > limit - counterReserve ? plain.slice(0, limit - counterReserve) : plain, parseMode: null };
  });

  // The counter prefix is what makes the parts a reader can follow in order;
  // without it a split reply looks like unrelated messages. Add it only when it
  // still leaves every part inside the hard limit, so the guarantee is never
  // traded for the numbering.
  if (converted.length > 1) {
    const total = converted.length;
    const prefixWidth = 2 * String(total).length + 4;
    const fits = converted.every(function (c) { return c.text.length + prefixWidth <= limit; });
    if (fits) {
      return converted.map(function (c, i) { return { text: "[" + (i + 1) + "/" + total + "]\n" + c.text, parseMode: c.parseMode }; });
    }
  }
  return converted;
}
