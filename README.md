# DecisionShift: find LLM calls worth evaluating with Jev

[![CI](https://github.com/laodengcode/jev-decisionshift/actions/workflows/ci.yml/badge.svg)](https://github.com/laodengcode/jev-decisionshift/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/jev-decisionshift.svg)](https://www.npmjs.com/package/jev-decisionshift)

DecisionShift scans TypeScript projects for [Vercel AI SDK](https://ai-sdk.dev/) calls whose outputs have a fixed set of possible values. It then shows how the surrounding function uses each result.

It works locally without an API key and never executes the project. Treat each finding as a place to investigate. You still need to decide whether Jev is a safe replacement.

## Try it

```bash
npx --yes jev-decisionshift scan .
```

For example, this call asks an LLM to route a support request:

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

DecisionShift flags the call because its output is limited to two choices and controls a route. That makes it a reasonable candidate to test with Jev. The report does not recommend changing the code automatically.

Use JSON for other tools or Markdown for code reviews:

```bash
npx --yes jev-decisionshift scan . --project tsconfig.json --format json --output scan.json
npx --yes jev-decisionshift scan . --format markdown
```

A completed scan exits with `0`, even when it finds unsupported syntax. Invalid configuration or commands exit with `2`. An incomplete scan exits with `3`.

## What v0.1 supports

- TypeScript files ending in `.ts`, `.tsx`, `.mts`, or `.cts`.
- `generateText` calls that use `Output.object` or `Output.choice`.
- Legacy `generateObject` calls with object or enum output.
- Direct, aliased, namespace, and resolvable local re-export imports from `ai`.
- Static Zod schemas using boolean, string, number, null, literal, enum, literal unions, object, optional, nullable, strict, strip, passthrough, or describe.
- Immutable local or imported constants built from literals, arrays, and objects.
- Local uses such as bindings, destructuring, aliases, branches, switches, lookup keys, returns, function arguments, serialization, display, and logging.

DecisionShift reports transforms, dynamic schema factories, arbitrary wrappers, arrays, project-reference traversal, and whole-program data flow as limitations instead of guessing.

## Configuration

Add an optional `decisionshift.json` file at the scan root to change these settings:

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

DecisionShift also reads `.gitignore` and `.decisionshiftignore`. It will not read outside the workspace unless a path is listed in `allowedReadRoots`. The scanner can read its own TypeScript standard-library files.

## Trust boundary

DecisionShift reads source files without importing or executing them. It does not load schema factories, compiler plugins, configuration modules, or package scripts. It also does not install project dependencies or make network requests.

Analysis runs in a child process with time and memory limits. Reports leave out prompts and source excerpts.

The scanner embeds the TypeScript 6 compiler API because TypeScript 7 does not yet expose a stable embedded API. TypeScript 7 projects still receive syntax-based findings, while unsupported configuration appears as diagnostics.
