# Temporal Bun SDK Design Docs

This folder captures design requirements and plans for the next major
capabilities of `@proompteng/temporal-bun-sdk`. Each document focuses on a
single surface area and defines goals, requirements, API sketches, and
acceptance criteria.

## Index
- `testing-environment.md` - Bun-native test environment with time skipping and
  ephemeral server orchestration.
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
