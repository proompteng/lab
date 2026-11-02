# Temporal Bun SDK Design Docs

This folder captures design requirements and plans for the next major
capabilities of `@proompteng/temporal-bun-sdk`. Each document focuses on a
single surface area and defines goals, requirements, API sketches, and
acceptance criteria.

## Index

- `testing-environment.md` - Bun-native test environment with time skipping and
  ephemeral server orchestration.
- `nondeterminism-guardrails.md` - Defense-in-depth plan to prevent production
  nondeterministic workflow failures (versioning policy, runtime guards, linting,
  and replay CI gates).
- `workflow-runtime-sandbox.md` - Runtime “sandbox” guards that make common
  nondeterministic APIs deterministic (Date/Math.random) or fail fast (fetch/fs/etc)
  when executed in workflow context.
- `workflow-linting.md` - Build-time checks for workflow source imports and banned
  APIs; CLI contract and configuration for enforcement in CI and `temporal-bun init`.
- `replay-ci-gate.md` - CI gate that replays golden workflow histories and blocks
  merges that would introduce nondeterminism without version guards.
- `schedules-and-search-attributes.md` - Schedule client + typed search
  attributes with schema validation.
- `nexus-operations.md` - Nexus task polling, handler runtime, and client helpers.
- `worker-ops-and-versioning.md` - Worker ops RPCs, versioning rules, deployments,
  and task-queue controls.
- `replay-and-debugger.md` - Replay pipeline, determinism diffing, and debugger
  integration.
- `observability-and-plugins.md` - Observability pipeline, workflow sinks, and
  plugin/tuner architecture.
- `rpc-coverage.md` - Requirements checklist for all new RPCs to expose.
- `release-summary.md` - Release-ready summary, migration notes, feature flags,
  and operational guidance.
