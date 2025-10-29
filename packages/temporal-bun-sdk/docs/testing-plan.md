# Testing & Validation Plan

**Status Snapshot (28 Oct 2025)**  
- ✅ Bun unit tests cover client serialization (`tests/client.test.ts`), CLI commands, config parsing, and native bridge error propagation (`tests/core-bridge.test.ts`, `tests/native.test.ts`).  
- ✅ Integration tests (`tests/native.integration.test.ts`, `tests/zig-signal.test.ts`, `tests/end-to-end-workflow.test.ts`) exercise the Zig bridge against the Temporal CLI dev server when `TEMPORAL_TEST_SERVER=1`.  
- ✅ Worker-focused suites (`tests/worker/**`, `tests/zig-worker-completion.test.ts`) drive Zig polling, activity completion, and shutdown flows when `TEMPORAL_BUN_SDK_USE_ZIG=1`; follow-up work tracks graceful drain telemetry and cancellation parity.  
- ❌ Replay/determinism harness, payload codec tests, and telemetry validation are not implemented.  
- ❌ CI orchestration for Zig tests (macOS/Linux matrix) is still manual; contributors run commands locally.

This plan documents the current pyramid and the steps required to reach production readiness.

---

## 1. Test Pyramid Overview

| Layer | Purpose | Current Coverage | Gaps |
|-------|---------|------------------|------|
| Unit (Bun) | Validate serialization, config, CLI flows, native bridge shims | `client.test.ts`, `config.test.ts`, `cli.test.ts`, `core-bridge.test.ts`, `native.test.ts`, `worker-runtime-*.test.ts` | Need payload codec coverage and workflow determinism harness |
| Integration (Temporal CLI) | Exercise real Temporal server with Bun client | `native.integration.test.ts`, `end-to-end-workflow.test.ts`, `zig-signal.test.ts` | Cancellation RPC still stubbed; graceful drain telemetry pending |
| Zig tests (`zig build test`) | Validate pending-handle state machines, worker scaffolding | Enabled in `package.json` (`test:native:zig`) | Need broader coverage once worker/client features land |
| Smoke / CLI | Ensure scaffolding commands succeed | `cli.test.ts`, `cli-check.test.ts` | Future: `temporal-bun init` end-to-end run after worker rewrite |
| Replay | Guarantee deterministic workflow execution | N/A | Requires determinism/replay harness on top of Bun workflow runtime |

---

## 2. Commands & Environment

| Scenario | Command |
|----------|--------|
| Unit suites | `bun test` |
| Filtered client tests | `bun test tests/client.test.ts` |
| Zig integration (requires Temporal CLI dev server) | `TEMPORAL_TEST_SERVER=1 bun test tests/native.integration.test.ts` |
| Signal integration | `TEMPORAL_TEST_SERVER=1 bun test tests/zig-signal.test.ts` |
| Zig native tests | `pnpm --filter @proompteng/temporal-bun-sdk run test:native:zig` |
| Temporal CLI lifecycle | `pnpm --filter @proompteng/temporal-bun-sdk run temporal:start` / `temporal:stop` |

> **Dev server setup:** install the Temporal CLI (`brew install temporal` or direct download), then run the `temporal:start` script before executing integration suites.

---

## 3. Existing Suites

### Bun Unit Tests
- `tests/client.test.ts` — serialization helpers (`buildStartWorkflowRequest`, `computeSignalRequestId`, `signalWithStart` defaults).  
- `tests/client/serialization.test.ts` ( colocated in `src/client`) — deterministic hashing & payload building.  
- `tests/config.test.ts` — environment parsing and TLS file loading.  
- `tests/core-bridge.test.ts` — native bridge error handling, library discovery fallbacks.  
- `tests/native.test.ts` — sanity checks around `NativeBridgeError` and stubbed exports.  
- `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-activity.test.ts`, `tests/worker/worker-runtime-shutdown.test.ts`, `tests/worker/zig-poll-workflow.test.ts` — drive Bun-native worker loops (poll, complete, heartbeat) via the Zig bridge.  
- `tests/cli.test.ts` / `tests/cli-check.test.ts` — CLI argument parsing and connectivity checks.  
- `tests/github-workflow-validation.test.ts` — ensures GitHub workflows reference existing scripts.

### Integration
- `tests/native.integration.test.ts` — start/query workflow using Zig bridge.  
- `tests/end-to-end-workflow.test.ts` — runs sample workflow using Node worker fallback.  
- `tests/zig-signal.test.ts` — validates signal path when Zig bridge is active.  
- `tests/download-client.integration.test.ts` — ensures bundled Temporal libs download correctly.

### Zig (`zig build test`)
- Covers JSON parsing helpers, pending handle transitions, and worker stubs in `bruke/src`. Expand as new Zig modules ship.

---

## 4. Planned Additions

| Area | Description | Owner / Lane |
|------|-------------|--------------|
| Cancellation integration | Add Bun + Zig tests once `temporal_bun_client_cancel_workflow` is implemented. | Lane 5 |
| Header updates | ✅ Bun + Zig coverage for metadata mutation (Oct 2025). | Lane 5 |
| Worker polling loops | Extend `tests/worker/**` to cover graceful drain telemetry, cancellation once implemented, and Temporal CLI-backed smoke. | Lane 7 |
| Workflow runtime | Determinism/replay harness after workflow sandbox lands. | Lane 3 |
| Telemetry/logging | Integration tests for runtime telemetry hooks. | Lane 6 |
| Payload codecs | Unit + integration coverage for new data converter module. | Lane 10 (docs & DX) |
| CI automation | GitHub Actions workflow running Bun + Zig tests on macOS and Linux; cache Temporal CLI binaries. | Lane 8 |

Document outcomes in `docs/parallel-implementation-plan.md` as each lane completes its tasks.

---

## 5. CI Recommendations

1. **Lint & Typecheck** — `pnpm --filter @proompteng/temporal-bun-sdk run build` (tsc) and Biome linting.  
2. **Unit Tests** — `bun test` on macOS + Linux.  
3. **Zig Tests** — `pnpm --filter @proompteng/temporal-bun-sdk run test:native:zig`.  
4. **Integration (optional / nightly)** — spin up Temporal CLI server and run `TEMPORAL_TEST_SERVER=1 bun test tests/native.integration.test.ts tests/zig-signal.test.ts`.  
5. **Publish artifacts** — when releasing, run `pnpm --filter @proompteng/temporal-bun-sdk run prepack` to ensure TypeScript build + Zig artefacts bundle correctly.

---

## 6. Manual QA Checklist

1. Run `temporal-bun init` in a clean directory, install dependencies with Bun, start worker via `bun run dev`.  
2. Use `temporal-bun check` against Temporal CLI dev server and (optionally) Temporal Cloud with TLS/API key.  
3. Execute `bun test` followed by integration suites with `TEMPORAL_TEST_SERVER=1`.  
4. Validate the Zig bridge by setting `TEMPORAL_BUN_SDK_USE_ZIG=1`, re-running client workflow tests, and executing the worker suites (`bun test tests/worker`) to confirm polling/completion loops succeed (cancellation remains TODO).  
5. Inspect `nativeLibraryPath` output from `src/internal/core-bridge/native.ts` when debugging loading issues.

---

## 7. References

- Source tree: `tests/**`, `bruke/src/**`, `package.json` scripts.  
- Design docs: `docs/ffi-surface.md`, `docs/parallel-implementation-plan.md`, `docs/worker-runtime.md`.  
- Temporal CLI: [GitHub repo](https://github.com/temporalio/cli).

Keep this plan updated as new suites land so contributors know which commands to run and which scenarios still lack coverage.
