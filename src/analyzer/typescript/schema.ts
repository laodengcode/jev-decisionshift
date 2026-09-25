import ts from "typescript";
import type { FieldShape, JsonScalar, Limitation, LimitationCode, OutputShape } from "../../core/model.js";
import {
  evaluateStatic,
  hasSpread,
  objectProperty,
  originOf,
  propertyName,
  resolveExpression,
  type StaticContext,
} from "./static.js";

export interface SchemaResult {
  readonly field: FieldShape;
  readonly limitations: readonly Limitation[];
}

function unknown(code: LimitationCode, message: string): SchemaResult {
  return {
    field: { shape: { kind: "unknown", reason: code }, optional: false, nullable: false },
    limitations: [{ code, message }],
  };
}

function withFlags(result: SchemaResult, changes: Partial<Pick<FieldShape, "optional" | "nullable">>): SchemaResult {
  return { ...result, field: { ...result.field, ...changes } };
}

function normalizeZodPath(path: readonly string[]): readonly string[] {
  return path[0] === "z" ? path.slice(1) : path;
}

function scalarArray(value: unknown): value is readonly JsonScalar[] {
  return Array.isArray(value) && value.every(item => item === null || ["string", "number", "boolean"].includes(typeof item));
}

function unique(values: readonly JsonScalar[]): readonly JsonScalar[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${typeof value}:${JSON.stringify(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readSchema(expression: ts.Expression, context: StaticContext, depth = 0): SchemaResult {
  if (depth >= context.maxDepth) return unknown("ANALYSIS_BUDGET_EXCEEDED", "Schema recursion limit exceeded");
  const value = resolveExpression(expression, context, depth);
  if (!ts.isCallExpression(value)) return unknown("DYNAMIC_SCHEMA_FACTORY", "Schema is not a supported static construction");

  if (ts.isPropertyAccessExpression(value.expression) && ts.isCallExpression(value.expression.expression)) {
    const method = value.expression.name.text;
    const inner = readSchema(value.expression.expression, context, depth + 1);
    if (method === "optional") return withFlags(inner, { optional: true });
    if (method === "nullable") return withFlags(inner, { nullable: true });
    if (method === "describe") return inner;
    if (method === "strict" || method === "strip" || method === "passthrough") {
      if (inner.field.shape.kind !== "object") return unknown("UNSUPPORTED_SCHEMA", `.${method}() requires a supported object schema`);
      const extraKeys = method === "strict" ? "rejected" : method === "strip" ? "stripped" : "allowed";
      return { ...inner, field: { ...inner.field, shape: { ...inner.field.shape, extraKeys } } };
    }
    const code = ["transform", "pipe", "overwrite"].includes(method)
      ? "UNSUPPORTED_SCHEMA_TRANSFORM"
      : "UNSUPPORTED_SCHEMA";
    return unknown(code, `Unsupported schema operation: .${method}()`);
  }

  const origin = originOf(value.expression, context);
  if (!origin || origin.module !== "zod") return unknown("DYNAMIC_SCHEMA_FACTORY", "Schema factory origin could not be resolved to Zod");
  const operation = normalizeZodPath(origin.path).at(-1);

  if (operation === "boolean") return {
    field: { shape: { kind: "finite", values: [false, true] }, optional: false, nullable: false },
    limitations: [],
  };
  if (operation === "string" || operation === "number") return {
    field: { shape: { kind: "open", valueType: operation }, optional: false, nullable: false },
    limitations: [],
  };
  if (operation === "null") return {
    field: { shape: { kind: "finite", values: [null] }, optional: false, nullable: false },
    limitations: [],
  };
  if (operation === "literal") {
    const literal = value.arguments[0] && evaluateStatic(value.arguments[0], context, depth + 1);
    if (literal === null || ["string", "number", "boolean"].includes(typeof literal)) {
      return {
        field: { shape: { kind: "finite", values: [literal as JsonScalar] }, optional: false, nullable: false },
        limitations: [],
      };
    }
    return unknown("UNSUPPORTED_SCHEMA", "z.literal() value is not a supported JSON scalar");
  }
  if (operation === "enum") {
    const values = value.arguments[0] && evaluateStatic(value.arguments[0], context, depth + 1);
    if (scalarArray(values) && values.every(item => typeof item === "string")) {
      return {
        field: { shape: { kind: "finite", values }, optional: false, nullable: false },
        limitations: [],
      };
    }
    return unknown("UNSUPPORTED_SCHEMA", "z.enum() options are not a static string array");
  }
  if (operation === "union") {
    const variants = value.arguments[0] && resolveExpression(value.arguments[0], context, depth + 1);
    if (!variants || !ts.isArrayLiteralExpression(variants)) return unknown("UNSUPPORTED_SCHEMA", "z.union() variants are not a static array");
    const results = variants.elements.map(variant => readSchema(variant, context, depth + 1));
    if (results.every(result => result.field.shape.kind === "finite" && !result.field.optional)) {
      const values = results.flatMap(result => {
        const shape = result.field.shape;
        return shape.kind === "finite" ? [...shape.values, ...(result.field.nullable ? [null] : [])] : [];
      });
      return {
        field: { shape: { kind: "finite", values: unique(values) }, optional: false, nullable: false },
        limitations: results.flatMap(result => result.limitations),
      };
    }
    return unknown("UNSUPPORTED_SCHEMA", "Only unions of supported literals are handled in v0.1");
  }
  if (operation === "object") {
    const definition = value.arguments[0] && resolveExpression(value.arguments[0], context, depth + 1);
    if (!definition || !ts.isObjectLiteralExpression(definition) || hasSpread(definition)) {
      return unknown("DYNAMIC_SCHEMA_FACTORY", "z.object() shape is not a static object literal");
    }
    const fields: Record<string, FieldShape> = {};
    const limitations: Limitation[] = [];
    for (const property of definition.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        return unknown("UNSUPPORTED_SCHEMA", "Unsupported property in z.object() shape");
      }
      const name = propertyName(property.name, context);
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      if (name === undefined) return unknown("UNSUPPORTED_SCHEMA", "Computed object field could not be resolved");
      const result = readSchema(initializer, context, depth + 1);
      fields[name] = result.field;
      limitations.push(...result.limitations);
    }
    return {
      field: {
        shape: { kind: "object", fields, extraKeys: "stripped" },
        optional: false,
        nullable: false,
      },
      limitations,
    };
  }
  if (operation === "preprocess") return unknown("UNSUPPORTED_SCHEMA_TRANSFORM", "z.preprocess() changes runtime output");
  return unknown("UNSUPPORTED_SCHEMA", `Unsupported Zod construction: ${operation ?? "unknown"}`);
}

export function readOutputCall(call: ts.CallExpression, context: StaticContext): SchemaResult {
  const origin = originOf(call.expression, context);
  if (!origin || origin.module !== "ai") return unknown("UNSUPPORTED_OUTPUT", "Output helper origin could not be resolved");
  const operation = origin.path.join(".");
  const optionsExpression = call.arguments[0] && resolveExpression(call.arguments[0], context);
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return unknown("UNSUPPORTED_OUTPUT", `${operation} options are not a static object`);
  }
  if (operation.endsWith("Output.choice")) {
    const optionExpression = objectProperty(optionsExpression, "options", context);
    const options = optionExpression && evaluateStatic(optionExpression, context);
    if (scalarArray(options) && options.every(option => typeof option === "string")) {
      return {
        field: { shape: { kind: "finite", values: options }, optional: false, nullable: false },
        limitations: [],
      };
    }
    return unknown("UNSUPPORTED_OUTPUT", "Output.choice options are not a static string array");
  }
  if (operation.endsWith("Output.object")) {
    const schema = objectProperty(optionsExpression, "schema", context);
    return schema ? readSchema(schema, context) : unknown("UNSUPPORTED_OUTPUT", "Output.object has no static schema property");
  }
  return unknown("UNSUPPORTED_OUTPUT", `Unsupported AI SDK output helper: ${operation}`);
}
