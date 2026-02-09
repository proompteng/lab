# Workflow Linting (Design)

This document defines a build-time “workflow lint” command for
`@proompteng/temporal-bun-sdk` that prevents common nondeterminism sources from
entering workflow code.

Runtime guards catch many issues, but they cannot reliably detect:

- captured references (`const now = Date.now;`)
- nondeterministic imports deep in dependency graphs
- `process.env` reads and other hard-to-wrap property access

Linting is the primary enforcement mechanism for these.

## Goals

- Detect and block nondeterministic workflow code in CI before it ships.
- Provide actionable messages that identify the file, symbol, and fix.
- Be fast enough to run on every PR for workflow packages.

## Non-Goals

- Full type-aware static analysis.
- Proving determinism for arbitrary JS.

## CLI Contract

Add:

```bash
temporal-bun lint-workflows [options]
```

Exit codes:

- `0`: no issues (or issues below threshold in warn mode)
- `1`: lint violations

Options:

- `--workflows <path-or-glob>` (repeatable)
- `--mode strict|warn|off` (default from `TEMPORAL_WORKFLOW_LINT`, otherwise `strict` in CI, `warn` locally)
- `--format text|json` (default `text`)
- `--config <path>` (default `.temporal-bun-workflows.json` at repo root if present)
- `--changed-only` (CI mode; only lint workflows impacted by the diff)

Output:

- `text`: human-readable grouped errors
- `json`: machine-readable list of violations for CI annotations

## Configuration File

`.temporal-bun-workflows.json` (JSON, no JS execution in CI) defines:

```json
{
  "entries": [
    "services/bumba/src/workflows/index.ts",
    "packages/*/src/workflows/**/*.ts"
  ],
  "allow": {
    "imports": ["effect", "@effect/schema"],
    "globals": ["TextEncoder", "TextDecoder"]
  },
  "deny": {
    "imports": ["@proompteng/temporal-bun-sdk/client", "@proompteng/temporal-bun-sdk/worker"],
    "globals": ["fetch", "WebSocket", "Bun.spawn"],
    "memberExpressions": ["process.env", "Bun.env"]
  }
}
```

The allowlist is additive. The denylist is authoritative.

## Rules

Rules fall into two categories.

### 1) Import Rules (Dependency Graph)

For workflow entrypoints and all reachable modules:

- Deny imports of known side-effect modules:
  - `@proompteng/temporal-bun-sdk/client`
  - `@proompteng/temporal-bun-sdk/worker`
  - `node:fs`, `node:net`, `node:http`, `node:https`, `node:child_process`, etc.
- Deny imports of packages known to perform I/O at import time (configurable).
- Deny dynamic imports unless explicitly allowlisted.

Implementation approach:

- Parse import/export statements from each module.
- Resolve relative imports and continue traversal.
- For bare package imports, apply deny rules and do not attempt to traverse into
  `node_modules` in v1 (optional future enhancement).

### 2) AST Pattern Rules (Local File)

Detect banned identifiers and patterns in workflow modules:

- Direct use of forbidden globals:
  - `fetch(...)`, `new WebSocket(...)`
  - `setTimeout`, `setInterval`
  - `Bun.spawn`, `Deno.run`
- Member expressions:
  - `process.env`
  - `Bun.env`
- Capturing forbidden globals:
  - `const f = fetch`
  - `const now = Date.now`

Allow safe alternatives:

- `ctx.determinism.now()`, `ctx.determinism.random()`
- `ctx.determinism.sideEffect({ compute })`
- `ctx.activities.schedule(...)`
- `ctx.timers.start(...)`

## Parser Choice

Use TypeScript’s parser (already a dev dependency of the SDK):

- `typescript.createSourceFile(...)` for fast AST generation without type-checking.
- No program-wide type analysis in v1.

This keeps the tool self-contained and predictable in CI.

## Implementation Notes (For Agent Runs)

1. Add command implementation:
   - `packages/temporal-bun-sdk/src/bin/lint-workflows-command.ts`
2. Wire into CLI:
   - `packages/temporal-bun-sdk/src/bin/temporal-bun.ts`
3. Add config loader:
   - `packages/temporal-bun-sdk/src/bin/workflow-lint/config.ts`
4. Add dependency traversal + AST rules:
   - `packages/temporal-bun-sdk/src/bin/workflow-lint/graph.ts`
   - `packages/temporal-bun-sdk/src/bin/workflow-lint/rules.ts`
5. Add tests:
   - `packages/temporal-bun-sdk/tests/cli/temporal-bun-lint-workflows.test.ts`

Use TODO markers:

- `// TODO(TBS-NDG-003): implement workflow lint CLI`

## Acceptance Criteria

1. Lint fails on `fetch()` in a workflow module.
2. Lint fails on `process.env.X` access in a workflow module.
3. Lint fails on `const now = Date.now` in a workflow module.
4. Lint fails when a workflow imports `@proompteng/temporal-bun-sdk/client`.
5. `--format json` emits stable output suitable for CI annotations.

