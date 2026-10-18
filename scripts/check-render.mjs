// Scratch validator for the render path (not part of `npm test`).
// Feeds realistic model output through the formatter and asks the real Bot API
// to parse every chunk. Atom's chat_id 1 is invalid, so nothing is delivered —
// but Telegram validates parse_mode and entities BEFORE resolving the chat, so
// a "chat not found" answer still proves the payload is well-formed.
import { safeFormatChunks, formatTable, formatList, formatCodeBlock, formatExpandableQuote, plainText } from "../src/formatter.js";
import { readFileSync } from "node:fs";

const MAX = 4096;
const cache = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const token = /^TELEGRAM_BOT_TOKEN\s*=\s*"?([^"\n]+)"?/m.exec(cache)[1].trim();

let failures = 0;

async function apiValidate(label, text, parseMode) {
  const payload = { chat_id: 1, text: text };
  if (parseMode) payload.parse_mode = parseMode;
  const resp = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  const desc = String(data.description || "");
  const parseProblem = /parse entities|can't parse|unsupported start tag|reserved and must be escaped/i.test(desc);
  if (parseProblem) {
    failures++;
    console.log("FAIL " + label + ": " + desc);
  }
  return desc;
}

const longReply = [
  "# Deployment notes",
  "",
  "Here is the **short version** — the pipeline is *fast* but `retry` logic is __fragile__.",
  "",
  "## Steps",
  "1. Build the worker",
  "2. Run the tests (they take ~12s)",
  "3. Deploy with `wrangler deploy`",
  "",
  "Key files:",
  "- `src/index.js` (the entry point)",
  "- `wrangler.toml` — config, note the `[assets]` block",
  "",
  "> Careful: the KV cache is not invalidated on redeploy.",
  "",
  "| binding | type | notes |",
  "|---|---|---|",
  "| DB | D1 | primary store |",
  "| KV | KV | cache, TTL 1h |",
  "",
  "```js",
  "const result = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();",
  "if (!result) throw new Error('missing user (id=' + id + ')');",
  "```",
  "",
  "See [the docs](https://developers.cloudflare.com/workers/wrangler/) or https://developers.cloudflare.com/d1/ for details.",
  "",
  "نکته مهم: **محدودیت ۴۰۹۶ کاراکتری** باید رعایت شود. لطفاً خروجی را کوتاه نگه دارید.",
  "",
  "## Padding",
  ""
].join("\n");

const filler = [];
for (let i = 1; i <= 260; i++) {
  filler.push("- Item " + i + ": parsing (value " + i + ") requires care, e.g. `a(b).c` with **emphasis** and a [link](https://example.com/p" + i + ") — done.");
}
const bigReply = longReply + filler.join("\n");

async function main() {
  const short = safeFormatChunks("**bold** and *italic* and `code`.", "MarkdownV2");
  console.log("short: parts=" + short.length + " mode=" + short[0].parseMode);
  await apiValidate("short", short[0].text, short[0].parseMode);

  const big = safeFormatChunks(bigReply, "MarkdownV2");
  const over = big.filter(function (c) { return c.text.length > MAX; });
  const maxLen = big.reduce(function (m, c) { return Math.max(m, c.text.length); }, 0);
  console.log("big: parts=" + big.length + " maxLen=" + maxLen + " over=" + over.length + " src=" + bigReply.length);
  if (over.length) failures++;
  for (let i = 0; i < big.length; i++) {
    await apiValidate("big[" + i + "]", big[i].text, big[i].parseMode);
  }

  const parts = [
    ["table", formatTable([["binding", "type"], ["DB", "D1"]])],
    ["list", formatList(["one. with dot", "two (parens)"])],
    ["list-numbered", formatList(["alpha", "beta"], true)],
    ["codeblock", formatCodeBlock("const a = (1); // no-op", "js")],
    ["quote", formatExpandableQuote("A long-ish quote. With dots, (parens) and a dash — plus `code`.")],
    ["quote-short", formatExpandableQuote("hi")],
    ["plainText", plainText("**bold** _it_ `c`")]
  ];
  for (const entry of parts) {
    console.log(entry[0] + ": " + JSON.stringify(entry[1].slice(0, 70)));
    await apiValidate(entry[0], entry[1], "MarkdownV2");
  }

  console.log(failures === 0 ? "ALL PASS" : "FAILURES: " + failures);
}

await main();
