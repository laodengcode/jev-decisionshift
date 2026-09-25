import type { AnalyzeRequest } from "./app/scan.js";
import { scanProject } from "./app/scan.js";
import { analyzeTypeScript } from "./analyzer/typescript/analyze.js";
import { createReport } from "./report.js";

process.on("message", async (message: AnalyzeRequest) => {
  try {
    const batch = await scanProject(message, analyzeTypeScript);
    process.send?.({ ok: true, report: createReport(batch) });
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
