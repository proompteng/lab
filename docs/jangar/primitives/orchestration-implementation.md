# Orchestration Primitive (Implementation-Grade Spec)

This document specifies Orchestration primitives with a composable DAG model and provider mappings.
The design is runtime-agnostic, with Argo as the first implementation.

## 1) CRDs

### 1.1 XOrchestration

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xorchestrations.orchestration.proompteng.ai
spec:
  group: orchestration.proompteng.ai
  names:
    kind: XOrchestration
    plural: xorchestrations
  claimNames:
    kind: Orchestration
    plural: orchestrations
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [entrypoint, steps]
              properties:
                entrypoint: { type: string }
                steps:
                  type: array
                  items:
                    type: object
                    required: [name, kind]
                    properties:
                      name: { type: string }
                      kind:
                        type: string
                        enum: [AgentRun, ToolRun, MemoryOp, ApprovalGate, SignalWait, SubOrchestration, Checkpoint]
                      dependsOn:
                        type: array
                        items: { type: string }
                      agentRef:
                        type: string
                      toolRef:
                        type: string
                      memoryRef:
                        type: string
                      policyRef:
                        type: string
                      with:
                        type: object
                        additionalProperties: { type: string }
                policies:
                  type: object
                  properties:
                    retries:
                      type: object
                      properties:
                        limit: { type: integer, default: 0 }
                    timeouts:
                      type: object
                      properties:
                        totalSeconds: { type: integer }
            status:
              type: object
              properties:
                conditions:
                  type: array
                  items:
                    type: object
                    required: [type, status]
                    properties:
                      type: { type: string }
                      status: { type: string }
                      reason: { type: string }
                      message: { type: string }
```

### 1.2 OrchestrationRun

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xorchestrationruns.orchestration.proompteng.ai
spec:
  group: orchestration.proompteng.ai
  names:
    kind: XOrchestrationRun
    plural: xorchestrationruns
  claimNames:
    kind: OrchestrationRun
    plural: orchestrationruns
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [orchestrationRef]
              properties:
                orchestrationRef:
                  type: object
                  required: [name]
                  properties:
                    name: { type: string }
                parameters:
                  type: object
                  additionalProperties: { type: string }
                deliveryId: { type: string }
            status:
              type: object
              properties:
                phase: { type: string }
                runId: { type: string }
                startedAt: { type: string }
                finishedAt: { type: string }
                stepStatuses:
                  type: array
                  items:
                    type: object
                    properties:
                      name: { type: string }
                      phase: { type: string }
                      startedAt: { type: string }
                      finishedAt: { type: string }
```

## 2) Argo runtime mapping

### 2.1 Orchestration -> WorkflowTemplate

- `spec.steps` maps to Argo DAG tasks
- `dependsOn` maps to `dependencies`
- `AgentRun` steps map to a template that calls `agent-runner`

### 2.2 OrchestrationRun -> Workflow

- `spec.orchestrationRef` -> `workflowTemplateRef`
- `spec.parameters` -> `arguments.parameters`

## 3) Example Argo DAG task mapping

```yaml
- name: implement
  templateRef:
    name: github-codex-implementation
    template: implement
- name: judge
  dependencies: [implement]
  templateRef:
    name: codex-judge
    template: judge
```

## 4) Step kinds (behavior)

- `AgentRun`: submit agent execution, wait for completion
- `ToolRun`: execute a platform tool (git merge, deploy, etc.)
- `MemoryOp`: read/write memory entries
- `ApprovalGate`: block until manual or policy approval
- `SignalWait`: block until an external signal arrives
- `SubOrchestration`: run another Orchestration
- `Checkpoint`: persist state snapshot to Memory

## 5) Idempotency

`OrchestrationRun.spec.deliveryId` is required for idempotent behavior and
is persisted by Jangar to avoid duplicate dispatch.

## 6) Status mapping

- Argo `Workflow.status.phase` -> `OrchestrationRun.status.phase`
- Argo `Workflow.metadata.name` -> `OrchestrationRun.status.runId`

## 7) Observability

- Ensure each step writes `WORKFLOW_*` and `AGENT_*` env vars
- Publish NATS agent events on every step
