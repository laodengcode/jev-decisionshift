import ts from "typescript";
import type { ConsumerFact, Limitation, SourceSpan } from "../../core/model.js";
import { evaluateStatic, propertyName, unwrap, type StaticContext } from "./static.js";

interface TrackedValue {
  readonly root: "result" | "payload";
  readonly path: readonly string[];
}

export interface UsageResult {
  readonly consumers: readonly ConsumerFact[];
  readonly complete: boolean;
  readonly limitations: readonly Limitation[];
}

export type SpanFactory = (node: ts.Node) => SourceSpan;

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function transparentParent(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    current.parent
    && (
      (ts.isAwaitExpression(current.parent) && current.parent.expression === current)
      || (ts.isParenthesizedExpression(current.parent) && current.parent.expression === current)
      || (ts.isAsExpression(current.parent) && current.parent.expression === current)
      || (ts.isSatisfiesExpression(current.parent) && current.parent.expression === current)
      || (ts.isNonNullExpression(current.parent) && current.parent.expression === current)
    )
  ) current = current.parent;
  return current;
}

function identifierSymbol(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(identifier);
}

function literalProperty(expression: ts.Expression | undefined, context: StaticContext): string | undefined {
  if (!expression) return undefined;
  const value = evaluateStatic(expression, context);
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function walkScope(scope: ts.Node, visit: (node: ts.Node) => void): void {
  function walk(node: ts.Node): void {
    visit(node);
    if (node !== scope && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, walk);
  }
  walk(scope);
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
  );
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return "";
}

export function analyzeUsage(
  call: ts.CallExpression,
  api: "generateText" | "generateObject",
  context: StaticContext,
  span: SpanFactory,
): UsageResult {
  const payloadProperty = api === "generateText" ? "output" : "object";
  const scope = enclosingFunction(call) ?? call.getSourceFile();
  const tracked = new Map<ts.Symbol, TrackedValue>();
  const limitations: Limitation[] = [];
  const consumers: ConsumerFact[] = [];
  let complete = !ts.isSourceFile(scope);

  if (ts.isSourceFile(scope)) {
    limitations.push({
      code: "UNSUPPORTED_ANALYSIS_SCOPE",
      message: "Top-level result usage is not tracked completely in v0.1",
      span: span(call),
    });
  }

  function addBinding(name: ts.BindingName, value: TrackedValue): void {
    if (ts.isIdentifier(name)) {
      const symbol = identifierSymbol(name, context.checker);
      if (symbol) tracked.set(symbol, value);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const key = element.propertyName
        ? propertyName(element.propertyName, context)
        : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (key === undefined) continue;
      const child = value.root === "result" && key === payloadProperty
        ? { root: "payload" as const, path: [] }
        : { root: value.root, path: [...value.path, key] };
      addBinding(element.name, child);
    }
  }

  function trackedExpression(expression: ts.Expression): TrackedValue | undefined {
    const value = unwrap(expression);
    if (ts.isIdentifier(value)) {
      const symbol = identifierSymbol(value, context.checker);
      return symbol ? tracked.get(symbol) : undefined;
    }
    if (ts.isPropertyAccessExpression(value)) {
      const base = trackedExpression(value.expression);
      if (!base) return undefined;
      if (base.root === "result" && base.path.length === 0 && value.name.text === payloadProperty) {
        return { root: "payload", path: [] };
      }
      return { root: base.root, path: [...base.path, value.name.text] };
    }
    if (ts.isElementAccessExpression(value)) {
      const base = trackedExpression(value.expression);
      const key = literalProperty(value.argumentExpression, context);
      return base && key !== undefined ? { root: base.root, path: [...base.path, key] } : undefined;
    }
    return undefined;
  }

  let resultExpression: ts.Expression = transparentParent(call);
  let initial: TrackedValue = { root: "result", path: [] };
  if (
    resultExpression.parent
    && ts.isPropertyAccessExpression(resultExpression.parent)
    && resultExpression.parent.expression === resultExpression
    && resultExpression.parent.name.text === payloadProperty
  ) {
    resultExpression = transparentParent(resultExpression.parent);
    initial = { root: "payload", path: [] };
  }
  if (ts.isVariableDeclaration(resultExpression.parent) && resultExpression.parent.initializer === resultExpression) {
    addBinding(resultExpression.parent.name, initial);
  }

  let changed = true;
  while (changed) {
    changed = false;
    walkScope(scope, node => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      const source = trackedExpression(node.initializer);
      if (!source) return;
      const before = tracked.size;
      addBinding(node.name, source);
      changed ||= tracked.size > before;
    });
  }

  function addLimitation(limitation: Limitation): void {
    if (!limitations.some(item => item.code === limitation.code && item.span?.start === limitation.span?.start)) limitations.push(limitation);
  }

  function addConsumer(value: TrackedValue, kind: ConsumerFact["kind"], node: ts.Node): void {
    const fact: ConsumerFact = {
      fieldPath: value.path,
      kind,
      span: span(node),
      wholeResult: value.root === "result",
    };
    const key = `${fact.span.start}:${kind}:${value.root}:${value.path.join(".")}`;
    if (!consumers.some(existing => `${existing.span.start}:${existing.kind}:${existing.wholeResult ? "result" : "payload"}:${existing.fieldPath.join(".")}` === key)) {
      consumers.push(fact);
    }
    if (value.root === "result") {
      complete = false;
      addLimitation({ code: "WHOLE_RESULT_CONSUMED", message: "The application consumes data outside the structured payload", span: span(node) });
    }
  }

  function nestedCapture(node: ts.Node): boolean {
    const owner = enclosingFunction(node);
    return owner !== undefined && owner !== scope;
  }

  function visitAll(node: ts.Node): void {
    if (ts.isExpression(node)) {
      const value = trackedExpression(node);
      if (value) {
        if (ts.isIdentifier(node) && isDeclarationName(node)) {
          // Declaration, not consumption.
        } else if (
          (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
          || (ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
          || (ts.isAwaitExpression(node.parent) && node.parent.expression === node)
          || (ts.isParenthesizedExpression(node.parent) && node.parent.expression === node)
          || (ts.isAsExpression(node.parent) && node.parent.expression === node)
          || (ts.isSatisfiesExpression(node.parent) && node.parent.expression === node)
          || (ts.isNonNullExpression(node.parent) && node.parent.expression === node)
        ) {
          // A larger tracked expression owns the usage.
        } else if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) {
          // Alias propagation, not consumption.
        } else if (nestedCapture(node)) {
          complete = false;
          addLimitation({ code: "CALLBACK_CAPTURE", message: "A tracked value is captured by a nested function", span: span(node) });
        } else {
          const parent = node.parent;
          if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
            addConsumer(value, "lookup-key", node);
          } else if (
            ts.isIfStatement(parent)
            || ts.isConditionalExpression(parent)
            || ts.isWhileStatement(parent)
            || ts.isDoStatement(parent)
          ) {
            addConsumer(value, "conditional", node);
          } else if (ts.isSwitchStatement(parent) && parent.expression === node) {
            addConsumer(value, "switch", node);
          } else if (ts.isBinaryExpression(parent)) {
            if (parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
              complete = false;
              addLimitation({ code: "MUTABLE_ALIAS", message: "A tracked value is mutated", span: span(parent) });
            } else {
              addConsumer(value, "conditional", node);
            }
          } else if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
            const name = callName(parent.expression);
            if (["console.log", "console.info", "console.warn", "console.error"].includes(name)) {
              addConsumer(value, "logging", node);
            } else if (name === "JSON.stringify") {
              addConsumer(value, "serialization", node);
            } else {
              addConsumer(value, "argument", node);
              complete = false;
              addLimitation({ code: "RESULT_ESCAPES_FUNCTION", message: "A tracked value is passed to an unknown function", span: span(node) });
            }
          } else if (ts.isReturnStatement(parent)) {
            addConsumer(value, "return", node);
            complete = false;
            addLimitation({ code: "RESULT_ESCAPES_FUNCTION", message: "A tracked value is returned from the analysis scope", span: span(node) });
          } else if (ts.isJsxExpression(parent) || ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) {
            addConsumer(value, "display", node);
          } else if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) {
            complete = false;
            addLimitation({ code: "RESULT_ESCAPES_FUNCTION", message: "A tracked value is spread into another value", span: span(node) });
          } else {
            addConsumer(value, "unknown", node);
            complete = false;
            addLimitation({ code: "UNKNOWN_USAGE", message: "A tracked value has an unsupported local use", span: span(node) });
          }
        }
      } else if (ts.isElementAccessExpression(node) && trackedExpression(node.expression) && literalProperty(node.argumentExpression, context) === undefined) {
        complete = false;
        addLimitation({ code: "UNRESOLVED_COMPUTED_ACCESS", message: "Computed property access could not be resolved", span: span(node) });
      }
    }
    ts.forEachChild(node, visitAll);
  }
  visitAll(scope);

  return { consumers, complete, limitations };
}
