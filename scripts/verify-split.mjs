// Equivalence prover for scripts/split-module.mjs.
//
//   node scripts/verify-split.mjs <original.js> <outDir> [originalBaseDir]
//
// Kept as the reproducible record of the decomposition rather than deleted:
// it is what made "every moved body is byte-identical" a checkable claim
// instead of a narrative one. The originals are thin re-export facades now, so
// restore one from git history first — and pass its *original* directory as the
// third argument when restoring it somewhere else, because a relative specifier
// only means the same thing from the directory it was written in:
//
//   git show <sha>:src/flows.js > /tmp/flows-original.js
//   node scripts/verify-split.mjs /tmp/flows-original.js src/flows src
//
// Relative specifiers are normalised before comparison, because a body that
// moved one directory deeper legitimately has a different path back to the
// same file; the normalisation resolves both sides against the directory the
// chunk was written in, so a real edit still shows up as a diff.
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";

const DECL = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/;

function chunks(path, baseDir) {
  const lines = readFileSync(path, "utf8").split("\n");
  // Mirror the splitter: an `export default { ... }` is its own chunk and any
  // declaration above it stops there rather than running to EOF.
  const defaultLine = lines.findIndex((l) => /^export\s+default\b/.test(l));
  const bodyEnd = defaultLine === -1 ? lines.length : defaultLine;
  const starts = [];
  for (let i = 0; i < bodyEnd; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    let s = i;
    while (s > 0) {
      const p = lines[s - 1].trim();
      if (p.startsWith("//") || p.startsWith("/*") || p.startsWith("*") || p.endsWith("*/")) s--;
      else break;
    }
    starts.push([m[1] || m[2], s]);
  }
  const out = new Map();
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1][1] : bodyEnd;
    out.set(starts[i][0], lines.slice(starts[i][1], end).join("\n").replace(/\s+$/, ""));
  }
  // A split legitimately rewrites relative specifiers, because a body that moved
  // one directory deeper has a different distance back to the same file. Compare
  // by target, not by literal text, so a real edit is still reported as a diff.
  if (baseDir) return new Map([...out].map(([k, v]) => [k, normalize(v, baseDir)]));
  return out;
}

// Resolve every relative specifier in a chunk against the directory the chunk
// came from, so the original and the moved copy both describe the same target.
function normalize(text, baseDir) {
  return text.replace(/(from\s*|import\(\s*)"(\.[^"]*)"/g, (whole, head, spec) =>
    head + '"' + posix.normalize(posix.join(baseDir, spec)) + '"');
}

const strip = (t) => t.replace(/^export\s+/m, "");
const srcPath = process.argv[2] || "src/ai.js";
const outDir = process.argv[3] || "src/providers";
// Where the original was *written* — not necessarily where it is being read
// from, since a re-export facade is all that is left at the real path.
const origBase = process.argv[4] || posix.dirname(srcPath);
const orig = chunks(srcPath, origBase);
const merged = new Map();
for (const f of readdirSync(outDir).sort()) {
  if (f === "index.js") continue;
  for (const [k, v] of chunks(outDir + "/" + f, outDir)) {
    if (merged.has(k)) console.log("DUPLICATE DECLARATION:", k);
    merged.set(k, v);
  }
}

console.log("comparing " + srcPath + " -> " + outDir);
const missing = [...orig.keys()].filter((k) => !merged.has(k));
const extra = [...merged.keys()].filter((k) => !orig.has(k));
let differing = 0;
for (const k of orig.keys()) {
  if (!merged.has(k)) continue;
  if (strip(orig.get(k)) !== strip(merged.get(k))) {
    differing++;
    console.log("BODY DIFFERS:", k);
  }
}
console.log("original declarations:", orig.size, "| moved declarations:", merged.size);
console.log("missing:", missing.length ? missing.join(", ") : "none");
console.log("extra:", extra.length ? extra.join(", ") : "none");
console.log("bodies differing:", differing);
