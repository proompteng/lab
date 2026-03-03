# AgentRun Workflow Loop Launch Guide

Status: Current (2026-03-01)

Docs index: [README](README.md)

## Purpose

Launch `AgentRun` workflows that iterate reliably and reuse state across iterations.

This guide covers:

- fixed-count loops (no condition),
- conditional loops (CEL expression), and
- state reuse via PVC-backed volumes.

## Preconditions

- `spec.runtime.type` must be `workflow`.
- The target `Agent`, `AgentProvider`, and `ImplementationSpec` must already exist.
- At least one loop state volume must be PVC-backed (`type: pvc`) when `loop.state.required: true`.
- Use a unique writable `spec.parameters.head` branch (repo convention: `codex/...`).
- Prefer omitting `spec.workload.image` so runs inherit the controller-managed runner image.

## Verify Loop Feature Flags

Loop execution is guarded by controller env vars.

```bash
kubectl -n agents get deployment agents-controllers \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | rg 'JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED|JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS'
```

Expected:

- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED=true`
- `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS=<limit>`

Preferred enablement path is GitOps (set controller env vars in `argocd/applications/agents/values.yaml` and sync).
For emergency/manual enablement:

```bash
kubectl -n agents set env deployment/agents-controllers \
  JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED=true \
  JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS=20
kubectl -n agents rollout status deployment/agents-controllers
```

## Fixed-Count Loop (State Reuse, 5 Iterations)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: torghut-loop-workspace
  namespace: agents
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
---
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: torghut-priority-loop5
  namespace: agents
spec:
  agentRef:
    name: codex-spark-agent
  implementationSpecRef:
    name: torghut-v5-uncertainty-gates-priority
  runtime:
    type: workflow
  workflow:
    steps:
      - name: implement
        retries: 1
        retryBackoffSeconds: 30
        timeoutSeconds: 5400
        parameters:
          stage: implement
        loop:
          maxIterations: 5
          state:
            required: true
            volumeNames:
              - workspace
  vcsRef:
    name: github
  vcsPolicy:
    required: true
    mode: read-write
  secrets:
    - github-token
    - codex-auth
  ttlSecondsAfterFinished: 172800
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/torghut-v5-uncertainty-gates-loop5-20260301
    artifactPath: /workspace/.agentrun/torghut-v5-02
  workload:
    resources:
      requests:
        cpu: 500m
        memory: 1024Mi
    volumes:
      - name: workspace
        type: pvc
        claimName: torghut-loop-workspace
        mountPath: /workspace
```

Runner image safety:

- Default: do not set `spec.workload.image` in AgentRun manifests.
- The controller resolves runner image in this order:
  1. `AgentRun.spec.workload.image`
  2. `JANGAR_AGENT_RUNNER_IMAGE`
  3. `JANGAR_AGENT_IMAGE`
- Set `spec.workload.image` only when intentionally pinning a known-good image for a controlled rollout.

## Conditional Loop

Use conditional loops when continuation should depend on control output from the previous iteration.

```yaml
loop:
  maxIterations: 8
  condition:
    type: cel
    expression: 'iteration.index < iteration.maxIterations && iteration.last.control.continue == true'
    source:
      type: file
      path: /workspace/.agentrun/loop-control.json
      onMissing: stop
      onInvalid: fail
  state:
    required: true
    volumeNames:
      - workspace
```

Notes:

- `onMissing: stop` cleanly exits when control payload is absent.
- `onInvalid: fail` fails fast on malformed control payload.
- Condition source default path is `/workspace/.agentrun/loop-control.json`.

## Prompt Contract For Continuation

CRD loop state only guarantees volume persistence; it does not force your agent to use that path.

Your `ImplementationSpec.spec.text` should explicitly require:

- use `/workspace` (or another persisted mount) for repo/artifacts,
- read prior iteration notes before continuing,
- write per-iteration notes (for example `${artifactPath}/iteration-<n>.md`),
- continue from existing branch/worktree, not a fresh unrelated location.

Avoid `spec.parameters.prompt` unless intentionally overriding the ImplementationSpec text.

## Launch Commands

```bash
kubectl -n agents apply -f /tmp/agentrun-loop5.yaml
kubectl -n agents get agentrun torghut-priority-loop5
kubectl -n agents get jobs -l agents.proompteng.ai/agent-run=torghut-priority-loop5 -o name
```

## Verify System Prompt Enforcement (Required Before Trusting A Run)

Do not trust a loop run until system prompt wiring is verified on the live runtime pod.

```bash
RUN=torghut-priority-loop5
EXPECTED=$(kubectl -n agents get configmap codex-agent-system-prompt -o jsonpath='{.data.system-prompt\.md}' \
  | sha256sum | awk '{print $1}')

JOB=$(kubectl -n agents get jobs -l agents.proompteng.ai/agent-run="$RUN" -o jsonpath='{.items[0].metadata.name}')
POD=$(kubectl -n agents get pod -l job-name="$JOB" -o jsonpath='{.items[0].metadata.name}')

kubectl -n agents get pod "$POD" \
  -o jsonpath='{range .spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | rg 'CODEX_SYSTEM_PROMPT_PATH|CODEX_SYSTEM_PROMPT_EXPECTED_HASH|CODEX_SYSTEM_PROMPT_REQUIRED'

kubectl -n agents exec "$POD" -- /bin/bash -lc \
  'test -f /workspace/.codex/system-prompt.txt && sha256sum /workspace/.codex/system-prompt.txt | awk "{print \$1}"'

kubectl -n agents get agentrun "$RUN" -o jsonpath='statusSystemPromptHash={.status.systemPromptHash}{"\n"}'
echo "expectedConfigMapHash=$EXPECTED"
```

Pass criteria (all must match):

- `CODEX_SYSTEM_PROMPT_PATH=/workspace/.codex/system-prompt.txt`
- `CODEX_SYSTEM_PROMPT_REQUIRED=true`
- `CODEX_SYSTEM_PROMPT_EXPECTED_HASH` equals:
  - mounted file hash from `/workspace/.codex/system-prompt.txt`,
  - `status.systemPromptHash`,
  - ConfigMap content hash (`expectedConfigMapHash`).

## Verify Loop Progress

```bash
RUN=torghut-priority-loop5

kubectl -n agents get agentrun "$RUN" -o jsonpath='
phase={.status.phase}{"\n"}
workflowPhase={.status.workflow.phase}{"\n"}
currentIteration={.status.workflow.steps[0].loop.currentIteration}{"\n"}
completedIterations={.status.workflow.steps[0].loop.completedIterations}{"\n"}
maxIterations={.status.workflow.steps[0].loop.maxIterations}{"\n"}
stopReason={.status.workflow.steps[0].loop.stopReason}{"\n"}'

kubectl -n agents get jobs \
  -l agents.proompteng.ai/agent-run="$RUN" \
  -o custom-columns=NAME:.metadata.name,SUCCEEDED:.status.succeeded,FAILED:.status.failed,ACTIVE:.status.active
```

Loop stop reasons to expect:

- `LoopMaxIterationsReached`
- `LoopConditionFalse`
- `LoopConditionError`
- `LoopIterationFailed`

## Common Failures

- `InvalidSpec` with loop fields:
  - check `runtime.type=workflow`,
  - check loop feature flag is enabled,
  - check `loop.maxIterations` does not exceed controller limit.
- `loop.state.required=true` rejected:
  - ensure at least one listed state volume is `type: pvc`.
- Iterations not preserving state:
  - ensure the agent writes to persisted mount (`/workspace`), not `/tmp`.
- System prompt not applied:
  - verify the run uses the expected `spec.agentRef.name`,
  - verify pod env contains `CODEX_SYSTEM_PROMPT_PATH`, `CODEX_SYSTEM_PROMPT_EXPECTED_HASH`, and `CODEX_SYSTEM_PROMPT_REQUIRED=true`,
  - verify mounted prompt file hash equals `status.systemPromptHash`.
- Run fails with provider/auth/model errors:
  - check `spec.secrets` includes required auth secrets (`codex-auth`, VCS token),
  - inspect job logs: `kubectl -n agents logs job/<job-name>`.
- Run exits immediately with usage/entrypoint errors:
  - first remove `spec.workload.image` from the AgentRun and retry so the run uses controller defaults.

## Related References

- [agentrun-creation-guide.md](agentrun-creation-guide.md)
- [crd-yaml-spec.md](crd-yaml-spec.md)
- [designs/crd-agentrun-workflow-loops.md](designs/crd-agentrun-workflow-loops.md)
- [charts/agents/examples/agentrun-workflow-loop-fixed.yaml](../../charts/agents/examples/agentrun-workflow-loop-fixed.yaml)
- [charts/agents/examples/agentrun-workflow-loop-conditional.yaml](../../charts/agents/examples/agentrun-workflow-loop-conditional.yaml)
