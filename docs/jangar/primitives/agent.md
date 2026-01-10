# Agent Primitive

## Purpose

The `Agent` primitive represents a provider-agnostic intent to run an agent workload. It decouples the
user-facing API from any specific runtime (Argo, Temporal, Kubernetes Jobs, etc.) and provides a stable
contract for long-horizon agent execution.

Jangar is the control plane for all `Agent` resources. All creation, update, and deletion flows
must pass through Jangar.

## Grounding in the current codebase

- Workflow submission runtime: `services/facteur/internal/argo/workflow_runner.go`
- Argo client + workflow build: `services/facteur/internal/argo/kube_client.go`
- Orchestration dispatch: `services/facteur/internal/orchestrator/implementation.go`
- Workflow templates (Argo):
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/argo-workflows/codex-research-workflow.yaml`

## CRDs

### Agent (claim)
Namespace-scoped, app-facing. Describes intent and desired runtime.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: Agent
metadata:
  name: codex-implementation
  namespace: jangar
spec:
  providerRef:
    name: codex
  runtime:
    type: argo
    argo:
      workflowTemplate: github-codex-implementation
      namespace: argo-workflows
      serviceAccount: codex-workflow
  inputs:
    repository: proompteng/lab
    issueNumber: 1966
    base: main
    head: codex/issue-1966-demo
  payloads:
    rawEventB64: e30=
    eventBodyB64: e30=
  observability:
    natsEnabled: true
    kafkaCompletions: true
  resources:
    cpu: "2"
    memory: "4Gi"
```

### AgentRun (execution)
Namespace-scoped execution record. One AgentRun maps to one runtime execution.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: codex-implementation-20260105-001
  namespace: jangar
spec:
  agentRef:
    name: codex-implementation
  parameters:
    eventBodyB64: e30=
  deliveryId: 3f6d7b5d-acde-4aa0-9f31-8b4d2c4d3a4e
```

### AgentProvider (CLI adapter)
Defines how to invoke a provider’s CLI without baking provider-specific logic into workflows.

AgentProvider is cluster-scoped at the composite level. The claim (`AgentProvider`) is namespaced
and should be created in a control-plane namespace (e.g. `jangar`) and treated as global.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentProvider
metadata:
  name: codex
  namespace: jangar
spec:
  binary: /usr/local/bin/codex
  argsTemplate:
    - exec
    - --repo
    - "{{inputs.repository}}"
    - --base
    - "{{inputs.base}}"
    - --head
    - "{{inputs.head}}"
  envTemplate:
    WORKFLOW_STAGE: "{{inputs.stage}}"
  inputFiles:
    - path: /workspace/agent/prompt.json
      content: "{{payloads.promptJson}}"
  outputArtifacts:
    - name: implementation-log
      path: /workspace/lab/.codex-implementation.log
```

## Unified entrypoint

### Requirement: `agent-runner`
All runtimes must invoke a single entrypoint binary that applies the `AgentProvider` adapter and executes the
provider CLI. This keeps the platform provider-agnostic.

- Path: `/usr/local/bin/agent-runner`
- Inputs: JSON spec from file or env
- Output: standard status + artifacts

### Runtime image requirements
The unified entrypoint must exist in every runtime image used for agent execution.

- Codex runtime image must include:
  - `/usr/local/bin/agent-runner`
  - `/usr/local/bin/codex`
- Jangar runtime image must include:
  - `/usr/local/bin/agent-runner`
  - provider CLI binaries for any in-cluster agent execution it coordinates

## Provider decoupling rules

- `Agent` and `AgentRun` expose provider-agnostic fields only.
- Provider-specific fields live under `spec.runtime.<provider>` or `spec.provider.<provider>`.
- Crossplane compositions bind the runtime provider at reconciliation time.

## Runtime mapping (Argo)

- `Agent` references an Argo `WorkflowTemplate` by name.
- `AgentRun` composes into an Argo `Workflow` with parameters mapped from `AgentRun.spec.parameters`.

## Status contract

`AgentRun.status` must include:

- `phase`: Pending | Running | Succeeded | Failed | Cancelled
- `workflowName`, `workflowUID` (if provider is Argo)
- `submittedAt`, `finishedAt`
- `artifactKeys` and any runtime metadata

## Observability

- Enforce `WORKFLOW_*` and `AGENT_*` env vars for traceability.
- Use existing NATS + Kafka patterns:
  - NATS agent comms: `docs/nats-argo-agent-communications.md`
  - Kafka workflow completion: `apps/froussard/scripts/codex-run-complete-kafka.ts`

## Security

- Default service account remains `codex-workflow` for Argo executions.
- Privileged workloads must be gated with explicit policy (see `supporting-primitives.md`).
