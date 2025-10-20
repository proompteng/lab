# Migration Phases & Milestones

**Purpose:** Track the staged rollout from the current hybrid SDK to a fully Bun-native Temporal SDK.

---

## Phase 0 — Baseline (Current)

- Minimal FFI (runtime + client connect).
- TypeScript layer re-exports upstream packages.
- CLI scaffolding available, but workers rely on `@temporalio/worker`.
- Example project uses workspace link but still depends on upstream packages.

**Exit Criteria:** FFI blueprint, module-specific plans (this doc set) complete. ✅

---

## Phase 1 — Client Parity

```mermaid
flowchart LR
  P0["Phase 0<br/>Baseline hybrid SDK"] --> P1["Phase 1<br/>Client parity via FFI"]
  P1 --> P2["Phase 2<br/>Worker core & runtime"]
  P2 --> P3["Phase 3<br/>Workflow determinism & interceptors"]
  P3 --> P4["Phase 4<br/>Telemetry & tooling"]
  P4 --> P5["Phase 5<br/>Release readiness"]
```

- Implement FFI for client operations (start, signal, query, terminate, headers, TLS) aligning with the [Temporal TypeScript client API](https://docs.temporal.io/develop/typescript/temporal-client).
- Rewrite `src/client.ts` to use new Core bridge client.
- ✅ `start_workflow` wired through Rust bridge + Bun client (`createTemporalClient.workflow.start`).
- Remove `@temporalio/client` dependency.
- Add unit + integration tests for client operations.

**Deliverables:**
- Passing tests (`client` suites).
- Docs/README updated.
- Example project uses new client for workflow start/query.

---

## Phase 2 — Worker Core

- FFI for worker poll/complete/heartbeat/shutdown.
- Implement new worker runtime loops.
- Build minimal workflow runtime to process activations following the [worker and workflow docs](https://docs.temporal.io/develop/typescript/workers).
- Replace `@temporalio/worker` dependency.
- CLI worker runs successfully against local Temporal server.

**Milestones:**
- Unit tests for worker loops.
- Integration tests for simple workflow execution.
- Document limitations (no local activities, etc. if deferred).

---

## Phase 3 — Workflow Runtime Parity

- Support deterministic features (patch markers, continue-as-new, child workflows) as documented in the [workflow versioning guide](https://docs.temporal.io/develop/typescript/workflows#versioning).
- Implement interceptor pipeline.
- Provide payload codec extensibility (JSON + optional binary).
- Add determinism replay harness.

**Success Metrics:**
- Replay tests green.
- Sample workflows from upstream examples run without code changes.

---

## Phase 4 — Ecosystem Integration

- Telemetry exports (Prometheus, OTLP) matching the best practices in [Temporal’s observability guide](https://docs.temporal.io/production-readiness/observability).
- Metrics/logging callbacks wired into runtime.
- CLI and Docker templates updated to use native stack only.
- Documentation and tutorials refreshed.

**Optional:** Provide pre-built native binaries for macOS/Linux to streamline installs.

---

## Phase 5 — Release Readiness

- CI lanes stable on macOS/Linux (unit + integration).
- Publish RC build to npm (`0.1.0-rc.1`) once the native bridge compiles successfully across macOS/Linux (see [Zig getting started](https://ziglang.org/learn/getting-started/) for supported toolchains).
- Manual QA across local Temporal + Temporal Cloud.
- Collect feedback, address bugs, finalize stable release.

---

## Tracking & Ownership

- Maintain a checklist in GitHub Projects (one column per phase).
- Each phase should have an owner, deadlines, and link to PRs.
- Update `design-e2e.md` summary as phases complete.

## References

- [Temporal TypeScript developer docs](https://docs.temporal.io/develop/typescript)
- [Temporal workflow versioning guidance](https://docs.temporal.io/develop/typescript/workflows#versioning)
- [Temporal observability best practices](https://docs.temporal.io/production-readiness/observability)
- [Temporal TypeScript sample workflows](https://github.com/temporalio/samples-typescript)
- [Zig getting started guide](https://ziglang.org/learn/getting-started/)
