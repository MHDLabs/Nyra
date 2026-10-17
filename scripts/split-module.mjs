// Mechanical module splitter for the Nyra refactor.
//
//   node scripts/split-module.mjs <spec.json>
//
// Why a mechanical splitter instead of hand-editing: every moved body stays
// byte-identical, and the tool refuses to run rather than silently dropping a
// declaration or a dependency.
//
// Imports are derived, not guessed: bindings the original file imported are
// re-emitted wherever the moved body still uses them. A symbol that moved to a
// sibling must be listed in `extraImports`, otherwise the tool stops and says
// exactly which import line to add.
//
// Two things it does not do, on purpose: it never guesses whether a symbol
// belongs in a module (every declaration must be claimed or listed in `ignore`,
// otherwise it stops), and it never rewrites a relative specifier unless the
// declaration actually moved a level — both the hoisted imports and any lazy
// `await import("...")` are re-rooted, and an unresolvable result is a hard
// error rather than a silently wrong path.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const [specPath] = process.argv.slice(2);
if (!specPath) {
  console.error("usage: node scripts/split-module.mjs <spec.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const lines = readFileSync(spec.src, "utf8").split("\n");

const DECL = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)|^(export\s+default)\b/;
const DEFAULT_NAME = "<default>";
// Chunks carry the contiguous comment block that sat above the declaration, and
// declarations that were already exported still carry their `export` keyword.
// Both are handled here so `export ` can be re-added in front of the keyword
// itself — putting it before the comment would detach the comment from the
// symbol.
//
// This is line-based rather than a single regex on purpose. A regex anchored at
// `^` can only skip an *inline* `/** ... *\/` block, so a declaration introduced
// by `//` line comments got its `export` silently dropped (isFastMessage), and a
// generator function or a `const` split across lines was rewritten by luck. The
// rewrite walks to the first line that actually starts the declaration and
// touches only that line.
const DECL_KEYWORD = /^(?:export\s+)?(async\s+function\s*\*?\s*|function\s*\*?\s*|const\s|let\s|var\s)/;
const rewriteExport = (text, add) => {
  const body = text.split("\n");
  for (let i = 0; i < body.length; i++) {
    const t = body[i].trim();
    // Skip the leading comment block: an already-exported comment line must not
    // be mistaken for the declaration itself.
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/")) continue;
    const m = DECL_KEYWORD.exec(body[i]);
    // Never return silently here. Failing to find the declaration keyword means
    // the export would be dropped (or an unwanted one kept) without any signal,
    // which is precisely how `isFastMessage` ended up un-exported.
    if (!m) throw new Error("cannot locate the declaration keyword to rewrite an `export` in this chunk:\n" + text.split("\n").slice(0, 4).join("\n"));
    if (add) {
      if (!/^\s*export\b/.test(body[i])) body[i] = body[i].replace(DECL_KEYWORD, "export $1");
    } else {
      body[i] = body[i].replace(/^(\s*)export\s+/, "$1");
    }
    return body.join("\n");
  }
  throw new Error("chunk has no declaration line at all:\n" + text.slice(0, 200));
};
const withExport = (text) => rewriteExport(text, true);
const withoutExport = (text) => rewriteExport(text, false);
const starts = [];
for (let i = 0; i < lines.length; i++) {
  const m = DECL.exec(lines[i]);
  if (!m) continue;
  const name = m[1] || m[2] || DEFAULT_NAME;
  let s = i;
  while (s > 0) {
    const p = lines[s - 1].trim();
    if (p.startsWith("//") || p.startsWith("/*") || p.startsWith("*") || p.endsWith("*/")) s--;
    else break;
  }
  starts.push({ name, start: s });
}

// An `export default { ... }` is not a function or const declaration, so it is
// not one of the chunks. It is lifted into `spec.trailer` and re-emitted as the
// last chunk instead of silently riding along in whichever declaration happened
// to precede it.
const defaultIdx = starts.findIndex(function (s) { return s.name === DEFAULT_NAME; });
let trailer = null;
// Chunks are sliced between consecutive declaration starts, so once the default
// export is lifted out the declaration above it would otherwise keep running to
// EOF and swallow the default export into itself. This is the hard upper bound.
let bodyEnd = lines.length;
if (defaultIdx !== -1) {
  const from = starts[defaultIdx].start;
  bodyEnd = from;
  trailer = lines.slice(from, lines.length).join("\n").replace(/\s+$/, "");
  starts.splice(defaultIdx, 1);
}
// `dropTrailer` is for entry points: the handler bodies move out, but the
// Worker's `export default { fetch, scheduled, queue }` is the one thing that
// must stay in the original file, because it is the composition root that binds
// every handler together. Requiring the trailer to exist means a source that
// loses its default export fails the split instead of quietly dropping it.
if (spec.dropTrailer) {
  if (!trailer) throw new Error(spec.src + " has no `export default` to drop");
  trailer = null;
}
// Whichever module claims the trailer must be unambiguous, otherwise the Worker
// entry point could end up in two files (or none).
const trailerOwners = Object.keys(spec.modules).filter(function (f) { return spec.modules[f].trailer; });
if (trailer && trailerOwners.length !== 1) {
  throw new Error("the source has an `export default`; exactly one module must set \"trailer\": true (got " + trailerOwners.length + ")");
}
if (!trailer && trailerOwners.length) {
  throw new Error("module " + trailerOwners[0] + " sets \"trailer\": true but the source has no `export default`");
}

const chunks = new Map();
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1].start : bodyEnd;
  const name = starts[i].name;
  if (chunks.has(name)) throw new Error("duplicate top-level declaration: " + name);
  chunks.set(name, lines.slice(starts[i].start, end).join("\n").replace(/\s+$/, ""));
}

const importedFrom = new Map();
for (const line of lines) {
  const m = /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(line);
  if (!m) continue;
  for (const raw of m[1].split(",")) {
    const name = raw.trim().split(/\s+as\s+/).pop();
    if (name) importedFrom.set(name, m[2]);
  }
}

const owned = new Map();
for (const [file, mod] of Object.entries(spec.modules)) {
  for (const sym of mod.symbols) {
    if (owned.has(sym)) throw new Error("declaration claimed by two modules: " + sym + " (" + owned.get(sym) + ", " + file + ")");
    if (!chunks.has(sym)) throw new Error(file + ": no such declaration in " + spec.src + ": " + sym);
    owned.set(sym, file);
  }
}

// Every declaration must land somewhere. An unassigned constant is as fatal as
// an unassigned function — it would become a ReferenceError at runtime — so the
// only way to leave one behind is to name it in `ignore` explicitly.
const ignored = new Set(spec.ignore || []);
const orphans = [...chunks.keys()].filter(function (n) { return !owned.has(n) && !ignored.has(n); });
if (orphans.length) throw new Error("declarations not assigned to any module (add them to a module, or to `ignore`): " + orphans.join(", "));

const PUBLIC = new Set(spec.public || []);
// `shared` symbols must cross module boundaries but are deliberately kept out of
// the barrel, so splitting the implementation never widens the public API.
const SHARED = new Set(spec.shared || []);
const EXPORTED = new Set([...PUBLIC, ...SHARED]);
mkdirSync(spec.outDir, { recursive: true });

const uses = (text, name) => new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b").test(text);
// A sibling import is only legal if the target module actually exports the
// binding. Without this check a symbol omitted from `shared`/`public` compiles
// fine in isolation and then blows up at import time with
// "does not provide an export named ...".
const ownedAndExported = new Set([...PUBLIC, ...SHARED]);
// Generated files may sit deeper than the source (e.g. src/ai.js ->
// src/providers/*.js), so inherited relative imports have to be re-rooted.
const srcDir = spec.src.split("/").slice(0, -1);
const outSegments = spec.outDir.split("/");
const upToSrc = "../".repeat(Math.max(0, outSegments.length - srcDir.length));
const summary = [];
const barrelLines = [];

for (const [file, mod] of Object.entries(spec.modules)) {
  let body = mod.symbols.map(function (sym) {
    const text = chunks.get(sym);
    return EXPORTED.has(sym) ? withExport(text) : withoutExport(text);
  }).join("\n\n");

  const extra = (mod.extraImports || []).join("\n");
  const provided = new Set();
  // Every sibling import line counts as a provider of its bindings, not just the
  // first one — otherwise a module importing from three siblings would be
  // reported as missing the second and third.
  const extraImportRe = /import\s*\{([^}]*)\}\s*from\s*"([^"]*)/g;
  let extraMatch;
  while ((extraMatch = extraImportRe.exec(extra)) !== null) {
    const from = extraMatch[2];
    for (const raw of extraMatch[1].split(",")) {
      const n = raw.trim().split(/\s+as\s+/).pop();
      if (!n) continue;
      provided.add(n);
      // Guard: the sibling must actually export what is being imported from it.
      if (from.startsWith(".") && !ownedAndExported.has(n)) {
        throw new Error(file + " imports `" + n + "` from " + from +
          ", but `" + n + "` is not listed in `public` or `shared` — its export would be stripped.");
      }
    }
  }

  // Lazy `await import("./db.js")` calls move with the body but are invisible to
  // the static import scan, so a file that moves one directory deeper kept a
  // source-relative specifier and only failed at bundle time. Re-root them with
  // the same rule as the hoisted imports.
  let rebasedBody = body.replace(/(import\(\s*)"(\.[^"]*)"/g, function (whole, head, spec) {
    return head + "\"" + upToSrc + spec.slice(2) + "\"";
  });
  // A dynamic import of a module that sits in the same directory as the source
  // must not be re-rooted; only paths that will actually move need it. The
  // bundler is the authority here, so a leftover unresolvable specifier is a
  // hard error rather than something to guess at.
  if (upToSrc && rebasedBody !== body) {
    const rebound = [...body.matchAll(/(import\(\s*)"(\.[^"]*)"/g)].map(function (m) { return m[2]; });
    for (const spec of new Set(rebound)) {
      const abs = srcDir.concat(spec.slice(2)).join("/");
      if (!existsSync(abs)) {
        throw new Error(file + " dynamically imports " + spec +
          ", which does not exist at " + abs + " — fix the spec, the splitter will not guess.");
      }
    }
  }
  body = rebasedBody;

  const needed = new Map();
  const selfDefined = new Set(mod.symbols);
  for (const [binding, from] of importedFrom) {
    if (!uses(body, binding)) continue;
    if (provided.has(binding) || selfDefined.has(binding)) continue;
    if (owned.has(binding)) {
      throw new Error(file + " uses `" + binding + "`, which moved to " + owned.get(binding) +
        " — add to extraImports: import { " + binding + " } from \"./" + owned.get(binding) + "\";");
    }
    if (!needed.has(from)) needed.set(from, new Set());
    needed.get(from).add(binding);
  }

  const importBlock = [];
  for (const [from, bindings] of needed) {
    const target = from.startsWith(".") ? upToSrc + from.slice(2) : from;
    importBlock.push("import { " + [...bindings].join(", ") + " } from \"" + target + "\";");
  }
  if (extra) importBlock.push(extra);

  const text = (spec.header || []).concat(mod.header || []).join("\n") +
    "\n" + importBlock.join("\n") + "\n\n" + body +
    (mod.trailer ? "\n\n" + trailer : "") + "\n";
  writeFileSync(spec.outDir + "/" + file, text);

  const exports = mod.symbols.filter(function (s) { return EXPORTED.has(s); });
  summary.push([file, text.split("\n").length, mod.symbols.length, exports.length]);
  barrelLines.push([file, mod.symbols.filter(function (s) { return PUBLIC.has(s); })]);
}

if (spec.barrel) {
  const out = [].concat(spec.barrelHeader || []).join("\n");
  const blocks = [];
  for (const [file, exports] of barrelLines) {
    if (!exports.length) continue;
    const rows = [];
    let line = "  ";
    for (const e of exports) {
      if (line.length + e.length + 2 > 78) { rows.push(line.replace(/ $/, "")); line = "  "; }
      line += e + ", ";
    }
    rows.push(line.replace(/, $/, ""));
    blocks.push("export {\n" + rows.join("\n") + "\n} from \"./" + file + "\";");
  }
  writeFileSync(spec.barrel, out + "\n" + blocks.join("\n\n") + "\n");
}

for (const [file, lineCount, symCount, expCount] of summary) {
  console.log("  " + spec.outDir + "/" + file + " — " + lineCount + " lines, " + symCount + " decls, " + expCount + " exported");
}
console.log("  " + owned.size + " of " + chunks.size + " declarations moved");
