import { createHash } from "node:crypto";
import { assessCall, classifyOutput, type Assessment } from "./core/rules.js";
import type {
  AnalysisBatch,
  CallFacts,
  ConsumerFact,
  Coverage,
  Diagnostic,
  ExecutionFacts,
  Limitation,
  OutputShape,
  SourceSpan,
} from "./core/model.js";

export const TOOL_VERSION = "0.1.0";
export const RULESET_VERSION = "1";

export interface FindingV1 {
  readonly id: string;
  readonly contractFingerprint: string;
  readonly api: CallFacts["api"];
  readonly provenance: CallFacts["provenance"];
  readonly location: SourceSpan;
  readonly outputShape: OutputShape;
  readonly outputClassification: ReturnType<typeof classifyOutput>;
  readonly consumers: readonly ConsumerFact[];
  readonly usageComplete: boolean;
  readonly execution: ExecutionFacts;
  readonly limitations: readonly Limitation[];
  readonly assessments: readonly Assessment[];
}

export interface ReportV1 {
  readonly schemaVersion: "1";
  readonly toolVersion: string;
  readonly rulesetVersion: string;
  readonly analyzerCapabilities: readonly string[];
  readonly scanStatus: "complete" | "incomplete";
  readonly coverage: Coverage;
  readonly findings: readonly FindingV1[];
  readonly diagnostics: readonly Diagnostic[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finding(call: CallFacts): FindingV1 {
  const assessments = assessCall(call);
  const rules = assessments.map(item => item.rule).sort().join(",");
  return {
    id: hash(`${call.span.file}\0${call.span.start}\0${rules}`).slice(0, 16),
    contractFingerprint: hash(canonical(call.outputShape)).slice(0, 16),
    api: call.api,
    provenance: call.provenance,
    location: call.span,
    outputShape: call.outputShape,
    outputClassification: classifyOutput(call.outputShape),
    consumers: [...call.consumers].sort((a, b) => a.span.start - b.span.start),
    usageComplete: call.usageComplete,
    execution: call.execution,
    limitations: call.limitations,
    assessments,
  };
}

export function createReport(batch: AnalysisBatch): ReportV1 {
  return {
    schemaVersion: "1",
    toolVersion: TOOL_VERSION,
    rulesetVersion: RULESET_VERSION,
    analyzerCapabilities: [
      "typescript",
      "ai-sdk-generate-text-output",
      "ai-sdk-legacy-generate-object",
      "zod-static-subset",
      "intraprocedural-consumers",
    ],
    scanStatus: batch.incomplete ? "incomplete" : "complete",
    coverage: batch.coverage,
    findings: [...batch.calls]
      .sort((a, b) => a.span.file.localeCompare(b.span.file) || a.span.start - b.span.start)
      .map(finding),
    diagnostics: [...batch.diagnostics].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code)),
  };
}

export function incompleteReport(code: string, message: string): ReportV1 {
  return createReport({
    calls: [],
    coverage: {
      filesEligible: 0,
      filesAnalyzed: 0,
      filesSkipped: 0,
      recognizedCalls: 0,
      supportedCalls: 0,
      unresolvedCalls: 0,
    },
    diagnostics: [{ code, message }],
    incomplete: true,
  });
}

function describeShape(shape: OutputShape): string {
  if (shape.kind === "finite") return shape.values.map(value => JSON.stringify(value)).join(" | ");
  if (shape.kind === "open") return `open ${shape.valueType}`;
  if (shape.kind === "unknown") return `unknown (${shape.reason})`;
  return Object.entries(shape.fields)
    .map(([name, field]) => `${name}${field.optional ? "?" : ""}: ${describeShape(field.shape)}${field.nullable ? " | null" : ""}`)
    .join(", ");
}

function findingText(finding: FindingV1): string[] {
  const lines = [
    `${finding.location.file}:${finding.location.line}:${finding.location.column}`,
    "",
    finding.assessments.map(item => `${item.rule} ${item.message}`).join("\n"),
    "",
    `Declared output: ${describeShape(finding.outputShape)}`,
  ];
  if (finding.consumers.length) {
    lines.push("Observed consumption:");
    for (const consumer of finding.consumers) {
      const target = consumer.wholeResult ? "$result" : ["output", ...consumer.fieldPath].join(".");
      lines.push(`  ${consumer.kind}: ${target} (${consumer.span.file}:${consumer.span.line})`);
    }
  } else lines.push("Observed consumption: none in the supported local scope");
  lines.push(`Analysis scope: ${finding.usageComplete ? "local references accounted for" : "partial"}`);
  if (finding.limitations.length) {
    lines.push("Limitations:");
    for (const limitation of finding.limitations) lines.push(`  ${limitation.code}: ${limitation.message}`);
  }
  return lines;
}

export function renderTerminal(report: ReportV1): string {
  const header = `DecisionShift ${report.toolVersion} — ${report.coverage.recognizedCalls} recognized AI SDK call site(s)`;
  const sections = report.findings.map(item => findingText(item).join("\n"));
  const diagnostics = report.diagnostics.map(item => `${item.code}${item.file ? ` ${item.file}` : ""}: ${item.message}`);
  return [header, ...sections, ...(diagnostics.length ? ["Diagnostics:\n" + diagnostics.join("\n")] : [])].join("\n\n") + "\n";
}

export function renderMarkdown(report: ReportV1): string {
  const lines = [
    "# DecisionShift scan",
    "",
    `Status: **${report.scanStatus}**`,
    "",
    `Recognized ${report.coverage.recognizedCalls} AI SDK call site(s); ${report.coverage.supportedCalls} had supported output contracts.`,
  ];
  for (const item of report.findings) {
    lines.push("", `## ${item.location.file}:${item.location.line}`, "", "```text", ...findingText(item), "```");
  }
  if (report.diagnostics.length) {
    lines.push("", "## Diagnostics", "");
    for (const diagnostic of report.diagnostics) lines.push(`- \`${diagnostic.code}\`: ${diagnostic.message}`);
  }
  return lines.join("\n") + "\n";
}

export function renderJson(report: ReportV1): string {
  return JSON.stringify(report, null, 2) + "\n";
}
