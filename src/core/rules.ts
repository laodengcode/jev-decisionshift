import type { CallFacts, OutputShape } from "./model.js";

export type OutputClassification = "finite" | "mixed" | "open" | "unknown";
export type RuleId = "DS001" | "DS002" | "DS003" | "DS004" | "DS005" | "DS006";

export interface Assessment {
  readonly rule: RuleId;
  readonly message: string;
}

export function classifyOutput(shape: OutputShape): OutputClassification {
  if (shape.kind !== "object") return shape.kind;
  if (shape.extraKeys === "allowed" || shape.extraKeys === "unknown") return "mixed";

  const childKinds = Object.values(shape.fields).map(field => classifyOutput(field.shape));
  if (childKinds.some(kind => kind === "unknown")) return "unknown";
  const hasFinite = childKinds.some(kind => kind === "finite");
  const hasOpen = childKinds.some(kind => kind === "open" || kind === "mixed");
  if (hasFinite && hasOpen) return "mixed";
  if (hasOpen) return "open";
  return "finite";
}

export function assessCall(call: CallFacts): readonly Assessment[] {
  const classification = classifyOutput(call.outputShape);
  const assessments: Assessment[] = [];
  const hasExecution = call.execution.tools !== "no" || call.execution.multiStep !== "no";

  if (classification === "finite") {
    const routing = call.consumers.some(consumer =>
      consumer.kind === "conditional" || consumer.kind === "switch" || consumer.kind === "lookup-key",
    );
    assessments.push(
      call.usageComplete && routing && !hasExecution
        ? { rule: "DS001", message: "Bounded decision call worth reviewing" }
        : { rule: "DS002", message: "Bounded output; downstream behavior requires inspection" },
    );
  } else if (classification === "mixed") {
    assessments.push({ rule: "DS003", message: "Mixed finite and open output contract" });
  } else if (classification === "open" && call.consumers.length > 0) {
    assessments.push({ rule: "DS004", message: "Generated open output is part of observed behavior" });
  } else if (classification === "unknown") {
    assessments.push({ rule: "DS006", message: "Insufficient static evidence" });
  }

  if (call.execution.tools !== "no" || call.execution.multiStep !== "no" || call.execution.hooks !== "no") {
    assessments.push({ rule: "DS005", message: "Execution behavior requires separate review" });
  }

  return assessments.length > 0
    ? assessments
    : [{ rule: "DS006", message: "Insufficient static evidence" }];
}
