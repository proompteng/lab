# Testing & Validation Plan

**Status Snapshot (30 Oct 2025)**  
- DONE: Bun unit tests cover client serialization, converter helpers, CLI commands, config parsing, and native bridge error propagation.  
- DONE: Integration tests exercise the Zig bridge against the Temporal CLI dev server with both default and custom codecs.  
- DONE: Worker-focused suites drive Zig polling, activity completion, and shutdown flows when `TEMPORAL_BUN_SDK_USE_ZIG=1`.  
- TODO: Determinism/replay harness and telemetry validation still need implementation.  
- TODO: CI orchestration for Zig tests (macOS/Linux matrix) remains manual; contributors run commands locally.

This plan documents the current pyramid and the steps required to reach production readiness.

---

## 1. Test Pyramid Overview

| Layer | Purpose | Current Coverage | Gaps |
|-------|---------|------------------|------|
| Unit (Bun) | Validate serialization, converter helpers, config, CLI flows, native bridge shims | `tests/client.test.ts`, `tests/client/serialization.test.ts`, `tests/payloads/**/*.test.ts`, `tests/config.test.ts`, `tests/cli*.test.ts`, `tests/core-bridge.test.ts`, `tests/native.test.ts`, `tests/worker/**/*.test.ts` | Replay harness, telemetry validation |
| Integration (Temporal CLI) | Exercise real Temporal server with Bun client and worker | `tests/native.integration.test.ts`, `tests/end-to-end-workflow.test.ts`, `tests/zig-signal.test.ts`, `tests/download-client.integration.test.ts` | Cancellation RPC still stubbed; graceful drain telemetry pending |
| Zig tests (`zig build test`) | Validate pending-handle state machines, worker scaffolding | `pnpm --filter @proompteng/temporal-bun-sdk run test:native:zig` | Need broader coverage once worker/client features land |
| Smoke / CLI | Ensure scaffolding commands succeed | `tests/cli.test.ts`, `tests/cli-check.test.ts` | Future: `temporal-bun init` end-to-end run after worker rewrite |
| Replay | Guarantee deterministic workflow execution | N/A | Requires determinism/replay harness on top of Bun workflow runtime |

---

## 2. Commands & Environment

| Scenario | Command |
|----------|--------|
| Unit suites | `bun test` |
| Converter and client suites | `bun test tests/payloads tests/client.test.ts` |
| Workflow runtime focus | `bun test tests/worker.runtime.workflow.test.ts` |
| Zig integration (requires Temporal CLI dev server) | `TEMPORAL_TEST_SERVER=1 bun test tests/native.integration.test.ts` |
| Signal integration | `TEMPORAL_TEST_SERVER=1 bun test tests/zig-signal.test.ts` |
| Zig native tests | `pnpm --filter @proompteng/temporal-bun-sdk run test:native:zig` |
| Temporal CLI lifecycle | `pnpm --filter @proompteng/temporal-bun-sdk run temporal:start` / `temporal:stop` |

> Dev server setup: install the Temporal CLI (`brew install temporal` or direct download), then run the `temporal:start` script before executing integration suites.

---

## 3. Existing Suites

### Bun Unit Tests
- `tests/payloads/json-codec.test.ts`, `tests/payloads/converter.test.ts` — tunnel encoding, converter helpers, and failure payload round-trips (now consolidated in the converter suite).  
- `tests/client.test.ts`, `src/client/serialization.test.ts` — serialization helpers (`buildStartWorkflowRequest`, `computeSignalRequestId`, signal-with-start defaults) with converter-aware expectations.  
- `tests/config.test.ts` — environment parsing and TLS file loading.  
- `tests/core-bridge.test.ts` / `tests/native.test.ts` — native bridge error handling, library discovery fallbacks.  
- `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-activity.test.ts`, `tests/worker/worker-runtime-shutdown.test.ts`, `tests/worker/zig-poll-workflow.test.ts` — drive Bun-native worker loops (poll, complete, heartbeat) via the Zig bridge.  
- `tests/cli.test.ts`, `tests/cli-check.test.ts` — CLI argument parsing and connectivity checks.  
- `tests/github-workflow-validation.test.ts` — ensures GitHub workflows reference existing scripts.

### Integration
- `tests/native.integration.test.ts` — start, signal, query, cancel workflow using Zig bridge, including custom codec coverage when `TEMPORAL_TEST_SERVER=1`.  
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
| Worker polling loops | Extend `tests/worker/**` to cover graceful drain telemetry, cancellation, and Temporal CLI-backed smoke once cancellation lands. | Lane 7 |
| Workflow runtime | Determinism/replay harness after workflow sandbox lands; ensure tunneled payloads replay correctly. | Lane 3 |
| Telemetry/logging | Integration tests for runtime telemetry hooks once Zig exports arrive. | Lane 6 |
| CI automation | GitHub Actions workflow running Bun + Zig tests on macOS and Linux; cache Temporal CLI binaries. | Lane 8 |

Document outcomes in `docs/parallel-implementation-plan.md` as each lane completes its tasks.

---

## 5. CI Recommendations

1. Lint & type-check — `pnpm --filter @proompteng/temporal-bun-sdk run build` (tsc) and Biome linting.  
2. Unit tests — `bun test` on macOS + Linux.  
3. Zig tests — `pnpm --filter @proompteng/temporal-bun-sdk run test:native:zig`.  
4. Integration (optional / nightly) — spin up Temporal CLI server and run `TEMPORAL_TEST_SERVER=1 bun test tests/native.integration.test.ts tests/zig-signal.test.ts`.  
5. Publish artifacts — when releasing, run `pnpm --filter @proompteng/temporal-bun-sdk run prepack` to ensure TypeScript build + Zig artefacts bundle correctly.

---

## 6. Manual QA Checklist

1. Run `temporal-bun init` in a clean directory, install dependencies with Bun, start worker via `bun run dev`.  
2. Use `temporal-bun check` against Temporal CLI dev server and (optionally) Temporal Cloud with TLS/API key.  
3. Execute `bun test` followed by integration suites with `TEMPORAL_TEST_SERVER=1`.  
4. Validate the Zig bridge by setting `TEMPORAL_BUN_SDK_USE_ZIG=1`, re-running client workflow tests, and executing the worker suites (`bun test tests/worker`) to confirm polling/completion loops succeed (cancellation remains TODO). See `tests/worker` for individual cases.  
5. Inspect `nativeLibraryPath` output from `src/internal/core-bridge/native.ts` when debugging loading issues.

---

## 7. References

- Source tree: `tests/**`, `bruke/src/**`, `package.json` scripts.  
- Design docs: `docs/ffi-surface.md`, `docs/parallel-implementation-plan.md`, `docs/workflow-runtime.md`, `docs/payloads-codec.md`.  
- Temporal CLI: <https://github.com/temporalio/cli>.

Keep this plan updated as new suites land so contributors know which commands to run and which scenarios still lack coverage.
