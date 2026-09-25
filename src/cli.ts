#!/usr/bin/env node
import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AnalysisLimits, AnalyzeRequest } from "./app/scan.js";
import {
  incompleteReport,
  renderJson,
  renderMarkdown,
  renderTerminal,
  TOOL_VERSION,
  type ReportV1,
} from "./report.js";

const DEFAULT_LIMITS: AnalysisLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 20_000,
  maxDepth: 32,
  timeoutMs: 120_000,
  maxHeapMb: 1024,
};

interface Config {
  readonly project?: string;
  readonly exclude?: readonly string[];
  readonly allowedReadRoots?: readonly string[];
  readonly limits?: Partial<AnalysisLimits>;
}

function usage(): string {
  return `DecisionShift ${TOOL_VERSION}

Usage:
  decisionshift scan [path] [--project tsconfig.json]
                     [--format terminal|json|markdown] [--output file]

The scanner reads TypeScript source but never executes target code.
`;
}

function positiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function stringArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`${name} must be an array of strings`);
  return value;
}

function loadConfig(workspace: string): Config {
  const file = path.join(workspace, "decisionshift.json");
  if (!existsSync(file)) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decisionshift.json must contain an object");
  const object = value as Record<string, unknown>;
  const known = new Set(["project", "exclude", "allowedReadRoots", "limits"]);
  const extra = Object.keys(object).find(key => !known.has(key));
  if (extra) throw new Error(`Unknown decisionshift.json property: ${extra}`);
  if (object.project !== undefined && typeof object.project !== "string") throw new Error("project must be a string");
  const limitsValue = object.limits;
  let limits: Partial<AnalysisLimits> | undefined;
  if (limitsValue !== undefined) {
    if (!limitsValue || typeof limitsValue !== "object" || Array.isArray(limitsValue)) throw new Error("limits must be an object");
    const raw = limitsValue as Record<string, unknown>;
    const limitNames = new Set(Object.keys(DEFAULT_LIMITS));
    const unknown = Object.keys(raw).find(key => !limitNames.has(key));
    if (unknown) throw new Error(`Unknown limits property: ${unknown}`);
    limits = {
      ...(positiveNumber(raw.maxFileBytes, "limits.maxFileBytes") !== undefined ? { maxFileBytes: raw.maxFileBytes as number } : {}),
      ...(positiveNumber(raw.maxFiles, "limits.maxFiles") !== undefined ? { maxFiles: raw.maxFiles as number } : {}),
      ...(positiveNumber(raw.maxDepth, "limits.maxDepth") !== undefined ? { maxDepth: raw.maxDepth as number } : {}),
      ...(positiveNumber(raw.timeoutMs, "limits.timeoutMs") !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
      ...(positiveNumber(raw.maxHeapMb, "limits.maxHeapMb") !== undefined ? { maxHeapMb: raw.maxHeapMb as number } : {}),
    };
  }
  return {
    ...(typeof object.project === "string" ? { project: object.project } : {}),
    ...(object.exclude !== undefined ? { exclude: stringArray(object.exclude, "exclude")! } : {}),
    ...(object.allowedReadRoots !== undefined ? { allowedReadRoots: stringArray(object.allowedReadRoots, "allowedReadRoots")! } : {}),
    ...(limits ? { limits } : {}),
  };
}

function runWorker(request: AnalyzeRequest): Promise<ReportV1> {
  return new Promise(resolve => {
    const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
    const child = fork(workerFile, [], {
      execArgv: [`--max-old-space-size=${request.limits.maxHeapMb}`],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let settled = false;
    const finish = (report: ReportV1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      resolve(report);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(incompleteReport("ANALYSIS_TIMEOUT", `Analysis exceeded ${request.limits.timeoutMs}ms`));
    }, request.limits.timeoutMs);
    child.on("message", (message: unknown) => {
      const result = message as { ok?: boolean; report?: ReportV1; error?: string };
      finish(result.ok && result.report
        ? result.report
        : incompleteReport("ANALYZER_FAILED", result.error ?? "Analyzer worker failed"));
    });
    child.on("error", error => finish(incompleteReport("ANALYZER_FAILED", error.message)));
    child.on("exit", code => {
      if (!settled) finish(incompleteReport("ANALYZER_EXITED", `Analyzer worker exited with code ${code ?? "unknown"}`));
    });
    child.send(request);
  });
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        project: { type: "string" },
        format: { type: "string", default: "terminal" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    if (parsed.values.help) {
      process.stdout.write(usage());
      return;
    }
    if (parsed.values.version) {
      process.stdout.write(`${TOOL_VERSION}\n`);
      return;
    }
    if (parsed.positionals[0] !== "scan" || parsed.positionals.length > 2) throw new Error(usage());
    const workspace = path.resolve(parsed.positionals[1] ?? ".");
    const config = loadConfig(workspace);
    const format = parsed.values.format;
    if (format !== "terminal" && format !== "json" && format !== "markdown") throw new Error(`Unsupported format: ${format}`);
    const limits = { ...DEFAULT_LIMITS, ...config.limits };
    const request: AnalyzeRequest = {
      workspace,
      ...(parsed.values.project || config.project ? { project: parsed.values.project ?? config.project } : {}),
      excludes: config.exclude ?? [],
      allowedReadRoots: (config.allowedReadRoots ?? []).map(root => path.resolve(workspace, root)),
      limits,
    };
    const report = await runWorker(request);
    const rendered = format === "json" ? renderJson(report) : format === "markdown" ? renderMarkdown(report) : renderTerminal(report);
    if (parsed.values.output) writeFileSync(path.resolve(parsed.values.output), rendered, "utf8");
    else process.stdout.write(rendered);
    process.exitCode = report.scanStatus === "incomplete" ? 3 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

void main();
