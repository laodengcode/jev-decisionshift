import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? files(candidate) : entry.name.endsWith(".ts") ? [candidate] : [];
  });
}

test("core and app do not import compiler or presentation code", () => {
  const roots = [path.resolve("src/core"), path.resolve("src/app")];
  const violations: string[] = [];
  for (const file of roots.flatMap(files)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.includes("analyzer") || specifier.includes("report") || specifier === "typescript" || specifier.startsWith("node:")) {
        violations.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
