import assert from "node:assert/strict";
import { parse } from "acorn";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "extension");
const MODULE_DIRECTORIES = ["src", "popup", "calendar", "options", "reconcile", "background", "usage", "content"];

function jsFiles(directory) {
  if (!existsSync(join(extensionRoot, directory))) return [];
  return readdirSync(join(extensionRoot, directory))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `${directory}/${name}`);
}

function parseModule(file) {
  return parse(readFileSync(join(extensionRoot, file), "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module"
  });
}

function walk(node, visit, parent = null, key = "") {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parent, key);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const [childKey, child] of Object.entries(node)) {
    if (childKey === "type") continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, node, childKey);
    } else {
      walk(child, visit, node, childKey);
    }
  }
}

function addPatternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    names.add(pattern.name);
  } else if (pattern.type === "AssignmentPattern") {
    addPatternNames(pattern.left, names);
  } else if (pattern.type === "RestElement") {
    addPatternNames(pattern.argument, names);
  } else if (pattern.type === "ArrayPattern") {
    for (const item of pattern.elements) addPatternNames(item, names);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) addPatternNames(property.value, names);
  }
}

function declaredNames(program) {
  const names = new Set();
  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) names.add(specifier.local.name);
    } else if (node.type === "VariableDeclarator") {
      addPatternNames(node.id, names);
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id) names.add(node.id.name);
      for (const parameter of node.params) addPatternNames(parameter, names);
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.id) names.add(node.id.name);
    } else if (node.type === "CatchClause") {
      addPatternNames(node.param, names);
    }
  });
  return names;
}

function exportedNames(program) {
  const names = new Set();
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) addPatternNames(declaration.id, names);
    } else if (statement.declaration?.id) {
      names.add(statement.declaration.id.name);
    }
    for (const specifier of statement.specifiers) names.add(specifier.exported.name);
  }
  return names;
}

function isIdentifierReference(node, parent, key) {
  if (node.type !== "Identifier") return false;
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if (parent?.type === "Property" && key === "key" && !parent.computed) return false;
  if ((parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && key === "key" && !parent.computed) return false;
  if (parent?.type === "ImportSpecifier" && key === "imported") return false;
  if (parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") return false;
  if (parent?.type === "ExportSpecifier" && key === "exported") return false;
  return true;
}

const sourceFiles = MODULE_DIRECTORIES.flatMap(jsFiles);
const programs = new Map(sourceFiles.map((file) => [file, parseModule(file)]));
const exportedBy = new Map();
for (const file of sourceFiles.filter((file) => file.startsWith("src/"))) {
  for (const name of exportedNames(programs.get(file))) exportedBy.set(name, file);
}

describe("module imports", () => {
  // A missing import is silent until the line runs, which is how a broken Save
  // button reached a release: the calendar used fromLocalInputValue without
  // importing it, so submitting threw before anything was written.
  for (const file of sourceFiles) {
    it(`${file} imports every shared name it uses`, () => {
      const program = programs.get(file);
      const declared = declaredNames(program);
      const missing = new Set();
      walk(program, (node, parent, key) => {
        if (!isIdentifierReference(node, parent, key)) return;
        if (exportedBy.get(node.name) === file || declared.has(node.name)) return;
        if (exportedBy.has(node.name)) missing.add(node.name);
      });
      assert.deepEqual([...missing].sort(), [], `${file} uses ${[...missing].join(", ")} without importing`);
    });
  }
});
