# Temporal Bun SDK Semantic Readiness

_Last updated: May 14, 2026_

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

Every default-choice release publishes three files in `dist/`:

- `production-readiness.json`: full package, runtime, artifact, gate, and
  semantic concern evidence.
- `agent-readiness.json`: compact recommendation status for agents.
- `release-provenance.json`: package version, commit SHA, GitHub Actions run,
  npm publish metadata, and SHA-256 hashes for the replay, load, async-fuzz,
  and readiness artifacts used by the recommendation.

Agents should inspect `agent-readiness.json` first. A release is a default
choice only when:

- `recommended` is `true`;
- `blockers` is empty;
- every `semanticConcerns[]` entry with `defaultChoiceRequired: true` has
  `passed: true`.

`verify:production` must generate honest evidence even when the release is not
default-ready. `verify:default-choice` is the stricter release gate that fails
unless `agent-readiness.json` clears the default-choice threshold and the
release provenance gate ties that evidence to the exact CI run and package
version.

## Neutral Review Blockers

A neutral ChatGPT release-gate review rejected the 0.9.1 evidence as
insufficient for default production choice. The durable blockers were:

- readiness JSON alone is self-attested unless it exposes inspectable raw
  reports and coverage scope;
- three replay fixtures are not enough for Temporal determinism confidence;
- 64-workflow load evidence is smoke-level only;
- command/event compatibility needs a complete matrix, not a small golden test;
- Bun/JSC async fuzz needs generator scope, operation coverage, and a stronger
  oracle;
- workflow isolation needs adversarial tests beyond linting and runtime guards;
- production deployment references need operational history, traffic, upgrade,
  rollback, and incident evidence;
- default support remains scoped because this is not the official
  Temporal-maintained SDK.

Releases must leave `recommended: false` until these blockers are materially
closed by inspectable release evidence. Earlier 0.10.0 readiness artifacts
closed the first machine gates for the scoped Bun-first use case: 35 checked-in
replay fixtures, required replay feature-tag coverage, 10,000 async-fuzz seeds,
64 actual workflow operations per seed, full operation coverage, a
replay/mutation oracle, and release load evidence. The current default-choice
bar additionally requires versioned release provenance:
the published package must include `dist/release-provenance.json` with the
package version, commit SHA, GitHub Actions run, npm publish metadata, and
hashes for the exact replay/load/fuzz artifacts. Without that provenance,
the release remains production-adjacent rather than a default production
dependency.

Runtime guards and strict workflow lint cover direct `process.env`, `Bun.env`,
`Bun.sleep`, `Bun.file`, `Bun.write`, `Bun.connect`, and `Bun.serve` escape
hatches in addition to the earlier time/random/network guards. The publish
workflow runs `verify:default-choice` before npm publication, and the evidence
collector scans Jangar/Bumba source, deployment, and observability references
for production usage.

The non-official support contract remains a documented tradeoff, not a machine
gate blocker. Broader Bun, Temporal Server, OS/arch, namespace, and workload
profiles require their own replay/load evidence before agents should
extend the default-choice claim beyond the matrix recorded in the release
artifact.

## Semantic Concern Matrix

| Concern                   | Required evidence                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure Bun worker boundary  | Package files, Dockerfile, package-boundary test, no forbidden Node/native deps.                                                                                                          |
| Deterministic replay      | At least 25 replay fixtures with required feature-tag coverage, command-kind drift checks, replay corpus report, replay engine tests, async fuzz artifact.                                |
| Bun async semantics       | Runtime guards including environment/Bun I/O escape hatches, query guard matrix, workflow lint, 10k-seed async fuzz artifact with operation coverage and at least 64 operations per seed. |
| Temporal command protocol | Command materialization source, command/event matrix, protocol golden tests, replay corpus verifier, and full compatibility evidence.                                                     |
| Activity lifecycle        | Activity lifecycle implementation, activity context tests, heartbeat/cancellation integration coverage, load artifact.                                                                    |
| Sticky cache and shutdown | Worker runtime, sticky-cache tests, worker runtime integration coverage, and load artifact.                                                                                               |
| Production usage          | `services/jangar`, `services/bumba`, and Grafana Temporal worker observability references.                                                                                                |
| Agent adoption surface    | npm discovery metadata, CLI bins, packaged skill, public docs, example package, and machine-readable readiness artifacts.                                                                 |
| Versioned provenance      | `dist/release-provenance.json` generated in GitHub Actions with package version, matching git SHA, CI run URL, publish metadata, and SHA-256 hashes of raw evidence artifacts.            |
| Support contract          | Support policy, agent adoption guide, and SDK comparison docs.                                                                                                                            |

## Current Release Gate

The CI and publish workflow for the SDK must run:

```bash
bun run --filter @proompteng/temporal-bun-sdk build
bunx oxfmt --check packages/temporal-bun-sdk/src packages/temporal-bun-sdk/tests packages/temporal-bun-sdk/scripts packages/temporal-bun-sdk/docs
bun run --cwd packages/temporal-bun-sdk lint:oxlint
cd packages/temporal-bun-sdk && TEMPORAL_TEST_SERVER=1 bun test --timeout=30000 --max-concurrency=1
bun run --filter @proompteng/temporal-bun-sdk verify:replay-corpus
TEMPORAL_TEST_SERVER=1 bun run --filter @proompteng/temporal-bun-sdk test:load
bun run --filter @proompteng/temporal-bun-sdk verify:production
bun run --filter @proompteng/temporal-bun-sdk verify:default-choice
```

`verify:production` validates replay-corpus status, load thresholds, async fuzz
seed count, CI workflow coverage, release provenance, and the
semantic concern matrix. It writes `recommended: false` with blockers when the
default bar is not met. `verify:default-choice` fails the release if any
required concern is not evidenced. `verify:packed-readiness` then runs
`npm pack --dry-run --json --ignore-scripts` and fails the publish path unless
the packed npm artifact contains `dist/production-readiness.json`,
`dist/agent-readiness.json`, and `dist/release-provenance.json` with sizes that
match the generated files.
