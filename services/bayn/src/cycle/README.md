# Autonomous cycle module

This directory owns the complete autonomous-cycle subsystem. Internal filenames do not repeat the `cycle-` prefix; `Cycle*` domain names and durable schema, SQL, evidence, and identifier names remain stable contracts.

## Layers

- `model.ts`, `construction.ts`, `transitions.ts`, and `recovery-decisions.ts` are the pure domain core. Prefer `Result` for validation and deterministic construction; do not add runtime services or persistence here.
- `observability.ts` contains pure cadence and operational projections. Keep status selection deterministic and independent of I/O.
- `readiness.ts` and `recovery.ts` expose orchestration-facing cycle capabilities while preserving typed failures.
- `runner/` owns autonomous pass discovery, admission, recovery, and loop orchestration. Use `Effect` for service composition and interruption-aware runtime work; keep decisions pure where possible.
- `store/` owns PostgreSQL persistence and database-backed observability. It may depend on the pure cycle core, but the pure core must not depend on persistence.

## Dependency direction

Prefer `model/construction/transitions/recovery-decisions -> observability/readiness -> runner -> composition`. Persistence is an infrastructure dependency consumed by orchestration, not a home for domain decisions. Internal cycle code should import the narrow file it needs; consumers outside this directory should use `./cycle`, `./cycle/runner`, `./cycle/observability`, or `./cycle/store` as the intended boundaries.

The architecture test protects the module from import cycles and layer back-edges: the pure cycle core cannot depend on runner/store infrastructure, and persistence cannot depend on runner orchestration.
