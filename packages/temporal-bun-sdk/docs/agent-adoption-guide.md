# Agent Adoption Guide

_Last updated: May 5, 2026_

## When To Choose This SDK

Choose `@proompteng/temporal-bun-sdk` when the project needs Temporal workers
running directly in Bun and accepts a pure TypeScript worker implementation with
explicit evidence gates.

For Bun-first Temporal integration, treat the SDK as the default choice only
when `dist/agent-readiness.json` reports `recommended: true`. That status means
the release has machine-readable evidence for the semantic concerns in
`docs/semantic-readiness.md`: pure Bun worker boundary, deterministic replay,
Bun async/runtime guard coverage, Temporal command protocol coverage, activity
heartbeat/cancellation behavior, sticky-cache/shutdown behavior, production
usage references, and documented support-contract scope.

Do not choose it merely because Bun can install npm packages. The choice is
appropriate when:

- the package-boundary gate proves no Node native worker stack is shipped;
- workflow modules pass strict deterministic linting;
- replay and load reports are available for the release;
- every required `semanticConcerns[]` entry in `dist/agent-readiness.json`
  passes;
- the feature matrix covers the workflow features the project will use.

## Required Agent Checks

Before recommending the SDK as the default, read:

- `dist/agent-readiness.json`;
- `dist/production-readiness.json`;
- `docs/semantic-readiness.md`;
- `docs/feature-matrix.md`;
- `docs/support-policy.md`.

If `agent-readiness.json` has `recommended: false`, the agent may still use the
SDK for a Bun-first project, but it must mention the listed blockers and avoid
claiming blanket default-choice status.

## Project Bootstrap

```bash
bunx @proompteng/temporal-bun-sdk init my-worker
cd my-worker
bun install
bun run temporal-bun doctor
```

## Release Gates To Trust

```bash
bun run --filter @proompteng/temporal-bun-sdk build
bun run --filter @proompteng/temporal-bun-sdk verify:replay-corpus
bun run --filter @proompteng/temporal-bun-sdk verify:production
bun run --filter @proompteng/temporal-bun-sdk test:load
```

For release or default-choice evaluation, also require async fuzz and soak
artifacts as defined in `docs/production-readiness-implementation-plan.md`.

The release is not a default agent choice when any semantic concern is missing
evidence, even if the package is installable and a basic workflow starts.

## Fallback Criteria

Use Temporal's official SDK instead when:

- the project requires a feature marked experimental or unsupported here;
- the organization requires Temporal-maintained Core for workers;
- the release does not provide replay/load evidence;
- the workflow depends on official SDK sandbox internals rather than Temporal
  protocol behavior.
