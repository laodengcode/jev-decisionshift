# DecisionShift — find LLM calls worth evaluating with Jev

[![CI](https://github.com/laodengcode/jev-decisionshift/actions/workflows/ci.yml/badge.svg)](https://github.com/laodengcode/jev-decisionshift/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/jev-decisionshift.svg)](https://www.npmjs.com/package/jev-decisionshift)

DecisionShift scans TypeScript projects for bounded [Vercel AI SDK](https://ai-sdk.dev/) outputs and shows how the surrounding function consumes them.

It runs locally, does not need an API key, and never executes the scanned repository. A finding is review evidence—not proof that Jev or any other implementation is a safe replacement.

## Try it

```bash
npx --yes jev-decisionshift scan .
```

For example, given this routing call:

```ts
import { generateText, Output } from "ai";

export async function routeTicket(message: string) {
  const { output } = await generateText({
    model: "anthropic/claude-sonnet-4.5",
    output: Output.choice({ options: ["billing", "technical"] as const }),
    prompt: `Route this support request: ${message}`,
  });

  return { billing: "/billing", technical: "/technical" }[output];
}
```

DecisionShift reports:

```text
DecisionShift 0.1.0 — 1 recognized AI SDK call site(s)

route-ticket.ts:4:28

DS001 Bounded decision call worth reviewing

Declared output: "billing" | "technical"
Observed consumption:
  lookup-key: output (route-ticket.ts:10)
Analysis scope: local references accounted for
```

This merits Jev evaluation because a bounded model choice directly controls routing; the finding supports human review, not an automatic replacement.

Machine-readable output:

```bash
npx --yes jev-decisionshift scan . --project tsconfig.json --format json --output scan.json
npx --yes jev-decisionshift scan . --format markdown
```

Exit codes are `0` for a completed scan, `2` for invalid configuration or invocation, and `3` for an incomplete scan. Findings and explicitly unsupported syntax still count as a completed scan.

## Supported in v0.1

- `.ts`, `.tsx`, `.mts`, and `.cts` files.
- `generateText` with `Output.object` or `Output.choice`.
- Legacy `generateObject` object and enum output.
- Direct, aliased, namespace, and resolvable local re-export imports from `ai`.
- A static Zod subset: boolean, string, number, null, literal, enum, literal unions, object, optional, nullable, strict, strip, passthrough, and describe.
- Immutable local or imported constants made from literals, arrays, and objects.
- Local bindings, destructuring, aliases, branches, switches, lookup keys, returns, argument passing, serialization, display, logging, and conservative escape detection.

Transforms, dynamic schema factories, arbitrary wrappers, arrays, project-reference traversal, and whole-program dataflow are reported as limitations rather than guessed.

## Configuration

An optional `decisionshift.json` at the scan root may contain:

```json
{
  "project": "tsconfig.json",
  "exclude": ["fixtures/**"],
  "allowedReadRoots": [],
  "limits": {
    "maxFileBytes": 5242880,
    "maxFiles": 20000,
    "maxDepth": 32,
    "timeoutMs": 120000,
    "maxHeapMb": 1024
  }
}
```

DecisionShift also reads `.gitignore` and `.decisionshiftignore`. Paths outside the workspace are denied unless listed in `allowedReadRoots`; the scanner's own TypeScript standard-library files are allowed internally.

## Trust boundary

DecisionShift does not import source files, schema factories, compiler plugins, configuration modules, or package scripts. It does not install target dependencies or make network requests. Analysis runs in a time- and memory-bounded child process, and reports omit prompts and source excerpts.

The scanner currently embeds the TypeScript 6 compiler API because TypeScript 7 does not yet expose a stable embedded API. A TypeScript 7 project can still receive syntax-backed findings, with unsupported configuration reported as diagnostics.
