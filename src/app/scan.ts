import type { AnalysisBatch } from "../core/model.js";

export interface AnalysisLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly timeoutMs: number;
  readonly maxHeapMb: number;
}

export interface AnalyzeRequest {
  readonly workspace: string;
  readonly project?: string;
  readonly excludes: readonly string[];
  readonly allowedReadRoots: readonly string[];
  readonly limits: AnalysisLimits;
}

export type AnalyzeSource = (request: AnalyzeRequest) => Promise<AnalysisBatch>;

export function scanProject(request: AnalyzeRequest, analyzeSource: AnalyzeSource): Promise<AnalysisBatch> {
  return analyzeSource(request);
}
