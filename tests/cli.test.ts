import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI emits versioned JSON to stdout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "decisionshift-cli-"));
  writeFileSync(path.join(root, "example.ts"), `
    import { generateText, Output } from "ai";
    async function choose() {
      const { output } = await generateText({ model: null, output: Output.choice({ options: ["yes", "no"] }) });
      if (output === "yes") return 1;
      return 0;
    }
  `);
  const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "scan", root, "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { schemaVersion: string; coverage: { recognizedCalls: number } };
  assert.equal(report.schemaVersion, "1");
  assert.equal(report.coverage.recognizedCalls, 1);
});
