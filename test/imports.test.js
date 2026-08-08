import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_DIRECTORIES = ["src", "popup", "calendar", "options", "reconcile", "background", "usage", "content"];

function jsFiles(directory) {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `${directory}/${name}`);
}

/** Drops import statements, whose own text would otherwise look like usage. */
function withoutImports(text) {
  return text.replace(/import\s[\s\S]*?from\s*["'][^"']*["'];/g, " ");
}

/** Strips comments and strings, so a name mentioned in prose is not read as code. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");
}

function importedNames(text) {
  const names = new Set();
  for (const [, block] of text.matchAll(/import \{([^}]*)\} from/g)) {
    for (const part of block.split(",")) {
      const name = part.trim();
      if (name) names.add(name.split(" as ").pop().trim());
    }
  }
  for (const [, name] of text.matchAll(/import (\w+) from/g)) names.add(name);
  return names;
}

const sourceFiles = MODULE_DIRECTORIES.flatMap(jsFiles);

// Every name exported anywhere in src/, and where it comes from.
const exportedBy = new Map();
for (const file of sourceFiles.filter((file) => file.startsWith("src/"))) {
  const text = readFileSync(join(root, file), "utf8");
  for (const [, name] of text.matchAll(/export (?:async function|function|const|let|class) (\w+)/g)) {
    exportedBy.set(name, file);
  }
}

describe("module imports", () => {
  it("finds shared exports to check against", () => {
    assert.ok(exportedBy.size > 30, `expected many shared exports, found ${exportedBy.size}`);
  });

  // A missing import is silent until the line runs, which is how a broken Save
  // button reached a release: the calendar used fromLocalInputValue without
  // importing it, so submitting threw before anything was written.
  for (const file of sourceFiles) {
    it(`${file} imports every shared name it uses`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const code = codeOnly(withoutImports(text));
      const imported = importedNames(text);
      const declared = new Set([...code.matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]));

      const missing = [...new Set([...code.matchAll(/\b(\w+)\b/g)].map((m) => m[1]))]
        .filter((name) => exportedBy.has(name) && exportedBy.get(name) !== file)
        .filter((name) => !imported.has(name) && !declared.has(name))
        .sort();

      assert.deepEqual(missing, [], `${file} uses ${missing.join(", ")} without importing`);
    });
  }
});
