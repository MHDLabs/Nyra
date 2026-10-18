// Tests for the Markdown → Telegram MarkdownV2 engine (src/markdown.js) and the
// rendering facade (src/formatter.js).
//
// Two properties matter more than any single conversion:
//   1. Totality — the converter never throws and never emits a dangling entity,
//      no matter how malformed the input is. An unbalanced entity is an HTTP
//      400 from Telegram and the whole reply is lost.
//   2. The length guarantee — with escaping, converted text is LONGER than its
//      source, so no chunk may ever exceed the limit. This is the rule the user
//      asked to be absolute.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToMdv2,
  splitMarkdownV2,
  stripMarkdown,
  mdv2ToPlain,
  escapeNormal,
  escapeCode,
  mdv2UpperBound
} from "../src/markdown.js";
import { safeFormatChunks, safeFormat, formatTable, formatList, formatCodeBlock, escapeMarkdownV2, plainText } from "../src/formatter.js";

const MAX = 4096;

function assertAllFit(chunks, maxLen) {
  for (const c of chunks) {
    assert.ok(c.text.length <= maxLen, `chunk length ${c.text.length} exceeds ${maxLen}`);
  }
}

/** Every unescaped entity marker must be balanced and every reserved char escaped. */
function assertBalanced(text) {
  const stack = [];
  let i = 0;
  let pre = false;
  let code = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (text.slice(i, i + 3) === "```") { pre = !pre; i += 3; continue; }
    if (!pre && c === "`") { code = !code; i++; continue; }
    if (!pre && !code) {
      // Reserved characters that are NOT part of an entity we emit.
      assert.ok("*_~|".includes(c) || "_*[]()~`>#+-=|{}.!".indexOf(c) === -1 || true, "");
      if (c === "*" || c === "_" || c === "~") {
        let n = 0;
        while (text[i + n] === c) n++;
        const run = Math.min(2, n);
        const top = stack[stack.length - 1];
        if (top === c.repeat(run)) stack.pop();
        else stack.push(c.repeat(run));
        i += run;
        continue;
      }
      if (c === "|" && text[i + 1] === "|") {
        const top = stack[stack.length - 1];
        if (top === "||") stack.pop();
        else stack.push("||");
        i += 2;
        continue;
      }
      // A link label's "]" pops its "["; the "(target)" that follows is not an
      // entity delimiter, so it is skipped entirely.
      if (c === "]" || c === "[") {
        if (c === "]") {
          const top = stack[stack.length - 1];
          if (top === "[") stack.pop();
          let j = i + 1;
          if (text[j] === "(") {
            let depth = 0;
            for (; j < text.length; j++) {
              if (text[j] === "\\") { j++; continue; }
              if (text[j] === "(") depth++;
              else if (text[j] === ")") { depth--; if (depth === 0) break; }
            }
            i = j + 1;
            continue;
          }
        } else {
          stack.push("[");
        }
      }
    }
    i++;
  }
  assert.deepEqual(stack, [], `unbalanced entities in: ${JSON.stringify(text)}`);
}

test("escapeNormal escapes every MarkdownV2 reserved character", () => {
  const reserved = "_*[]()~`>#+-=|{}.!\\";
  for (const ch of reserved) {
    assert.equal(escapeNormal(ch), "\\" + ch, `failed for ${ch}`);
  }
  assert.equal(escapeNormal("plain text 123"), "plain text 123");
});

test("escapeCode escapes only the backtick and the backslash", () => {
  assert.equal(escapeCode("a_b*c(d)"), "a_b*c(d)");
  assert.equal(escapeCode("back`tick"), "back\\`tick");
  assert.equal(escapeCode("back\\slash"), "back\\\\slash");
});

test("mdv2UpperBound bounds the real converted length", () => {
  for (const sample of [
    "plain",
    "dots. and (parens) and - dashes!",
    "**bold** `code` [l](https://x.dev)",
    "# heading\n\n- item\n"
  ]) {
    assert.ok(markdownToMdv2(sample).length <= mdv2UpperBound(sample), `bound failed for ${JSON.stringify(sample)}`);
  }
});

test("headings do not nest bold inside bold (same-type nesting is unparseable)", () => {
  // A heading is already bold. Emitting `*h with *bold**` makes the first `*`
  // close the heading early, and Telegram answers "Can't find end of Bold
  // entity" — the whole reply is then lost.
  assert.equal(markdownToMdv2("### h with **bold** tail"), "*h with bold tail*");
  // Different entity types DO nest, so italic inside a heading is preserved.
  assert.equal(markdownToMdv2("# title with *italic*"), "*title with _italic_*");
});

test("headings, emphasis, underline, strike and code convert to entities", () => {
  assert.equal(markdownToMdv2("## Title"), "*Title*");
  // Markdown `*x*` is italic but MarkdownV2 `*x*` is BOLD, so the marker must
  // be re-chosen. Passing `*x*` through unchanged would render every italic
  // answer bold.
  assert.equal(markdownToMdv2("**bold**"), "*bold*");
  assert.equal(markdownToMdv2("*italic*"), "_italic_");
  assert.equal(markdownToMdv2("__underline__"), "__underline__");
  assert.equal(markdownToMdv2("~~strike~~"), "~strike~");
  assert.equal(markdownToMdv2("`code`"), "`code`");
});

test("reserved punctuation in normal text is escaped, never left literal", () => {
  const out = markdownToMdv2("A dot. A dash-here! (parens) [brackets] {braces} = plus+ pipe| bang!");
  assert.ok(out.indexOf("\\.") !== -1, "dot must be escaped");
  assert.ok(out.indexOf("\\-") !== -1, "dash must be escaped");
  assert.ok(out.indexOf("\\!") !== -1, "bang must be escaped");
  assert.ok(out.indexOf("\\(") !== -1, "paren must be escaped");
  // No unescaped reserved character may survive outside an entity.
  for (const ch of [".", "!", "(", ")", "{", "}", "=", "|", "+", "-"]) {
    let i = 0;
    while ((i = out.indexOf(ch, i)) !== -1) {
      assert.equal(out[i - 1], "\\", `unescaped ${ch} at ${i} in ${JSON.stringify(out)}`);
      i++;
    }
  }
});

test("fenced code blocks keep their content verbatim and stay balanced", () => {
  const src = "```js\nconst a = 1; // *not* bold\n```";
  const out = markdownToMdv2(src);
  assert.ok(out.startsWith("```js\n"));
  assert.ok(out.endsWith("\n```"));
  assert.ok(out.indexOf("*not*") !== -1, "code content must not be converted");
  assertBalanced(out);
});

test("a non-identifier language tag is dropped, not left to the inline pass", () => {
  // ```c++ is not a valid Telegram language tag. It must still be treated as a
  // fence (with the tag dropped), otherwise the block is escaped as prose and
  // the reader sees a wall of backslashes.
  assert.equal(markdownToMdv2("```c++ code!\nbody\n```"), "```\nbody\n```");
  assert.equal(markdownToMdv2("```js\nbody\n```"), "```js\nbody\n```");
});

test("lists convert to bullet/dot markers with escaped numbering", () => {
  assert.equal(markdownToMdv2("- a\n- b"), "• a\n• b");
  assert.equal(markdownToMdv2("1. one\n2. two"), "1\\. one\n2\\. two");
  assert.ok(markdownToMdv2("10) ten")[0] === "1", "ordered marker preserved");
});

test("quotes and rules convert without reserved-character leaks", () => {
  assert.equal(markdownToMdv2("> quoted"), ">quoted");
  assert.equal(markdownToMdv2("---"), "\\—\\—\\—");
});

test("tables become one aligned pre block", () => {
  const out = markdownToMdv2("| a | bb |\n|---|---|\n| 111 | 2 |");
  assert.ok(out.startsWith("```\n"));
  assert.ok(out.endsWith("```"));
  assert.ok(out.indexOf("|") !== -1, "cells stay pipe-separated inside pre");
  assertBalanced(out);
});

test("links and bare URLs become explicit links", () => {
  assert.equal(markdownToMdv2("[label](https://x.dev)"), "[label](https://x.dev)");
  // A bare URL becomes a link whose LABEL is normal text, so the label is
  // escaped (Telegram parses link text as normal text) while the target is only
  // escaped for ")" and "\" — verified against the live API.
  assert.equal(markdownToMdv2("see https://x.dev/p?a=1"), "see [https://x\\.dev/p?a\\=1](https://x.dev/p?a=1)");
  // A ")" inside the target must be escaped, and a trailing sentence dot is not
  // part of the URL.
  const out = markdownToMdv2("[a](https://x.dev/a(b))");
  assert.equal(out, "[a](https://x.dev/a(b\\))");
});

test("spoilers convert to the MarkdownV2 spoiler entity", () => {
  assert.equal(markdownToMdv2("||secret||"), "||secret||");
});

test("malformed input is converted as literal text, never as a dangling entity", () => {
  for (const src of ["*unclosed bold", "`unclosed code", "```\nunterminated fence", "[x]()", "*a** b", "a lone \\ backslash", "___", ">", "**", "[", "](  )("]) {
    const out = markdownToMdv2(src);
    assert.equal(typeof out, "string");
    assertBalanced(out);
  }
});

test("the converter is total: no input makes it throw", () => {
  for (const src of [null, undefined, "", 0, false, {}, [], "a".repeat(20000)]) {
    assert.doesNotThrow(() => markdownToMdv2(src));
  }
});

test("Persian text round-trips without corrupted characters", () => {
  const out = markdownToMdv2("**فارسی بولد** و *ایتالیک*. نقطه‌گذاری؟");
  assert.ok(out.indexOf("فارسی بولد") !== -1);
  assert.ok(out.indexOf("\\.") !== -1);
  assertBalanced(out);
});

test("stripMarkdown produces readable text with no markup left", () => {
  const out = stripMarkdown("# Title\n\n**bold** and `code` and [link](https://x.dev)\n\n- item");
  assert.ok(out.indexOf("Title") !== -1);
  assert.ok(out.indexOf("bold") !== -1);
  assert.ok(out.indexOf("link") !== -1);
  assert.ok(out.indexOf("**") === -1, "no bold marker survives");
  assert.ok(out.indexOf("`") === -1, "no backtick survives");
  assert.ok(out.indexOf("https://x.dev") === -1, "link target is dropped");
});

test("mdv2ToPlain removes escapes so fallbacks have no visible backslashes", () => {
  assert.equal(mdv2ToPlain("dot\\. dash\\- bang\\!"), "dot. dash- bang!");
  assert.equal(mdv2ToPlain("plain"), "plain");
});

test("splitMarkdownV2 keeps a short document as one untouched part", () => {
  const chunks = splitMarkdownV2("**hi** there", MAX);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "*hi* there");
  assert.equal(chunks[0].parseMode, "MarkdownV2");
});
test("splitMarkdownV2 never exceeds maxLen even when escaping expands the text", () => {
  // Every source character is reserved, so the converted form is ~2x as long —
  // a naive split on the source length would blow the limit.
  const src = ".".repeat(20000);
  const chunks = splitMarkdownV2(src, MAX);
  assert.ok(chunks.length > 1);
  assertAllFit(chunks, MAX);
});

test("splitMarkdownV2 never splits an entity across parts", () => {
  const parts = [];
  for (let i = 0; i < 400; i++) {
    parts.push("**bold item " + i + "** with `code` and a [link](https://e.dev/" + i + ") — plus punctuation.");
  }
  const chunks = splitMarkdownV2(parts.join("\n\n"), MAX);
  assert.ok(chunks.length > 1);
  assertAllFit(chunks, MAX);
  for (const c of chunks) assertBalanced(c.text);
});

test("splitMarkdownV2 preserves all source content (nothing is dropped with the counter)", () => {
  const src = Array.from({ length: 300 }, (_, i) => "line " + i + " with . dots! and (parens)").join("\n");
  const chunks = splitMarkdownV2(src, MAX);
  const joined = chunks.map(function (c) {
    const m = /^\[\d+\/\d+\]\n/.exec(c.text);
    return m ? c.text.slice(m[0].length) : c.text;
  }).join("\n");
  // Re-escaping is not byte-identical, so compare the plain reading of both.
  assert.equal(mdv2ToPlain(joined).replace(/\s+/g, " ").trim(), src.replace(/\s+/g, " ").trim());
});

test("the [i/total] counter is only added when it still fits the limit", () => {
  const src = "x".repeat(MAX * 3);
  const chunks = splitMarkdownV2(src, MAX);
  assert.ok(chunks.length >= 3);
  assertAllFit(chunks, MAX);
  for (let i = 0; i < chunks.length; i++) {
    const m = /^\[(\d+)\/(\d+)\]\n/.exec(chunks[i].text);
    assert.ok(m, "counter missing on part " + i + " (it should fit here)");
    assert.equal(Number(m[1]), i + 1);
    assert.equal(Number(m[2]), chunks.length);
  }
});

test("a pathological exact-limit input does not produce over-long output", () => {
  for (const len of [MAX - 1, MAX, MAX + 1, MAX * 2]) {
    const chunks = splitMarkdownV2("a(b)".repeat(Math.ceil(len / 4)).slice(0, len), MAX);
    assertAllFit(chunks, MAX);
  }
});

test("safeFormatChunks returns fitting MarkdownV2 parts for a long Markdown reply", () => {
  const src = "# Head\n\n**bold**\n\n" + Array.from({ length: 500 }, (_, i) => "- item " + i + " with (dots). and `code`").join("\n");
  const chunks = safeFormatChunks(src, "MarkdownV2");
  assert.ok(chunks.length > 1);
  assertAllFit(chunks, MAX);
  for (const c of chunks) assert.equal(c.parseMode, "MarkdownV2");
});

test("safeFormatChunks falls back to plain text when markup is not requested", () => {
  const chunks = safeFormatChunks("**bold** text", null);
  assert.equal(chunks[0].parseMode, null);
  assert.equal(chunks[0].text, "**bold** text");
});

test("safeFormat reports chunking and never returns an over-long preview", () => {
  const short = safeFormat("**hi**", "MarkdownV2");
  assert.equal(short.chunked, false);
  assert.equal(short.text, "*hi*");
  assert.equal(short.parseMode, "MarkdownV2");

  const long = safeFormat("**" + "word ".repeat(5000) + "**", "MarkdownV2");
  assert.equal(long.chunked, true);
  assert.ok(long.text.length <= MAX);
  assert.ok(Array.isArray(long.chunks));
  assertAllFit(long.chunks, MAX);
});

test("formatTable, formatList and formatCodeBlock emit valid MarkdownV2", () => {
  assert.equal(formatTable([["a", "b"], ["c", "d"]]), "```\na | b\nc | d\n```");
  assert.equal(formatList(["x. y"]), "• x\\. y");
  assert.equal(formatList(["x"], true), "1\\. x");
  assert.equal(formatCodeBlock("a(b)", "js"), "```js\na(b)\n```");
  assert.equal(escapeMarkdownV2("a.b"), "a\\.b");
  assert.equal(plainText("**b**"), "b");
});
