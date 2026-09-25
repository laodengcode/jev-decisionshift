export type JsonScalar = string | number | boolean | null;

export interface SourceSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly fileHash: string;
}

export type LimitationCode =
  | "DYNAMIC_SCHEMA_FACTORY"
  | "UNRESOLVED_IMPORT"
  | "RESULT_ESCAPES_FUNCTION"
  | "MUTABLE_ALIAS"
  | "UNKNOWN_OPTIONS_SPREAD"
  | "TOOL_EXECUTION_PRESENT"
  | "MULTI_STEP_EXECUTION_PRESENT"
  | "HOOK_EXECUTION_PRESENT"
  | "UNSUPPORTED_SCHEMA_TRANSFORM"
  | "UNSUPPORTED_SCHEMA"
  | "UNSUPPORTED_OUTPUT"
  | "UNSUPPORTED_ANALYSIS_SCOPE"
  | "UNKNOWN_USAGE"
  | "UNRESOLVED_COMPUTED_ACCESS"
  | "CALLBACK_CAPTURE"
  | "WHOLE_RESULT_CONSUMED"
  | "ANALYSIS_BUDGET_EXCEEDED"
  | "OUTSIDE_WORKSPACE_DENIED";

export interface Limitation {
  readonly code: LimitationCode;
  readonly message: string;
  readonly span?: SourceSpan;
}

export interface FieldShape {
  readonly shape: OutputShape;
  readonly optional: boolean;
  readonly nullable: boolean;
}

export type OutputShape =
  | { readonly kind: "finite"; readonly values: readonly JsonScalar[] }
  | { readonly kind: "open"; readonly valueType: "string" | "number" }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, FieldShape>>;
      readonly extraKeys: "rejected" | "stripped" | "allowed" | "unknown";
    }
  | { readonly kind: "unknown"; readonly reason: LimitationCode };

export type ConsumerKind =
  | "conditional"
  | "switch"
  | "lookup-key"
  | "return"
  | "argument"
  | "serialization"
  | "display"
  | "logging"
  | "unknown";

export interface ConsumerFact {
  readonly fieldPath: readonly string[];
  readonly kind: ConsumerKind;
  readonly span: SourceSpan;
  readonly wholeResult: boolean;
}

export interface ExecutionFacts {
  readonly tools: "yes" | "no" | "unknown";
  readonly multiStep: "yes" | "no" | "unknown";
  readonly hooks: "yes" | "no" | "unknown";
}

export interface CallFacts {
  readonly api: "generateText" | "generateObject";
  readonly provenance: "symbol-resolved" | "import-syntax";
  readonly span: SourceSpan;
  readonly outputShape: OutputShape;
  readonly consumers: readonly ConsumerFact[];
  readonly usageComplete: boolean;
  readonly execution: ExecutionFacts;
  readonly limitations: readonly Limitation[];
}

export interface Coverage {
  readonly filesEligible: number;
  readonly filesAnalyzed: number;
  readonly filesSkipped: number;
  readonly recognizedCalls: number;
  readonly supportedCalls: number;
  readonly unresolvedCalls: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
}

export interface AnalysisBatch {
  readonly calls: readonly CallFacts[];
  readonly coverage: Coverage;
  readonly diagnostics: readonly Diagnostic[];
  readonly incomplete: boolean;
}
