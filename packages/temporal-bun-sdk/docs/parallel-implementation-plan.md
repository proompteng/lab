# Temporal Bun SDK — Parallel Implementation Plan

**Purpose:** Enable up to ten Codex instances to work concurrently without merge conflicts while the Zig bridge (
`packages/temporal-bun-sdk/bruke`) evolves. Each lane owns a disjoint set of files and validation commands.

| Lane | Scope | Primary Paths | Exit Criteria | Status (30 Oct 2025) |
|------|-------|---------------|----------------|----------------------|
| 1. Client bootstrap | Maintain `connectAsync` and client handle lifecycle. | [`bruke/src/client/common.zig`](../bruke/src/client/common.zig), [`bruke/src/client/connect.zig`](../bruke/src/client/connect.zig), [`tests/client.test.ts`](../tests/client.test.ts) | Connect RPC succeeds end-to-end; pending-handle helpers hardened. | ✅ Core implementation stable; monitor for regressions. |
| 2. Namespace describe | Async DescribeNamespace bridge + helpers. | [`bruke/src/client/describe_namespace.zig`](../bruke/src/client/describe_namespace.zig), [`tests/native.integration.test.ts`](../tests/native.integration.test.ts) | Describe namespace passes integration; docs updated. | ✅ Implemented. |
| 3. Workflow start flows | Start workflow & signal-with-start requests. | [`bruke/src/client/workflows/start.zig`](../bruke/src/client/workflows/start.zig), [`bruke/src/client/workflows/signal_with_start.zig`](../bruke/src/client/workflows/signal_with_start.zig) | Start + signal-with-start return metadata, new unit tests added. | ✅ Implemented with integration coverage. |
| 4. Workflow queries & signals | Query/signal plus shared payload encoding. | [`bruke/src/client/workflows/query.zig`](../bruke/src/client/workflows/query.zig), [`bruke/src/client/workflows/signal.zig`](../bruke/src/client/workflows/signal.zig), [`tests/zig-signal.test.ts`](../tests/zig-signal.test.ts) | Query + signal pending handles resolved safely with coverage. | ✅ Query + signal live; continue expanding tests. |
| 5. Workflow control plane | Terminate, cancel, and header updates. | [`bruke/src/client/workflows/terminate.zig`](../bruke/src/client/workflows/terminate.zig), [`bruke/src/client/workflows/cancel.zig`](../bruke/src/client/workflows/cancel.zig), [`bruke/src/client/update_headers.zig`](../bruke/src/client/update_headers.zig) | Control RPCs documented; TODOs tracked or closed. | ⚠️ Terminate + header updates complete; cancel remains `UNIMPLEMENTED`. |
| 6. Runtime telemetry/logging | Implement runtime telemetry/logging hooks. | [`bruke/src/runtime`](../bruke/src/runtime.zig), [`src/internal/core-bridge/native.ts`](../src/internal/core-bridge/native.ts) | Telemetry APIs exposed with validation. | ⚠️ Pending Zig exports; TypeScript throws on use. |
| 7. Worker polling loops | Worker poll/complete/heartbeat modularisation. | [`bruke/src/worker.zig`](../bruke/src/worker.zig), [`tests/worker`](../tests/worker) | Worker loops implemented with unit tests per module. | ⚠️ Poll/complete/heartbeat and the finalize shutdown path are live with coverage; follow-ups target graceful activity draining telemetry and shutdown metrics. |
| 8. Packaging & release | Build/publish automation for Zig artefacts. | [`scripts/build-zig-artifacts.ts`](../scripts/build-zig-artifacts.ts), [`scripts/package-zig-artifacts.ts`](../scripts/package-zig-artifacts.ts), [`.github/workflows/temporal-bun-sdk.yml`](../../.github/workflows/temporal-bun-sdk.yml) | CI produces release artefacts; docs include checklist. | ⚠️ Packaging scripts exist; CI automation still pending. |
| 9. QA / Benchmarks | Test coverage + performance baselines. | [`tests`](../tests), benchmarks backlog, [`docs/testing-plan.md`](./testing-plan.md) | Coverage thresholds enforced, nightly perf documented. | ⚠️ Core suites exist; performance + nightly coverage TBD. |
| 10. Docs & DX | Documentation & module map upkeep, DX tooling. | [`docs`](./), [`apps/docs`](../../apps/docs) | Docs mirror module layout; new module map maintained. | ⚠️ Ongoing — current task updates status snapshots. |

## Working Agreements

1. **Branch naming:** `codex/<lane>-<topic>`; include lane number in PR description.
2. **Testing:** Each lane maintains the commands listed above plus shared `pnpm --filter @proompteng/temporal-bun-sdk test` and `pnpm run build:native`.
3. **Module ownership:** Only the lane owners edit their module directories; cross-lane changes require agreement. Shared glue lives in `bruke/src/client/mod.zig`—touch it only when wiring a new module.
4. **Documentation:** Lane 10 keeps this plan and `docs/design-e2e.md` in sync with structural changes.
5. **AST tooling:** Use `ast-grep` for scripted refactors when splitting functions, noting the command in PR notes.
