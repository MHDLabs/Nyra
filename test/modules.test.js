import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Structural guard for the module graph.
 *
 * `node --check` only parses and `node --test` only runs what it imports, so
 * neither can see a module calling a function that used to be a local
 * declaration and now lives in a sibling module — the call site simply throws
 * ReferenceError at runtime. That is exactly how the Phase C split broke the
 * add-model wizard: the prompt renderers moved into connection-prompts.js
 * while `connection.js` kept calling them without an import.
 *
 * This test only checks calls of the form `name(...)` where `name` is exported
 * by ANOTHER file in src/ and is not imported by the calling file. It is
 * deliberately narrow so it cannot produce false alarms on locals, properties,
 * or dynamically imported bindings.
 */

const SRC = new URL("../src", import.meta.url).pathname.replace(/\/$/, "");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Names a module publishes to its importers. */
function exportedNames(source) {
  const names = new Set();
  for (const re of [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  ]) {
    for (const m of source.matchAll(re)) names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const entry = raw.trim();
      if (!entry || entry.startsWith("default")) continue;
      const alias = entry.split(/\s+as\s+/);
      names.add((alias[1] || alias[0]).trim());
    }
  }
  return names;
}

/** Local bindings introduced by imports, declarations and parameters. */
function localNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*["'][^"']+["']/g)) {
    const clause = m[1];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const raw of braced[1].split(",")) {
        const entry = raw.trim();
        if (!entry) continue;
        const alias = entry.split(/\s+as\s+/);
        names.add((alias[1] || alias[0]).trim());
      }
    }
    const head = clause.replace(/\{[\s\S]*\}/, "").split(",")[0].replace(/\*\s+as\s+/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) names.add(head);
  }
  for (const re of [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /catch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g
  ]) {
    for (const m of source.matchAll(re)) names.add(m[1]);
  }
  // Destructuring declarations and destructured parameters.
  for (const m of source.matchAll(/(?:const|let|var|\(|,)\s*\{([^{}]*)\}\s*(?:=|\))/g)) {
    for (const raw of m[1].split(",")) {
      const key = raw.split(":")[0].split("=")[0].replace(/\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  return names;
}

/** Remove comments and string bodies so names inside text never match. */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " `` ")
    .replace(/'(?:\\.|[^'\\\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' "" ');
}

const files = walk(SRC).map((path) => ({ path, rel: relative(SRC, path), source: readFileSync(path, "utf8") }));

test("src/ modules never call a sibling module's export without importing it", () => {
  const exporters = new Map();
  for (const file of files) {
    for (const name of exportedNames(file.source)) {
      if (!exporters.has(name)) exporters.set(name, new Set());
      exporters.get(name).add(file.rel);
    }
  }

  const offenders = [];
  for (const file of files) {
    const code = stripCommentsAndStrings(file.source);
    const local = localNames(file.source);
    // A destructured dynamic import declares its bindings in a `const { x } = await import(...)`.
    const dynamic = new Set();
    for (const m of file.source.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s+import\s*\(/g)) {
      for (const raw of m[1].split(",")) {
        const key = raw.split(":")[0].split("=")[0].trim();
        if (key) dynamic.add(key);
      }
    }
    for (const [name, owners] of exporters) {
      if (local.has(name) || dynamic.has(name)) continue;
      if (owners.size === 1 && owners.has(file.rel)) continue;
      const call = new RegExp("(?<![.\\w$?])" + name + "\\s*\\(", "g");
      const match = call.exec(code);
      if (!match) continue;
      const line = code.slice(0, match.index).split("\n").length;
      offenders.push(file.rel + ":" + line + " calls " + name + "() exported by " + [...owners].join(", "));
    }
  }

  assert.deepEqual(offenders, [], "missing imports:\n" + offenders.join("\n"));
});
