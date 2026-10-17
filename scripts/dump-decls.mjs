// Declaration lister for scripts/split-module.mjs specs.
//
//   node scripts/dump-decls.mjs <file>
//
// Prints every top-level declaration with its line number, so a split spec is
// written against the real symbol list rather than a remembered or grepped one
// (a grep summary silently drops declarations, and a spec missing one makes the
// splitter refuse to run). Kept next to the splitter as part of the record of
// how the modules under src/ were derived.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/dump-decls.mjs <file>");
  process.exit(2);
}
const DECL = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)|^(export\s+default)\b/;
const lines = readFileSync(path, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  const m = DECL.exec(lines[i]);
  if (!m) continue;
  console.log((m[3] ? "<default>" : (m[1] || m[2])) + ":" + (i + 1));
}
