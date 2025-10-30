# Workflow Runtime Plan

**Status Snapshot (30 Oct 2025)**  
- DONE: `WorkflowEngine` and `WorkflowEnvironment` load the shared data converter so workflow activations, signals, queries, and continue-as-new commands reuse the same codec configuration.  
- DONE: Workflow completions tunnel payload metadata back through the worker runtime to keep compatibility with the Zig bridge.  
- TODO: Determinism tooling (history replay harness, patch marker coverage, richer interceptor DX) remains in flight.  
- TODO: Telemetry and replay diagnostics still need to be ported from the upstream TypeScript SDK.

**Goal:** Provide a deterministic workflow execution environment compatible with Temporal's expectations, implemented purely with Bun primitives while matching the behaviour described in the Temporal TypeScript workflow documentation. See the [Temporal workflows overview](https://docs.temporal.io/develop/typescript/workflows).

---

## 1. Key Responsibilities

| Area | Requirements |
|------|--------------|
| Activation handling | Consume workflow activations from worker loop, apply commands (timer, activity, signal, child workflow). |
| Determinism | Same code + history => same commands. Ensure timers, random, and external world access behave deterministically, following the Temporal replay contract. |
| Workflow sandboxing | Prevent workflows from accessing ambient state; maintain per-run context (sandbox semantics documented in the TypeScript SDK). |
| Interceptors | Support inbound/outbound workflow interceptors for logging/tracing. See the [interceptors guide](https://docs.temporal.io/develop/typescript/interceptors). |
| Patch markers | Respect versioning via `patched` / `deprecatePatch` helpers. See [workflow versioning](https://docs.temporal.io/develop/typescript/workflows#versioning). |

---

## 2. Execution Model

1. Maintain a `WorkflowEnvironment` object per workflow run:
   - State machine (history events, pending commands).
   - Activity completion promises.
   - Timer scheduler.
   - Signal/query handlers.
   - Data converter reference used by command encoders.

2. Workflow activation pipeline:
   - Decode activation (proto) into JS structure.
   - Replay events in order.
   - Drive workflow generator/async function until next yield (`await` boundary).
   - Collect commands and serialize as workflow task completion.

3. Isolation strategy:
   - Use Bun's `import()` to load workflow modules fresh per run (works with ESM and Bun-transpiled TS).
   - Wrap built-ins (`Date`, `Math.random`, UUID generators) with deterministic shims to preserve replay guarantees.
   - Provide workflow `Context` (activities via `proxyActivities`, condition utilities, `continueAsNew`, child workflow helpers) identical to the upstream API.

---

## 3. Modules in Play

`src/workflow/runtime/engine.ts`, `environment.ts`, `bootstrap.ts`, and `info.ts` already back the live runtime. Follow-on work tracks determinism tooling and developer ergonomics in the remaining modules:

| Module | Description |
|--------|-------------|
| `context.ts` | Builds the `workflow` namespace exports (activities proxy, condition, sleep). |
| `activator.ts` | Applies activations, manages pending commands. |
| `history.ts` | Lightweight history/event parser (can reuse proto definitions). |
| `determinism.ts` | Shims for deterministic random/timer. |
| `interceptors.ts` | Register and execute interceptor chain. |
| `encoder.ts` | Convert JS results/errors into completion payloads (now layered on the shared converter). |

---

## 4. Payload Handling

- `WorkflowEnvironment` stores the converter returned by `createWorkflowEnvironment`. Activations decode payloads via `decodePayloadsToValues` / `decodePayloadMapToValues` before entering workflow code.
- Command generation (`completeWorkflowExecution`, `failWorkflowExecution`, `continueAsNewWorkflowExecution`) uses `encodeValuesToPayloads` and map helpers. Empty collections become `{}` so the Zig bridge continues receiving JSON objects.
- Failure handling relies on `encodeFailurePayloads` to ensure activity/workflow errors retain converter metadata.
- JSON tunnelling uses the shared helpers from `src/common/payloads/json-codec.ts`, keeping round-trips deterministic.

---

## 5. Testing Matrix

1. **Unit Tests**
   - Activation replay vs live execution produce identical commands.
   - Patching semantics: ensure old/new paths behave depending on patch marker (still pending).
   - Timers + cancel: schedule, fire, cancel, continue-as-new.
   - Signals + queries: ensure handlers invoked deterministically and payloads pass through converter.

2. **Integration Tests**
   - Run sample workflows via worker to verify end-to-end completions.
   - Determinism test: run workflow, capture history, replay in isolation, assert commands equal (future work).
   - Custom codec integration: see `tests/native.integration.test.ts` for end-to-end verification with a codec.

3. **Failure Injection**
   - Activity failure propagation.
   - Workflow panic -> failure command.

---

## 6. Open Considerations

- **Workflow bundling:** For now rely on Bun to execute TS modules directly. Later evaluate bundling to JS for deployable artifacts.
- **Node compatibility:** Intentionally Bun-only; document this and ensure errors clearly state unsupported platform.
- **Resource cleanup:** Use `FinalizationRegistry` to dispose workflow environments if worker shuts down mid-execution.
- **Determinism tooling:** Build history replay harness that consumes tunneled payloads to confirm converter metadata does not break replays.

Keep this plan in sync with actual runtime capabilities; append change logs as features land.
