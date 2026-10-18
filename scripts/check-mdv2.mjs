// Scratch validator: converts Markdown samples to MarkdownV2, checks every
// emitted string for balance, then asks the real Bot API to parse each one
// (a bogus chat_id still runs entity parsing before chat resolution).
import { markdownToMdv2, stripMarkdown, splitMarkdownV2, escapeNormal } from "../src/markdown.js";
import { readFileSync } from "node:fs";

const samples = [
  "# Title\n\nSome **bold** and *italic* and __underline__ and ~~strike~~ and `code`.\n",
  "A dot. A dash-here! A (paren) [bracket] {brace} = plus+ pipe| bang!\n",
  "```js\nconst a = 1; // *not* bold\n```\n",
  "```\nline1\nline2\n```",
  "1. one\n2. two\n10. ten\n",
  "- a\n- b\n  - nested\n",
  "> quoted *text*\n> second line\n",
  "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "[label](https://example.com/a(b)) and bare https://x.dev/p?a=1.\n",
  "**bold with *nested italic* inside**\n",
  "*unclosed bold\n",
  "a lone \\ backslash and 100% done\n",
  "spoilered ||secret|| kept\n",
  "___\n",
  "### h3 with **bold** ###\n",
  "```\nunterminated fence\n",
  "*a** b\n",
  "nested [link [inner]](https://e.com)\n",
  "empty link [x]() ignored\n",
  "| ۱ | ۲ |\n|---|---|\n| a | b |",
  "**فارسی بولد** و *ایتالیک*\\. نقطه‌گذاری؟\n"
];

function balanceCheck(s) {
  // Count unescaped markers; every opener must have a closer. Link targets in
  // "(...)" and "]" are skipped because Telegram does not treat them as entity
  // delimiters.
  const stack = [];
  let i = 0;
  let pre = false;
  let code = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (s.slice(i, i + 3) === "```") { pre = !pre; i += 3; continue; }
    if (!pre && c === "`") { code = !code; i++; continue; }
    if (!pre && !code) {
      if (c === "*" || c === "_" || c === "~") {
        const run = Math.min(2, (function () { let n = 0; while (s[i + n] === c) n++; return n; })());
        const top = stack[stack.length - 1];
        if (top === c.repeat(run)) stack.pop();
        else stack.push(c.repeat(run));
        i += run;
        continue;
      }
      if (c === "|" && s[i + 1] === "|") {
        const top = stack[stack.length - 1];
        if (top === "||") stack.pop(); else stack.push("||");
        i += 2;
        continue;
      }
      if (c === "]") {
        // Skip the "(target)" that follows a link label.
        if (stack[stack.length - 1] === "[") stack.pop();
        if (s[i + 1] === "(") {
          let depth = 0;
          let j = i + 1;
          for (; j < s.length; j++) {
            if (s[j] === "\\") { j++; continue; }
            if (s[j] === "(") depth++;
            else if (s[j] === ")") { depth--; if (depth === 0) break; }
          }
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }
    }
    i++;
  }
  return { unbalanced: stack.length > 0 ? stack.join("") : null, pre: pre };
}

const token = (function () {
  const raw = readFileSync(".dev.vars", "utf8");
  const m = raw.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
})();

async function apiValidate(text) {
  const body = JSON.stringify({ chat_id: 1, text: text, parse_mode: "MarkdownV2" });
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body
  });
  const json = await res.json();
  const desc = String(json.description || "");
  if (desc.indexOf("can't parse entities") !== -1) return desc;
  return null; // "chat not found" / ok => entities parsed
}

let fails = 0;
for (let n = 0; n < samples.length; n++) {
  const src = samples[n];
  const md = markdownToMdv2(src);
  const bal = balanceCheck(md);
  const plain = stripMarkdown(src);
  const api = await apiValidate(md);
  const bad = bal.unbalanced || bal.pre || api;
  if (bad) fails++;
  console.log((bad ? "FAIL " : "ok   ") + n + " len=" + md.length + (bal.unbalanced ? " UNBAL=" + bal.unbalanced : "") + (api ? " API=" + api : ""));
  if (bad) console.log("   out: " + JSON.stringify(md).slice(0, 300));
}

// Length guarantee: a huge document must never yield a chunk over the limit.
const huge = [];
for (let i = 0; i < 400; i++) huge.push("**bold " + i + "** item with .dots! and (parens) [x] " + "y".repeat(60));
const bigSrc = huge.join("\n");
const chunks = splitMarkdownV2(bigSrc, 4096);
let over = 0;
for (const ch of chunks) if (ch.text.length > 4096) over++;
console.log("split: parts=" + chunks.length + " maxLen=" + Math.max.apply(null, chunks.map(function (c) { return c.text.length; })) + " over=" + over);
if (over) fails++;
const apiBig = [];
for (let i = 0; i < chunks.length; i++) {
  const e = await apiValidate(chunks[i].text);
  if (e) { apiBig.push(i + ":" + e.slice(0, 120)); }
}
if (apiBig.length) { fails++; console.log("split API failures: " + apiBig.join(" | ")); }
else console.log("split API: all " + chunks.length + " chunks parsed");

console.log(fails === 0 ? "ALL PASS" : "FAILURES: " + fails);
