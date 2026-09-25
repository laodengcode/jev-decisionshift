# AGENTS.md

## Repository purpose

DecisionShift is a local TypeScript static-analysis CLI. It finds bounded Vercel AI SDK outputs, traces their nearby consumers, and produces conservative evidence for deciding whether a call is worth evaluating with Jev. It must never execute code from the scanned repository.

## File map

- `README.md` — public installation, usage, supported syntax, configuration, and trust-boundary documentation.
- `package.json` — npm package metadata, CLI binary registration, dependencies, and build/test scripts.
- `src/cli.ts` — command-line parsing, configuration loading, worker lifecycle, output selection, and exit codes.
- `src/worker.ts` — isolated child-process entry point for analysis.
- `src/app/scan.ts` — analysis application boundary, request and limit types, and injectable analyzer delegation.
- `src/analyzer/typescript/analyze.ts` — identifies supported AI SDK calls and assembles analysis facts.
- `src/analyzer/typescript/host.ts` — safe TypeScript program and filesystem host setup.
- `src/analyzer/typescript/schema.ts` — converts supported static output schemas into internal shapes.
- `src/analyzer/typescript/static.ts` — resolves and evaluates safe immutable static expressions.
- `src/analyzer/typescript/usage.ts` — traces local output consumers and escape conditions.
- `src/core/model.ts` — analyzer domain types and report inputs.
- `src/core/rules.ts` — output classification and DecisionShift assessment rules.
- `src/report.ts` — versioned report schema plus terminal, JSON, and Markdown renderers.
- `tests/analyzer.test.ts` — end-to-end analyzer behavior.
- `tests/core.test.ts` — classification and assessment-rule behavior.
- `tests/cli.test.ts` — CLI process and JSON output behavior.
- `tests/architecture.test.ts` — dependency-boundary checks.
- `tsconfig.json` — production TypeScript build configuration.
- `tsconfig.test.json` — test compilation configuration.
- `MARKETING_PLAN.md` — local internal marketing strategy; intentionally ignored by Git.

Generated directories `dist/` and `dist-tests/` are build outputs and must not be edited directly.

## Working rules

- Preserve the scanner's no-execution, no-network trust boundary for target repositories.
- Prefer conservative limitations over guessing when syntax or dataflow is unsupported.
- Keep report schema changes backward-compatible or version them explicitly.
- Add the smallest relevant test for non-trivial analyzer or rule changes.
- Run `npm test` before handing off code changes.
