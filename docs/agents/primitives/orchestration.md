# Orchestration Primitive

## Purpose and ownership

`Orchestration` is a namespaced workflow definition. It stores an ordered/DAG-like set of steps, and an
`OrchestrationRun` records one execution with concrete string parameters. The native Agents orchestration controller
coordinates supported child resources in-cluster. External workflow-engine adapters are not the default contract.

The Agents service owns these CRDs and their controller. Jangar may use the Agents `/v1` API for domain workflows and
UI integration, but the generic orchestration resources and lifecycle are Agents-owned.

## Current source of truth

- Go API types: `services/agents/api/orchestration/v1alpha1/types.go`
- Generated CRDs: `charts/agents/crds/orchestration.proompteng.ai_orchestrations.yaml` and
  `charts/agents/crds/orchestration.proompteng.ai_orchestrationruns.yaml`
- Chart examples: `charts/agents/examples/orchestration-sample.yaml` and
  `charts/agents/examples/orchestrationrun-sample.yaml`
- Native controller: `services/agents/src/server/orchestration-controller.ts`
- HTTP routes: `services/agents/src/routes/v1/orchestrations.ts` and
  `services/agents/src/routes/v1/orchestration-runs.ts`

## `Orchestration`

`Orchestration` is namespaced. `spec.steps` is required and must contain unique names. If `entrypoint` is set, the
controller requires it to name one of those steps. References are objects with a `name`; scalar strings are not the
current CRD shape.

```yaml
apiVersion: orchestration.proompteng.ai/v1alpha1
kind: Orchestration
metadata:
  name: codex-autonomous
  namespace: agents
spec:
  entrypoint: implement
  steps:
    - name: implement
      kind: AgentRun
      agentRef:
        name: codex-agent
      implementationSpecRef:
        name: codex-impl-sample
      with:
        repository: proompteng/lab
        issueNumber: '1966'
      retries: 1
      retryBackoffSeconds: 30
      timeoutSeconds: 3600
    - name: judge
      kind: AgentRun
      dependsOn:
        - implement
      agentRef:
        name: codex-agent
      implementationSpecRef:
        name: codex-impl-sample
      with:
        stage: judge
    - name: gate
      kind: ApprovalGate
      dependsOn:
        - judge
      policyRef: codex-merge-policy
    - name: merge
      kind: ToolRun
      dependsOn:
        - gate
      toolRef:
        name: git-merge
```

### Typed step fields

`OrchestrationStep` declares:

- required `name` and `kind` strings;
- optional `dependsOn[]` step names;
- optional `agentRef`, `toolRef`, and `orchestrationRef`, each `{name}`;
- optional `policyRef` string;
- optional `with` string-to-string parameter overrides;
- optional non-negative `retries`, `retryBackoffSeconds`, and `timeoutSeconds`.

`spec.policies` is an optional preserved JSON map. Its shape is not defined by the Orchestration CRD. Submission-time
policy checks, including an optional budget reference, are supplied to the Agents API request; do not treat arbitrary
`spec.policies` keys as a current cost/approval enforcement schema.

The generated step schema preserves unknown fields because the controller consumes a small number of step-specific
extensions. The current controller reads `implementationSpecRef` or `implementation`, `runtime`, `workload`,
`memoryRef`, `secrets`, `policy`, `vcsRef`, `vcsPolicy`, `goal`, and `ttlSecondsAfterFinished` when submitting an
`AgentRun` step. Those extensions are not fields declared by the Go `OrchestrationStep` type; keep them limited to
fields the controller currently reads and verify that the child AgentRun CRD retains any value you depend on.

## `OrchestrationRun`

`OrchestrationRun` is namespaced and references an Orchestration in the same namespace. `parameters` is a string map;
`deliveryId` is the current CRD field used for request de-duplication and correlation.

```yaml
apiVersion: orchestration.proompteng.ai/v1alpha1
kind: OrchestrationRun
metadata:
  name: codex-autonomous-001
  namespace: agents
spec:
  orchestrationRef:
    name: codex-autonomous
  parameters:
    repository: proompteng/lab
    issueNumber: '1966'
  deliveryId: codex-autonomous-001
```

`OrchestrationRun.status` contains optional `phase`, `runId`, `startedAt`, `finishedAt`, `updatedAt`,
`observedGeneration`, `conditions`, and `stepStatuses`. The status step entries are preserved JSON maps; the native
controller records fields such as step `name`, `kind`, `phase`, `message`, timestamps, `resourceRef`, `attempt`, and
`nextRetryAt`. There is no separate `OrchestrationExecution` resource or `resumeFrom` field in the current CRD.

## Native controller behavior

The native controller currently recognizes these step kinds:

- `AgentRun`: requires an `agentRef` plus an implementation reference or inline implementation, then creates an
  `agents.proompteng.ai/v1alpha1` AgentRun child and follows its phase;
- `ToolRun`: requires `toolRef`, creates a `tools.proompteng.ai/v1alpha1` ToolRun child, and follows its phase;
- `SubOrchestration`: requires `orchestrationRef`, creates an OrchestrationRun child, and follows its phase;
- `ApprovalGate`: requires `policyRef` (or `with.policyRef`) and waits for the referenced ApprovalPolicy status;
- `SignalWait`: waits for a matching SignalDelivery. The controller reads `signalRef` or `deliveryId` from preserved
  step data or `with`; these are controller-consumed extensions, not typed `OrchestrationStep` fields;
- `Checkpoint` and `MemoryOp`: currently transition the step to `Succeeded` in the orchestration controller. They do
  not, by themselves, persist a checkpoint or invoke the Memory HTTP operation API.

Unknown step kinds fail with an unsupported-step status. `dependsOn` gates a step until every named dependency is
`Succeeded`. Step-level `retries`, `retryBackoffSeconds`, and `timeoutSeconds` are used by the native controller;
retries count additional attempts (`retries + 1` maximum attempts).

## API boundary and idempotency

The Agents service exposes:

- `POST /v1/orchestrations` and `GET /v1/orchestrations/$id`;
- `POST /v1/orchestration-runs`, `GET /v1/orchestration-runs`, and `GET /v1/orchestration-runs/$id`;
- typed resource list/read endpoints under `/v1/orchestration-runs/resources`.

`POST /v1/orchestration-runs` requires the `Idempotency-Key` HTTP header. The handler stores that request identity as
the OrchestrationRun `spec.deliveryId`, checks an existing run by delivery ID, and returns it idempotently when found.
This guarantee is specific to the API submission path; it does not make every direct CRD apply idempotent.

## Policy and external adapters

The orchestration submission API can validate approval policies and an optional `policy.budgetRef` before creating the
run. That is admission-time policy validation, not a documented controller guarantee that a running job will be
halted when an arbitrary cost threshold is exceeded.

Temporal workflow/task-queue mapping, provider-specific workflow IDs, partial replay/resume policies, and durable
checkpoint persistence are future extensions. They are not current Orchestration CRD fields or promises of the native
controller.
