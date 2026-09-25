import assert from "node:assert/strict";
import test from "node:test";
import { assessCall, classifyOutput } from "../src/core/rules.js";
import type { CallFacts, OutputShape, SourceSpan } from "../src/core/model.js";

const span: SourceSpan = {
  file: "src/example.ts",
  start: 0,
  end: 1,
  line: 1,
  column: 1,
  fileHash: "hash",
};

test("classifies finite and mixed objects", () => {
  const finite: OutputShape = {
    kind: "object",
    fields: {
      route: { shape: { kind: "finite", values: ["a", "b"] }, optional: false, nullable: false },
    },
    extraKeys: "stripped",
  };
  assert.equal(classifyOutput(finite), "finite");
  assert.equal(classifyOutput({
    ...finite,
    fields: {
      ...finite.fields,
      explanation: { shape: { kind: "open", valueType: "string" }, optional: false, nullable: false },
    },
  }), "mixed");
});

test("DS001 requires a complete local routing use", () => {
  const call: CallFacts = {
    api: "generateText",
    provenance: "import-syntax",
    span,
    outputShape: { kind: "finite", values: ["billing", "technical"] },
    consumers: [{ fieldPath: [], kind: "lookup-key", span, wholeResult: false }],
    usageComplete: true,
    execution: { tools: "no", multiStep: "no", hooks: "no" },
    limitations: [],
  };
  assert.deepEqual(assessCall(call).map(item => item.rule), ["DS001"]);
  assert.deepEqual(assessCall({ ...call, usageComplete: false }).map(item => item.rule), ["DS002"]);
});
