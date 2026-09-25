import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeTypeScript } from "../src/analyzer/typescript/analyze.js";
import type { AnalyzeRequest } from "../src/app/scan.js";

function fixture(source: string): { request: AnalyzeRequest; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "decisionshift-"));
  writeFileSync(path.join(root, "example.ts"), source);
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext" }, include: ["*.ts"] }));
  return {
    root,
    request: {
      workspace: root,
      project: "tsconfig.json",
      excludes: [],
      allowedReadRoots: [],
      limits: { maxFileBytes: 1_000_000, maxFiles: 100, maxDepth: 32, timeoutMs: 10_000, maxHeapMb: 512 },
    },
  };
}

test("finds a finite Output.object and its lookup consumer without executing source", async () => {
  const marker = path.join(tmpdir(), `decisionshift-marker-${Date.now()}`);
  const { request } = fixture(`
    import { generateText as generate, Output } from "ai";
    import { z } from "zod";
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "executed");

    export async function route() {
      const { output } = await generate({
        model: null,
        output: Output.object({ schema: z.object({ department: z.enum(["billing", "technical"]).describe("route") }) })
      });
      return ({ billing: 1, technical: 2 } as const)[output.department];
    }
  `);
  const batch = await analyzeTypeScript(request);
  assert.equal(batch.calls.length, 1);
  assert.equal(batch.calls[0]?.outputShape.kind, "object");
  assert.equal(batch.calls[0]?.consumers.some(item => item.kind === "lookup-key"), true);
  assert.equal(readFileSync === undefined, false);
  assert.equal(batch.coverage.supportedCalls, 1);
  assert.equal(batch.calls[0]?.limitations.some(item => item.code === "RESULT_ESCAPES_FUNCTION"), false);
  assert.throws(() => readFileSync(marker), /ENOENT/);
});

test("downgrades a bounded result that escapes", async () => {
  const { request } = fixture(`
    import { generateText, Output } from "ai";
    async function route() {
      const { output } = await generateText({ model: null, output: Output.choice({ options: ["a", "b"] }) });
      return processResult(output);
    }
    declare function processResult(value: unknown): unknown;
  `);
  const batch = await analyzeTypeScript(request);
  assert.equal(batch.calls[0]?.outputShape.kind, "finite");
  assert.equal(batch.calls[0]?.usageComplete, false);
  assert.equal(batch.calls[0]?.limitations.some(item => item.code === "RESULT_ESCAPES_FUNCTION"), true);
});

test("does not match a shadowed generateText", async () => {
  const { request } = fixture(`
    function generateText(value: unknown) { return value; }
    generateText({ output: "not ai" });
  `);
  const batch = await analyzeTypeScript(request);
  assert.equal(batch.calls.length, 0);
});

test("resolves a local AI SDK re-export and imported static schema", async () => {
  const { request, root } = fixture(`
    import { generate, Output } from "./ai.js";
    import { routeSchema } from "./schema.js";
    export async function route() {
      const { output } = await generate({ model: null, output: Output.object({ schema: routeSchema }) });
      switch (output.department) { case "billing": return 1; default: return 2; }
    }
  `);
  writeFileSync(path.join(root, "ai.ts"), `export { generateText as generate, Output } from "ai";`);
  writeFileSync(path.join(root, "schema.ts"), `
    import { z } from "zod";
    export const departments = ["billing", "technical"] as const;
    export const routeSchema = z.object({ department: z.enum(departments) }).strict();
  `);
  const batch = await analyzeTypeScript(request);
  assert.equal(batch.calls.length, 1);
  assert.equal(batch.calls[0]?.provenance, "symbol-resolved");
  assert.equal(batch.calls[0]?.outputShape.kind, "object");
  assert.equal(batch.calls[0]?.consumers.some(item => item.kind === "switch"), true);
});

test("does not trust an output option overridden by a later spread", async () => {
  const { request } = fixture(`
    import { generateText, Output } from "ai";
    declare const unknownOptions: Record<string, unknown>;
    async function route() {
      const { output } = await generateText({
        model: null,
        output: Output.choice({ options: ["a", "b"] }),
        ...unknownOptions
      });
      return output;
    }
  `);
  const batch = await analyzeTypeScript(request);
  assert.equal(batch.calls[0]?.outputShape.kind, "unknown");
  assert.equal(batch.calls[0]?.limitations.some(item => item.code === "UNKNOWN_OPTIONS_SPREAD"), true);
});
