# CRD: AgentRun Workflow Loops With Shared State

Status: Draft (2026-02-28)

Docs index: [README](../README.md)

## Overview

`AgentRun` workflow currently executes each `spec.workflow.steps[]` entry once per run.
This proposal adds loop semantics to workflow steps so a single step can run multiple iterations:

- without a condition (fixed-count loop), and
- with a condition (conditional loop).

The primary requirement is state continuity: iteration `N+1` must be able to continue from
the exact filesystem state produced by iteration `N`.

## Goals

- Add first-class loop support to `AgentRun.spec.workflow.steps[]`.
- Support both fixed-count and conditional loops.
- Reuse state volumes between iterations so work can continue incrementally.
- Keep existing non-loop workflows behaviorally unchanged.
- Define deterministic behavior for retries, timeouts, cancellation, and idempotent resubmission.

## Non-Goals

- Replacing the existing workflow runtime with another engine.
- Running loop iterations in parallel.
- Cross-namespace state sharing.
- Automatic branch-level merge conflict resolution between iterations.

## Current State

- `AgentRun` supports `workflow.steps[]` with retries/timeouts:
  - API types: `services/jangar/api/agents/v1alpha1/types.go`
  - CRD: `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`
- Controller runs workflow steps in-order and submits one Job for the active step attempt:
  - `services/jangar/src/server/agents-controller/workflow-reconciler.ts`
- Workload volumes support `pvc`, `emptyDir`, and `secret`:
  - `services/jangar/src/server/agents-controller/job-runtime.ts`
- No loop API exists today.

## Terminology

- Iteration: one full run of a looped workflow step.
- Iteration attempt: one retry attempt for an iteration.
- Loop state volume: mounted volume expected to persist mutable files across iterations.

## API Proposal

Add optional `loop` to `WorkflowStep`.

```yaml
spec:
  workflow:
    steps:
      - name: implement
        implementationSpecRef:
          name: torghut-impl
        loop:
          maxIterations: 8
          condition:
            type: cel
            expression: "iteration.last.control.continue == true"
            source:
              type: file
              path: /workspace/.agentrun/loop-control.json
              onMissing: stop
              onInvalid: fail
          state:
            required: true
            volumeNames: ['workspace']
```

### New fields (proposed)

```yaml
WorkflowStep:
  loop:
    maxIterations: int32 # required when loop is set; >= 1
    condition:           # optional; if omitted => fixed-count
      type: cel          # v1: cel only
      expression: string
      source:
        type: file       # v1: file only
        path: string     # absolute path in job filesystem
        onMissing: stop|fail   # default: stop
        onInvalid: stop|fail   # default: fail
    state:
      required: bool     # default: false
      volumeNames: []    # names from effective workload.volumes
```

## Condition Input Contract

### Source and transport

- For `condition.source.type=file`, controller evaluates condition from control payload emitted by the completed iteration.
- v1 contract: loop control payload is read from file path in `condition.source.path`.
- Default path if omitted: `/workspace/.agentrun/loop-control.json`.
- File is read from the same persistent volume mounted into the next iteration.

### File payload schema (recommended)

```json
{
  "continue": true,
  "outputs": {
    "summary": "implemented initial pass",
    "remaining_tasks": 3
  },
  "reason": "needs another refinement pass"
}
```

Rules:

- Payload root must be a JSON object.
- Unknown fields are allowed.
- If `continue` is omitted, condition expression decides based on other fields.
- If file is missing, use `onMissing` behavior.
- If JSON is invalid or non-object, use `onInvalid` behavior.

### CEL context

CEL gets:

- `iteration.index` (1-based completed iteration index)
- `iteration.maxIterations`
- `iteration.last.phase` (`Succeeded`, `Failed`, `Cancelled`)
- `iteration.last.control` (parsed JSON object, or `{}` if unavailable and not failing)
- `step.name`
- `run.parameters`

## Execution Semantics

### Fixed-count loop (no condition)

- When `loop` exists and `condition` is omitted:
  - run until `completedIterations == maxIterations`, or
  - stop earlier only on terminal failure/cancellation.
- On final successful iteration, step phase becomes `Succeeded` with reason `LoopMaxIterationsReached`.

### Conditional loop

- Iteration 1 always runs.
- After each successful iteration:
  - if `completedIterations == maxIterations`: stop with `LoopMaxIterationsReached`.
  - else evaluate condition.
  - `true` => schedule next iteration.
  - `false` => stop with `LoopConditionFalse`.
- If condition evaluation fails and policy is `fail`, step fails with `LoopConditionError`.

### Retry and timeout boundaries

- Existing `retries`, `retryBackoffSeconds`, and `timeoutSeconds` remain per iteration.
- Retry budget resets at the beginning of each new iteration.
- Timeout applies to one iteration attempt, not the whole loop.
- If retries exhaust for an iteration, loop stops with `LoopIterationFailed`.

### Cancellation semantics

- If AgentRun transitions to `Cancelled`, active iteration is marked `Cancelled`, no new iteration is scheduled.
- Loop stop reason becomes `LoopCancelled`.

### Idempotency and resubmission

- Existing idempotency scope remains unchanged.
- Resubmitting with the same `(namespace, agentRef, idempotencyKey)` must not resume from intermediate loop state.
- Result is existing-run reuse/duplicate rejection per idempotency policy; loop resume is out of scope.

## Shared State / Volume Reuse Semantics

Loop continuity is enforced as an explicit contract:

- `loop.state.volumeNames` identifies required persistent mutable volumes for continuation.
- Each listed volume must resolve from effective workload volumes (step workload, fallback to run workload).
- v1 mutable continuity requires listed volumes to be `pvc`.
- `emptyDir` and `secret` volumes are never considered loop-persistent mutable state.

Job scheduling constraints:

- Only one iteration Job for a looped step may run at a time.
- Every iteration mounts the exact same PVC claim names for listed volumes.
- This avoids RWO contention and guarantees deterministic filesystem continuity.

Workspace CR integration:

- v1 does not introduce `workspaceRef` on `WorkflowStep`.
- If operators already provision PVCs via `Workspace` CR, looped steps can reference those PVCs through existing `workload.volumes[].claimName`.

## Status Model (proposed)

Extend step status with loop metadata.

```yaml
status:
  workflow:
    steps:
      - name: implement
        phase: Running
        loop:
          currentIteration: 2
          completedIterations: 1
          maxIterations: 8
          stopReason: ""
          retainedIterations: 2
          prunedIterations: 0
          iterations:
            - index: 1
              phase: Succeeded
              startedAt: "2026-02-28T05:00:00Z"
              finishedAt: "2026-02-28T05:04:00Z"
              attempts: 1
              jobRef:
                name: run-step-1-iter-1-attempt-1
            - index: 2
              phase: Running
              startedAt: "2026-02-28T05:04:10Z"
              attempts: 1
              jobRef:
                name: run-step-1-iter-2-attempt-1
```

Stop reasons:

- `LoopMaxIterationsReached`
- `LoopConditionFalse`
- `LoopConditionError`
- `LoopIterationFailed`
- `LoopCancelled`

## Status Size and Compaction

Iteration history can grow quickly, so status is bounded.

Controller limits (proposed):

- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_STATUS_HISTORY_LIMIT` (default `50` per step).

Compaction rules:

- Keep latest `N` iteration records per step.
- Increment `prunedIterations` when dropping old records.
- Preserve aggregate counters (`completedIterations`, `retainedIterations`) so full progress remains visible.
- Always retain the latest failed/cancelled iteration entry.

## Validation Rules (proposed)

- `loop.maxIterations >= 1`.
- `loop.maxIterations <= JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS` (default `20`).
- `loop.state.volumeNames` must be unique.
- `loop.state.volumeNames[*]` must resolve to existing workload volume names.
- If `loop.state.required=true`, at least one listed volume must be mutable persistent storage (`type=pvc`).
- If `condition` is present:
  - `condition.type=cel` required.
  - `condition.expression` must be non-empty.
  - `source.path` must be absolute when `source.type=file`.
- Reject loop config on non-workflow runtime.

## Backward Compatibility

- Steps without `loop` continue current behavior.
- Existing step/job status fields remain.
- Looped job names append iteration and attempt suffix, for example:
  - `...-step-1-iter-2-attempt-1`

## Chart / Controller Changes

### CRD + API types

- Add loop fields to Go API:
  - `services/jangar/api/agents/v1alpha1/types.go`
- Regenerate CRD:
  - `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`

### Controller runtime

- Parse and validate loop spec:
  - `services/jangar/src/server/agents-controller/workflow.ts`
- Reconcile iterations and condition evaluation:
  - `services/jangar/src/server/agents-controller/workflow-reconciler.ts`
- Persist iteration metadata and compaction counters in step status.

### Env/config additions (proposed)

- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED` (default `false` for phased rollout).
- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS` (default `20`).
- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_STATUS_HISTORY_LIMIT` (default `50`).

## Rollout Plan

1. Add API fields and reconciliation logic behind `...WORKFLOW_LOOPS_ENABLED`.
2. Add chart examples:
   - fixed loop,
   - conditional loop with control payload.
3. Add unit/integration tests for iteration lifecycle and compaction.
4. Enable in non-prod with low `maxIterations`.
5. Monitor reconcile latency and status size before prod enablement.

Rollback:

- Set `...WORKFLOW_LOOPS_ENABLED=false`.
- Controller rejects new loop specs with `InvalidSpec`.
- Existing non-loop runs continue unaffected.

## Test Matrix

- Fixed loop: `maxIterations=2`, both iterations succeed => final `Succeeded`, stop reason `LoopMaxIterationsReached`.
- Conditional loop true then false => stops early with `LoopConditionFalse`.
- Conditional loop missing payload file with `onMissing=stop` => succeeds and stops.
- Conditional loop missing payload file with `onMissing=fail` => fails with `LoopConditionError`.
- Invalid JSON payload with `onInvalid=fail` => fails deterministically.
- Iteration timeout with retries remaining => `Retrying`, then next attempt.
- Iteration timeout with retries exhausted => `LoopIterationFailed`.
- Required PVC volume missing/misconfigured => `InvalidSpec` before first job.
- Cancellation during running iteration => no additional iterations scheduled.
- Controller restart during loop => reconciliation resumes from status without duplicating completed iterations.
- Status history limit reached => old iterations pruned, counters preserved.
- Idempotent resubmission with same key => no loop resume side effect.

## Validation Commands

```bash
scripts/agents/validate-agents.sh

kubectl -n agents apply -f /tmp/agentrun-loop-fixed.yaml
kubectl -n agents get agentrun codex-loop-fixed -o yaml | rg -n "loop:|currentIteration|completedIterations|stopReason|prunedIterations"
kubectl -n agents get job -l agents.proompteng.ai/agent-run=codex-loop-fixed
```

## Example Manifests

Use these chart examples as copy-paste baselines:

- Fixed-count loop:
  - `charts/agents/examples/agentrun-workflow-loop-fixed.yaml`
- Conditional loop (CEL + control payload semantics):
  - `charts/agents/examples/agentrun-workflow-loop-conditional.yaml`

Apply and inspect:

```bash
kubectl -n agents apply -f charts/agents/examples/agentrun-workflow-loop-fixed.yaml
kubectl -n agents apply -f charts/agents/examples/agentrun-workflow-loop-conditional.yaml

kubectl -n agents get agentrun codex-workflow-loop-fixed -o yaml | rg -n "loop:|currentIteration|completedIterations|stopReason"
kubectl -n agents get agentrun codex-workflow-loop-conditional -o yaml | rg -n "loop:|currentIteration|completedIterations|stopReason"
kubectl -n agents get job -l agents.proompteng.ai/agent-run=codex-workflow-loop-conditional
```

## Failure Modes and Mitigations

- Unbounded runtime due to bad conditions:
  - enforce hard max iterations and default-disabled feature gate.
- State drift/corruption across iterations:
  - require explicit PVC contract for mutable state and serialize iterations.
- Status bloat:
  - cap iteration history and expose aggregate counters.
- Ambiguous condition behavior:
  - explicit `onMissing` and `onInvalid` policies, plus deterministic stop reasons.

## Acceptance Criteria

- Fixed and conditional loops execute deterministically with documented stop reasons.
- State continuity works across iterations using the same PVC-backed mount.
- Retry/timeout/cancellation/idempotency behavior is explicitly defined and test-covered.
- Status remains bounded under long loops while preserving observability.
- Existing non-loop AgentRuns continue unchanged.

## References

- AgentRun workflow schema: `services/jangar/api/agents/v1alpha1/types.go`
- Workflow reconciler: `services/jangar/src/server/agents-controller/workflow-reconciler.ts`
- Job volume mounting: `services/jangar/src/server/agents-controller/job-runtime.ts`
- Workspace PVC primitive: `charts/agents/crds/workspaces.proompteng.ai_workspaces.yaml`
