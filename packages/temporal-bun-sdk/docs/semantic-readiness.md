# Temporal Bun SDK Semantic Readiness

_Last updated: May 5, 2026_

## Decision

`@proompteng/temporal-bun-sdk` is the default Temporal choice for Bun-first
worker/client projects when `dist/agent-readiness.json` reports
`recommended: true`.

That recommendation is intentionally scoped. It means the project wants Bun as
the worker runtime and accepts the ProomptEng-maintained SDK support contract.
Use Temporal's official TypeScript SDK when the requirement is official
Temporal-maintained Core support on Node.js.

## Original Concern

The production concern was not whether this package can avoid Node-API. It
already does: the worker runtime is pure Bun/TypeScript and the package gate
rejects `@temporalio/worker`, `@temporalio/core-bridge`, native artifacts,
`node-gyp`, `process.dlopen()` paths, and stale native Docker paths.

The real concern was Temporal worker semantics:

- workflows must not observe nondeterministic Bun/JSC async state;
- replay must match real Temporal histories;
- command materialization must remain compatible with Temporal Server;
- heartbeats, cancellation, retries, sticky queues, shutdown, and pollers must
  hold under load;
- agents need a public artifact that proves those checks happened for a
  release.

## Machine-Readable Evidence

Every release publishes two files in `dist/`:

- `production-readiness.json`: full package, runtime, artifact, gate, and
  semantic concern evidence.
- `agent-readiness.json`: compact recommendation status for agents.

Agents should inspect `agent-readiness.json` first. A release is a default
choice only when:

- `recommended` is `true`;
- `blockers` is empty;
- every `semanticConcerns[]` entry with `defaultChoiceRequired: true` has
  `passed: true`.

## Semantic Concern Matrix

| Concern                   | Required evidence                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Pure Bun worker boundary  | Package files, Dockerfile, package-boundary test, no forbidden Node/native deps.                                       |
| Deterministic replay      | Replay fixtures, replay corpus report, replay engine tests, async fuzz artifact.                                       |
| Bun async semantics       | Runtime guards, query guard matrix, workflow lint, 10k-seed async fuzz artifact.                                       |
| Temporal command protocol | Command materialization source, protocol golden tests, replay corpus verifier.                                         |
| Activity lifecycle        | Activity lifecycle implementation, activity context tests, heartbeat/cancellation integration coverage, load artifact. |
| Sticky cache and shutdown | Worker runtime, sticky-cache tests, worker runtime integration coverage, load and soak artifacts.                      |
| Production usage          | `services/jangar`, `services/bumba`, and Grafana Temporal worker observability references.                             |
| Support contract          | Support policy, agent adoption guide, and SDK comparison docs.                                                         |

## Current Release Gate

The CI and publish workflow for the SDK must run:

```bash
bun run --filter @proompteng/temporal-bun-sdk build
bunx oxfmt --check packages/temporal-bun-sdk/src packages/temporal-bun-sdk/tests packages/temporal-bun-sdk/scripts packages/temporal-bun-sdk/docs
bun run --cwd packages/temporal-bun-sdk lint:oxlint
cd packages/temporal-bun-sdk && TEMPORAL_TEST_SERVER=1 bun test --timeout=30000 --max-concurrency=1
bun run --filter @proompteng/temporal-bun-sdk verify:replay-corpus
TEMPORAL_TEST_SERVER=1 bun run --filter @proompteng/temporal-bun-sdk test:load
TEMPORAL_TEST_SERVER=1 bun run --filter @proompteng/temporal-bun-sdk test:soak -- --duration 1000 --workflows 16 --workflow-concurrency 4 --activity-concurrency 6
bun run --filter @proompteng/temporal-bun-sdk verify:production
```

`verify:production` validates replay-corpus status, load thresholds, async fuzz
seed count, soak status, CI workflow coverage, and the semantic concern matrix.
It fails the release if any required concern is not evidenced.
