# Temporal Bun SDK Support Policy

_Last updated: May 6, 2026_

## Supported Runtime Matrix

| Surface         | Supported                                                                       | Notes                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bun             | `>=1.3.13`                                                                      | CI pins Bun `1.3.13`; newer Bun releases must pass the SDK test, replay, and load gates before being documented as preferred.           |
| Node            | Build tooling only                                                              | The worker runtime is Bun TypeScript. Node is used by repository tooling and GitHub Actions setup, not by the published worker runtime. |
| Temporal Server | Current CI cluster plus pinned dev server histories                             | Additional server minor/version coverage requires replay-corpus and integration evidence before being documented as preferred.          |
| Temporal Cloud  | Client/worker TLS and mTLS paths are supported when credentials are configured. | Cloud Ops tests remain optional unless credentials are present.                                                                         |
| OS/arch         | Linux x64 release CI, local macOS development                                   | Additional platforms require package-boundary, build, test, replay, and load evidence.                                                  |

## Supported Package Boundary

The published package is expected to contain only:

- `dist`;
- `docs`;
- `skills`;
- `README.md`.

The production gate rejects:

- `@temporalio/worker`;
- `@temporalio/core-bridge`;
- `@temporalio/client`;
- `node-gyp`, `node-addon-api`, `node-gyp-build`;
- native artifacts such as `.node`, `.dylib`, `.so`, and `.a`;
- stale native bridge paths such as `bruke`, `native`, and `dist/native`.

## Required Release Evidence

Every release should publish or upload:

- `dist/production-readiness.json`;
- `dist/agent-readiness.json`;
- replay corpus report;
- worker load report;
- async determinism fuzz report;
- npm pack or publish provenance output.

`agent-readiness.json` must not set `recommended: true` until the replay corpus,
async determinism fuzz, load, CI coverage, package-boundary, and semantic
concern evidence meet the default-choice thresholds in
`docs/semantic-readiness.md`.

Default-choice evidence is intentionally stricter than publish evidence. A
release may publish with `recommended: false` so users can opt in, but agents
must not select it by default until `verify:default-choice` passes.

## Known Limits

- This is a pure Bun SDK, not Temporal's official TypeScript SDK and not a
  wrapper around the official Node worker.
- Official SDK internal sandbox behavior is not a compatibility promise. The
  compatibility promise is Temporal protocol behavior plus deterministic replay
  evidence.
- Default-choice status is scoped to Bun-first deployments that accept the
  published gates and support model. It is not a blanket replacement for every
  official SDK use case, and teams with unusual throughput, history size, or
  platform requirements should run target-environment replay and load checks
  before rollout.

## Security And Reliability Issues

Report security or reliability issues through the repository's normal private
security channel. For determinism issues, include:

- SDK version and Bun version;
- Temporal Server or Cloud version if known;
- workflow type and task queue;
- history JSON or `temporal-bun replay --json` output;
- `production-readiness.json` from the release in use.

## Deprecation Policy

Breaking workflow behavior must be guarded by deterministic versioning APIs such
as `determinism.getVersion` or `determinism.patched`. Removing support for a Bun
or Temporal Server version requires a release note, feature-matrix update, and a
replay-corpus fixture proving old histories still replay or an explicit
unsupported-status entry.
