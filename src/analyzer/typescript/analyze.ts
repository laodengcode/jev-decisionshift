import { createHash } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import ts from "typescript";
import type { AnalyzeRequest } from "../../app/scan.js";
import { classifyOutput } from "../../core/rules.js";
import type {
  AnalysisBatch,
  CallFacts,
  ExecutionFacts,
  Limitation,
  LimitationCode,
  OutputShape,
  SourceSpan,
} from "../../core/model.js";
import { loadProject } from "./host.js";
import { readOutputCall, readSchema } from "./schema.js";
import {
  evaluateStatic,
  hasSpread,
  objectProperty,
  originOf,
  propertyName,
  resolveExpression,
  type StaticContext,
} from "./static.js";
import { analyzeUsage } from "./usage.js";

function real(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function finite(values: readonly (string | number | boolean | null)[]): OutputShape {
  return { kind: "finite", values };
}

function unknown(reason: LimitationCode): OutputShape {
  return { kind: "unknown", reason };
}

function staticStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function dedupeLimitations(limitations: readonly Limitation[]): readonly Limitation[] {
  const seen = new Set<string>();
  return limitations.filter(item => {
    const key = `${item.code}:${item.span?.file ?? ""}:${item.span?.start ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function executionFacts(
  options: ts.ObjectLiteralExpression | undefined,
  context: StaticContext,
  spread: boolean,
): { facts: ExecutionFacts; limitations: Limitation[] } {
  if (!options) return {
    facts: { tools: "unknown", multiStep: "unknown", hooks: "unknown" },
    limitations: [],
  };
  const tools = objectProperty(options, "tools", context);
  const resolvedTools = tools && resolveExpression(tools, context);
  const toolState = tools
    ? resolvedTools && ts.isObjectLiteralExpression(resolvedTools) && resolvedTools.properties.length === 0 ? "no" : "yes"
    : spread ? "unknown" : "no";
  const multiStep = objectProperty(options, "stopWhen", context) || objectProperty(options, "maxSteps", context)
    ? "yes"
    : spread ? "unknown" : "no";
  const hooks = options.properties.some(property => {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = propertyName(property.name, context);
    return name?.startsWith("on") ?? false;
  }) ? "yes" : spread ? "unknown" : "no";
  const limitations: Limitation[] = [];
  if (toolState === "yes") limitations.push({ code: "TOOL_EXECUTION_PRESENT", message: "The call configures tools" });
  if (multiStep === "yes") limitations.push({ code: "MULTI_STEP_EXECUTION_PRESENT", message: "The call configures multi-step execution" });
  if (hooks === "yes") limitations.push({ code: "HOOK_EXECUTION_PRESENT", message: "The call configures lifecycle hooks" });
  return { facts: { tools: toolState, multiStep, hooks }, limitations };
}

export async function analyzeTypeScript(request: AnalyzeRequest): Promise<AnalysisBatch> {
  const loaded = loadProject(request);
  const checker = loaded.program.getTypeChecker();
  const context: StaticContext = { checker, program: loaded.program, maxDepth: request.limits.maxDepth };
  const calls: CallFacts[] = [];
  let filesAnalyzed = 0;

  for (const sourceFile of loaded.program.getSourceFiles()) {
    if (!loaded.eligibleFiles.has(real(sourceFile.fileName))) continue;
    filesAnalyzed++;
    const fileHash = createHash("sha256").update(sourceFile.text).digest("hex");
    const relativeFile = path.relative(loaded.workspace, real(sourceFile.fileName)).split(path.sep).join("/");
    const span = (node: ts.Node): SourceSpan => {
      const start = node.getStart(sourceFile);
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        file: relativeFile,
        start,
        end: node.getEnd(),
        line: position.line + 1,
        column: position.character + 1,
        fileHash,
      };
    };

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const origin = originOf(node.expression, context);
        const apiName = origin?.module === "ai" ? origin.path.at(-1) : undefined;
        if (apiName === "generateText" || apiName === "generateObject") {
          const api = apiName;
          const limitations: Limitation[] = [];
          const optionExpression = node.arguments[0] && resolveExpression(node.arguments[0], context);
          const options = optionExpression && ts.isObjectLiteralExpression(optionExpression) ? optionExpression : undefined;
          const spread = options ? hasSpread(options) : false;
          if (spread) limitations.push({
            code: "UNKNOWN_OPTIONS_SPREAD",
            message: "An options spread may change relevant call behavior",
            span: span(node),
          });

          let outputShape: OutputShape;
          if (!options) {
            outputShape = unknown("UNSUPPORTED_OUTPUT");
            limitations.push({ code: "UNSUPPORTED_OUTPUT", message: "Call options are not a static object", span: span(node) });
          } else if (api === "generateText") {
            const outputExpression = objectProperty(options, "output", context);
            const resolvedOutput = outputExpression && resolveExpression(outputExpression, context);
            if (resolvedOutput && ts.isCallExpression(resolvedOutput)) {
              const output = readOutputCall(resolvedOutput, context);
              outputShape = output.field.shape;
              limitations.push(...output.limitations.map(item => ({ ...item, span: span(resolvedOutput) })));
            } else {
              outputShape = unknown("UNSUPPORTED_OUTPUT");
              limitations.push({ code: "UNSUPPORTED_OUTPUT", message: "generateText has no supported static output helper", span: span(node) });
            }
          } else {
            const outputModeExpression = objectProperty(options, "output", context);
            const outputMode = outputModeExpression && evaluateStatic(outputModeExpression, context);
            if (outputMode === "enum") {
              const enumExpression = objectProperty(options, "enum", context);
              const values = enumExpression && staticStringArray(evaluateStatic(enumExpression, context));
              if (values) outputShape = finite(values);
              else {
                outputShape = unknown("UNSUPPORTED_OUTPUT");
                limitations.push({ code: "UNSUPPORTED_OUTPUT", message: "Legacy enum options are not a static string array", span: span(node) });
              }
            } else if (outputMode === undefined || outputMode === "object") {
              const schemaExpression = objectProperty(options, "schema", context);
              if (schemaExpression) {
                const schema = readSchema(schemaExpression, context);
                outputShape = schema.field.shape;
                limitations.push(...schema.limitations.map(item => ({ ...item, span: span(schemaExpression) })));
              } else {
                outputShape = unknown("UNSUPPORTED_OUTPUT");
                limitations.push({ code: "UNSUPPORTED_OUTPUT", message: "Legacy object call has no supported schema", span: span(node) });
              }
            } else {
              outputShape = unknown("UNSUPPORTED_OUTPUT");
              limitations.push({ code: "UNSUPPORTED_OUTPUT", message: `Unsupported legacy output mode: ${String(outputMode)}`, span: span(node) });
            }
          }

          const execution = executionFacts(options, context, spread);
          limitations.push(...execution.limitations.map(item => ({ ...item, span: span(node) })));
          const usage = analyzeUsage(node, api, context, span);
          limitations.push(...usage.limitations);
          calls.push({
            api,
            provenance: origin?.provenance ?? "import-syntax",
            span: span(node),
            outputShape,
            consumers: usage.consumers,
            usageComplete: usage.complete,
            execution: execution.facts,
            limitations: dedupeLimitations(limitations),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const supportedCalls = calls.filter(call => classifyOutput(call.outputShape) !== "unknown").length;
  return {
    calls,
    coverage: {
      filesEligible: loaded.eligibleFiles.size,
      filesAnalyzed,
      filesSkipped: loaded.eligibleFiles.size - filesAnalyzed,
      recognizedCalls: calls.length,
      supportedCalls,
      unresolvedCalls: calls.length - supportedCalls,
    },
    diagnostics: loaded.diagnostics,
    incomplete: loaded.incomplete,
  };
}
