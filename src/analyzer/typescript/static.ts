import path from "node:path";
import ts from "typescript";
import type { JsonScalar } from "../../core/model.js";

export interface Origin {
  readonly module: "ai" | "zod";
  readonly path: readonly string[];
  readonly provenance: "symbol-resolved" | "import-syntax";
}

export interface StaticContext {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly maxDepth: number;
}

function moduleOfDeclaration(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current) && !ts.isExportDeclaration(current)) current = current.parent;
  const specifier = current?.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

function directOrigin(symbol: ts.Symbol): Origin | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const module = moduleOfDeclaration(declaration);
    if (module !== "ai" && module !== "zod") continue;

    if (ts.isImportSpecifier(declaration)) {
      return {
        module,
        path: [(declaration.propertyName ?? declaration.name).text],
        provenance: "import-syntax",
      };
    }
    if (ts.isNamespaceImport(declaration)) return { module, path: [], provenance: "import-syntax" };
    if (ts.isImportClause(declaration)) return { module, path: [], provenance: "import-syntax" };
    if (ts.isExportSpecifier(declaration)) {
      return {
        module,
        path: [(declaration.propertyName ?? declaration.name).text],
        provenance: "import-syntax",
      };
    }
  }
  return undefined;
}

function originFromSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, seen: Set<ts.Symbol>): Origin | undefined {
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  const direct = directOrigin(symbol);
  if (direct) return direct;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const target = checker.getAliasedSymbol(symbol);
    if (target !== symbol) {
      const resolved = originFromSymbol(checker, target, seen);
      if (resolved) return { ...resolved, provenance: "symbol-resolved" };
    }
  }
  return undefined;
}

function sourceForRelativeModule(from: ts.SourceFile, moduleName: string, program: ts.Program): ts.SourceFile | undefined {
  if (!moduleName.startsWith(".")) return undefined;
  const requested = path.resolve(path.dirname(from.fileName), moduleName).replace(/\.(?:mjs|cjs|js|mts|cts|tsx|ts)$/, "");
  return program.getSourceFiles().find(source =>
    source.fileName.replace(/\.(?:mjs|cjs|js|mts|cts|tsx|ts)$/, "") === requested,
  );
}

function originOfExport(
  source: ts.SourceFile,
  exportedName: string,
  context: StaticContext,
  seen: Set<string>,
): Origin | undefined {
  const key = `${source.fileName}:${exportedName}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const element = statement.exportClause.elements.find(item => item.name.text === exportedName);
    if (!element) continue;
    const originalName = (element.propertyName ?? element.name).text;
    const moduleName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    if (moduleName === "ai" || moduleName === "zod") {
      return { module: moduleName, path: [originalName], provenance: "symbol-resolved" };
    }
    if (moduleName) {
      const target = sourceForRelativeModule(source, moduleName, context.program);
      if (target) return originOfExport(target, originalName, context, seen);
    } else {
      const symbol = context.checker.getSymbolAtLocation(element.propertyName ?? element.name);
      if (symbol) {
        const origin = originFromSymbol(context.checker, symbol, new Set());
        if (origin) return { ...origin, provenance: "symbol-resolved" };
      }
    }
  }
  return undefined;
}

function relativeImportOrigin(identifier: ts.Identifier, context: StaticContext): Origin | undefined {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    const moduleName = moduleOfDeclaration(declaration);
    if (!moduleName?.startsWith(".")) continue;
    const target = sourceForRelativeModule(identifier.getSourceFile(), moduleName, context.program);
    if (!target) continue;
    const exportedName = (declaration.propertyName ?? declaration.name).text;
    const origin = originOfExport(target, exportedName, context, new Set());
    if (origin) return origin;
  }
  return undefined;
}

export function originOf(expression: ts.Expression, context: StaticContext): Origin | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const symbol = context.checker.getSymbolAtLocation(value);
    return (symbol ? originFromSymbol(context.checker, symbol, new Set()) : undefined)
      ?? relativeImportOrigin(value, context);
  }
  if (ts.isPropertyAccessExpression(value)) {
    const base = originOf(value.expression, context);
    return base ? { ...base, path: [...base.path, value.name.text] } : undefined;
  }
  return undefined;
}

export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  return current;
}

function constInitializer(identifier: ts.Identifier, context: StaticContext): ts.Expression | undefined {
  let symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
    const list = declaration.parent;
    if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const)) return declaration.initializer;
  }
  return undefined;
}

export function resolveExpression(
  expression: ts.Expression,
  context: StaticContext,
  depth = 0,
  seen = new Set<ts.Node>(),
): ts.Expression {
  const value = unwrap(expression);
  if (depth >= context.maxDepth || seen.has(value) || !ts.isIdentifier(value)) return value;
  const initializer = constInitializer(value, context);
  if (!initializer) return value;
  seen.add(value);
  return resolveExpression(initializer, context, depth + 1, seen);
}

export interface StaticObject {
  readonly [key: string]: StaticValue;
}

export type StaticValue = JsonScalar | readonly StaticValue[] | StaticObject;

export function evaluateStatic(
  expression: ts.Expression,
  context: StaticContext,
  depth = 0,
  seen = new Set<ts.Node>(),
): StaticValue | undefined {
  if (depth >= context.maxDepth) return undefined;
  const value = resolveExpression(expression, context, depth, seen);
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    if (value.operator === ts.SyntaxKind.MinusToken) return -number;
    if (value.operator === ts.SyntaxKind.PlusToken) return number;
  }
  if (ts.isArrayLiteralExpression(value)) {
    const items: StaticValue[] = [];
    for (const item of value.elements) {
      if (ts.isSpreadElement(item)) return undefined;
      const evaluated = evaluateStatic(item, context, depth + 1, new Set(seen));
      if (evaluated === undefined) return undefined;
      items.push(evaluated);
    }
    return items;
  }
  if (ts.isObjectLiteralExpression(value)) {
    const object: Record<string, StaticValue> = {};
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = propertyName(property.name, context);
      const evaluated = evaluateStatic(property.initializer, context, depth + 1, new Set(seen));
      if (key === undefined || evaluated === undefined) return undefined;
      object[key] = evaluated;
    }
    return object;
  }
  return undefined;
}

export function propertyName(name: ts.PropertyName, context: StaticContext): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const value = evaluateStatic(name.expression, context);
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return undefined;
}

export function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  context: StaticContext,
): ts.Expression | undefined {
  let result: ts.Expression | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = undefined;
      continue;
    }
    if (ts.isPropertyAssignment(property) && propertyName(property.name, context) === name) result = property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) result = property.name;
  }
  return result;
}

export function hasSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(ts.isSpreadAssignment);
}
