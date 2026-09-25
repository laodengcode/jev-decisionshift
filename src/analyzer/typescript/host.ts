import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import ts from "typescript";
import type { AnalyzeRequest } from "../../app/scan.js";
import type { Diagnostic } from "../../core/model.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ALWAYS_SKIP = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export interface LoadedProject {
  readonly program: ts.Program;
  readonly workspace: string;
  readonly eligibleFiles: ReadonlySet<string>;
  readonly diagnostics: Diagnostic[];
  readonly incomplete: boolean;
}

function real(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function relativePath(workspace: string, file: string): string {
  return path.relative(workspace, file).split(path.sep).join("/");
}

function createIgnore(workspace: string, excludes: readonly string[]): Ignore {
  const matcher = ignore();
  for (const name of [".gitignore", ".decisionshiftignore"]) {
    const file = path.join(workspace, name);
    if (existsSync(file)) matcher.add(readFileSync(file, "utf8"));
  }
  matcher.add(excludes);
  return matcher;
}

function discover(workspace: string, matcher: Ignore, maxFiles: number): { files: string[]; exceeded: boolean } {
  const files: string[] = [];
  const visitedDirectories = new Set<string>();
  let exceeded = false;

  function walk(directory: string): void {
    if (exceeded) return;
    const resolvedDirectory = real(directory);
    if (visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    for (const entry of readdirSync(resolvedDirectory, { withFileTypes: true })) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const candidate = path.join(resolvedDirectory, entry.name);
      const relative = relativePath(workspace, candidate);
      if (matcher.ignores(relative + (entry.isDirectory() ? "/" : ""))) continue;
      if (entry.isSymbolicLink()) {
        const target = real(candidate);
        if (!isInside(target, workspace)) continue;
        const stats = statSync(target);
        if (stats.isDirectory()) walk(target);
        else if (SOURCE_EXTENSIONS.has(path.extname(target))) files.push(target);
      } else if (entry.isDirectory()) {
        walk(candidate);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(candidate);
      }
      if (files.length > maxFiles) {
        exceeded = true;
        return;
      }
    }
  }

  walk(workspace);
  return { files: files.slice(0, maxFiles), exceeded };
}

export function loadProject(request: AnalyzeRequest): LoadedProject {
  const workspace = real(request.workspace);
  const diagnostics: Diagnostic[] = [];
  const compilerOptionsForLib: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
  const compilerLib = real(path.dirname(ts.getDefaultLibFilePath(compilerOptionsForLib)));
  const allowedRoots = [workspace, compilerLib, ...request.allowedReadRoots.map(real)];
  const denied = new Set<string>();
  let incomplete = false;

  function allowed(file: string): boolean {
    const resolved = real(file);
    return allowedRoots.some(root => isInside(resolved, root));
  }

  function fileExists(file: string): boolean {
    if (allowed(file)) return ts.sys.fileExists(file);
    if (ts.sys.fileExists(file)) denied.add(file);
    return false;
  }

  function readFile(file: string): string | undefined {
    if (!allowed(file)) {
      if (existsSync(file)) denied.add(file);
      return undefined;
    }
    if (!existsSync(file)) return undefined;
    try {
      if (statSync(file).size > request.limits.maxFileBytes) {
        incomplete = true;
        diagnostics.push({
          code: "FILE_TOO_LARGE",
          message: `Skipped file larger than ${request.limits.maxFileBytes} bytes`,
          ...(isInside(real(file), workspace) ? { file: relativePath(workspace, real(file)) } : {}),
        });
        return undefined;
      }
      return readFileSync(file, "utf8");
    } catch (error) {
      diagnostics.push({ code: "READ_FAILED", message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  const matcher = createIgnore(workspace, request.excludes);
  const requestedConfig = request.project
    ? path.resolve(workspace, request.project)
    : path.join(workspace, "tsconfig.json");
  let rootNames: string[];
  let options: ts.CompilerOptions;
  let eligible: string[];

  if (existsSync(requestedConfig)) {
    const config = ts.readConfigFile(requestedConfig, readFile);
    if (config.error) diagnostics.push(toDiagnostic(config.error, workspace));

    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readFile,
      fileExists,
      readDirectory: (rootDir, extensions, excludes, includes, depth) => {
        if (!allowed(rootDir)) return [];
        return ts.sys
          .readDirectory(rootDir, extensions, excludes, includes, depth)
          .filter(file => allowed(file));
      },
      trace: () => undefined,
    };
    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, parseHost, path.dirname(requestedConfig));
    diagnostics.push(...parsed.errors.map(error => toDiagnostic(error, workspace)));
    if (parsed.projectReferences?.length) {
      diagnostics.push({
        code: "PROJECT_REFERENCES_NOT_TRAVERSED",
        message: "Project references are not traversed in v0.1; select a leaf tsconfig with --project",
      });
    }
    const { plugins: _plugins, incremental: _incremental, tsBuildInfoFile: _tsBuildInfoFile, ...safeOptions } = parsed.options;
    options = { ...safeOptions, noEmit: true };
    rootNames = parsed.fileNames.filter(allowed);
    eligible = rootNames.filter(file => {
      const resolved = real(file);
      return isInside(resolved, workspace)
        && SOURCE_EXTENSIONS.has(path.extname(resolved))
        && !matcher.ignores(relativePath(workspace, resolved));
    });
  } else {
    if (request.project) {
      diagnostics.push({ code: "CONFIG_NOT_FOUND", message: `TypeScript config not found: ${request.project}` });
      incomplete = true;
    }
    const discovered = discover(workspace, matcher, request.limits.maxFiles);
    rootNames = discovered.files;
    eligible = discovered.files;
    incomplete ||= discovered.exceeded;
    if (discovered.exceeded) {
      diagnostics.push({ code: "FILE_LIMIT_EXCEEDED", message: `More than ${request.limits.maxFiles} source files found` });
    }
    options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
      noEmit: true,
    };
  }

  if (rootNames.length > request.limits.maxFiles) {
    rootNames = rootNames.slice(0, request.limits.maxFiles);
    eligible = eligible.filter(file => rootNames.includes(file));
    incomplete = true;
    diagnostics.push({ code: "FILE_LIMIT_EXCEEDED", message: `Project exceeds the ${request.limits.maxFiles} file limit` });
  }

  const baseHost = ts.createCompilerHost(options, true);
  baseHost.readFile = readFile;
  baseHost.fileExists = fileExists;
  baseHost.directoryExists = directory => allowed(directory) && (ts.sys.directoryExists?.(directory) ?? false);
  baseHost.getDirectories = directory => allowed(directory)
    ? (ts.sys.getDirectories?.(directory) ?? []).filter(child => allowed(child))
    : [];
  baseHost.realpath = file => real(file);
  baseHost.writeFile = () => undefined;

  const program = ts.createProgram({ rootNames, options, host: baseHost });
  for (const file of denied) {
    diagnostics.push({
      code: "OUTSIDE_WORKSPACE_DENIED",
      message: `Denied compiler read outside configured roots: ${path.basename(file)}`,
    });
  }
  if (rootNames.length === 0) diagnostics.push({ code: "NO_SOURCE_FILES", message: "No eligible TypeScript source files found" });

  return {
    program,
    workspace,
    eligibleFiles: new Set(eligible.map(real)),
    diagnostics,
    incomplete,
  };
}

function toDiagnostic(diagnostic: ts.Diagnostic, workspace: string): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file) return { code: `TS${diagnostic.code}`, message };
  return {
    code: `TS${diagnostic.code}`,
    message,
    file: relativePath(workspace, real(diagnostic.file.fileName)),
  };
}
