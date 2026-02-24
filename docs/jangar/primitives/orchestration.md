# Orchestration Primitive

## Purpose

The Orchestration primitive represents a composable workflow definition and execution that coordinates
multiple steps (agent runs, tool invocations, memory operations) over long horizons. It is provider-agnostic
and implemented by the Jangar native workflow runtime by default, with optional adapters for external
workflow engines.

Jangar is the control plane for orchestration resources.

## Grounding in the current platform

- Native runtime: `services/jangar/src/server/orchestration-controller.ts`
- Agent execution runtime: `services/jangar/src/server/agents-controller.ts`

## CRDs

### Orchestration (definition)

Defines the DAG, steps, and policies.

```yaml
apiVersion: orchestration.proompteng.ai/v1alpha1
kind: Orchestration
metadata:
  name: codex-autonomous
  namespace: jangar
spec:
  entrypoint: main
  steps:
    - name: implement
      kind: AgentRun
      agentRef: codex-implementation
      with:
        repository: proompteng/lab
        issueNumber: '1966'
    - name: judge
      kind: AgentRun
      dependsOn: [implement]
      agentRef: codex-judge
    - name: gate
      kind: ApprovalGate
      dependsOn: [judge]
      policyRef: codex-merge-policy
    - name: merge
      kind: ToolRun
      dependsOn: [gate]
      toolRef: git-merge
    - name: deploy
      kind: ToolRun
      dependsOn: [merge]
      toolRef: argocd-deploy
  policies:
    retries:
      limit: 2
    timeouts:
      totalSeconds: 7200
```

### OrchestrationRun (execution)

Executes a definition with concrete parameters and records status.

```yaml
apiVersion: orchestration.proompteng.ai/v1alpha1
kind: OrchestrationRun
metadata:
  name: codex-autonomous-20260105-001
  namespace: jangar
spec:
  orchestrationRef:
    name: codex-autonomous
  parameters:
    repository: proompteng/lab
    issueNumber: '1966'
```

## Step model

Each step is an atomic unit with:

- `kind`: AgentRun | ToolRun | MemoryOp | ApprovalGate | SignalWait | SubOrchestration | Checkpoint
- `dependsOn`: array of step names
- `with`: parameter overrides (string values; encode structured JSON if needed)
- `outputs`: named outputs for downstream steps

## Provider decoupling rules

- `Orchestration` is runtime-agnostic.
- Provider binding happens at reconciliation via the Jangar runtime router.
- Provider-specific overrides may be introduced later.

## Native runtime (default)

- `Orchestration` defines the DAG and step contracts.
- `OrchestrationRun` coordinates step execution through Jangar.
- Steps create `AgentRun` and `ToolRun` resources and track their status.

## Optional adapters (future)

- `Orchestration` → Workflow Type and Task Queue
- `steps` map to Activities or Child Workflows
- `OrchestrationRun` stores Temporal Workflow ID + Run ID

## State + status

`OrchestrationRun.status` must include:

- `phase`: Pending | Running | Succeeded | Failed | Cancelled
- `runId`: provider-specific run identifier
- `startedAt`, `finishedAt`
- `stepStatuses`: array of step states + timestamps

## Long-horizon features

- `SignalWait` step to block until external events arrive
- `Checkpoint` step to persist intermediate state to Memory
- `ResumeFrom` policy for partial replay
- `Budget` integration to halt if cost exceeds threshold

## Idempotency

- OrchestrationRun is idempotent via `deliveryId` (if present)
- Jangar owns retries and de-duplication for orchestration creation
