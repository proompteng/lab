# Agent Primitive (Implementation-Grade Spec)

**Deprecated notice (2026-01-16):** This document describes the Crossplane-based Agents XRDs. The
native Agents CRDs installed by `charts/agents` are now the supported implementation. Use the
native CRDs for new deployments and consult `docs/agents/crossplane-migration.md` for migration.

This document is implementation-grade. It defines the exact CRD schema, runtime contract, and Crossplane
composition needed to deploy the Agent primitive in production.

## 1) CRDs (XRD + Claim)

### 1.1 XAgent (composite)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xagents.agents.proompteng.ai
spec:
  group: agents.proompteng.ai
  names:
    kind: XAgent
    plural: xagents
  claimNames:
    kind: Agent
    plural: agents
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - providerRef
                - runtime
              properties:
                providerRef:
                  type: object
                  required: [name]
                  properties:
                    name:
                      type: string
                runtime:
                  type: object
                  required: [type]
                  properties:
                    type:
                      type: string
                      enum: [argo, temporal, job, custom]
                    argo:
                      type: object
                      properties:
                        workflowTemplate:
                          type: string
                        namespace:
                          type: string
                          default: argo-workflows
                        serviceAccount:
                          type: string
                          default: codex-workflow
                    temporal:
                      type: object
                      properties:
                        workflowType:
                          type: string
                        taskQueue:
                          type: string
                    job:
                      type: object
                      properties:
                        image:
                          type: string
                        command:
                          type: array
                          items: { type: string }
                inputs:
                  type: object
                  properties:
                    repository: { type: string }
                    issueNumber: { type: integer }
                    base: { type: string }
                    head: { type: string }
                    stage: { type: string }
                payloads:
                  type: object
                  properties:
                    rawEventB64: { type: string }
                    eventBodyB64: { type: string }
                    promptJson: { type: string }
                resources:
                  type: object
                  properties:
                    cpu: { type: string }
                    memory: { type: string }
                    ephemeral: { type: string }
                env:
                  type: array
                  items:
                    type: object
                    required: [name, value]
                    properties:
                      name: { type: string }
                      value: { type: string }
                observability:
                  type: object
                  properties:
                    natsEnabled: { type: boolean, default: true }
                    kafkaCompletions: { type: boolean, default: true }
                    grafEnabled: { type: boolean, default: false }
                security:
                  type: object
                  properties:
                    allowPrivileged: { type: boolean, default: false }
                    allowedServiceAccounts:
                      type: array
                      items: { type: string }
                    allowedSecrets:
                      type: array
                      items: { type: string }
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

### 1.2 AgentRun (composite)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xagentruns.agents.proompteng.ai
spec:
  group: agents.proompteng.ai
  names:
    kind: XAgentRun
    plural: xagentruns
  claimNames:
    kind: AgentRun
    plural: agentruns
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - agentRef
              properties:
                agentRef:
                  type: object
                  required: [name]
                  properties:
                    name: { type: string }
                parameters:
                  type: object
                  additionalProperties: { type: string }
                deliveryId:
                  type: string
                runtimeOverrides:
                  type: object
                  properties:
                    argo:
                      type: object
                      properties:
                        namespace: { type: string }
                        serviceAccount: { type: string }
                retryPolicy:
                  type: object
                  properties:
                    limit: { type: integer, default: 0 }
                timeoutSeconds:
                  type: integer
            status:
              type: object
              properties:
                phase: { type: string }
                workflowName: { type: string }
                workflowUID: { type: string }
                submittedAt: { type: string }
                finishedAt: { type: string }
                artifactKeys:
                  type: array
                  items: { type: string }
```

### 1.3 AgentProvider (cluster-scoped)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xagentproviders.agents.proompteng.ai
spec:
  scope: Cluster
  group: agents.proompteng.ai
  names:
    kind: XAgentProvider
    plural: xagentproviders
  claimNames:
    kind: AgentProvider
    plural: agentproviders
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required: [binary]
              properties:
                binary: { type: string }
                argsTemplate:
                  type: array
                  items: { type: string }
                envTemplate:
                  type: object
                  additionalProperties: { type: string }
                inputFiles:
                  type: array
                  items:
                    type: object
                    required: [path, content]
                    properties:
                      path: { type: string }
                      content: { type: string }
                outputArtifacts:
                  type: array
                  items:
                    type: object
                    required: [name, path]
                    properties:
                      name: { type: string }
                      path: { type: string }
```

## 2) Runtime contract: agent-runner

### 2.1 Input JSON schema

`agent-runner` accepts a single JSON spec:

```json
{
  "provider": "codex",
  "inputs": {
    "repository": "proompteng/lab",
    "base": "main",
    "head": "codex/issue-1966-demo",
    "stage": "implementation"
  },
  "payloads": {
    "promptJson": "{...}",
    "rawEventB64": "e30=",
    "eventBodyB64": "e30="
  },
  "observability": {
    "natsUrl": "nats://nats.nats.svc:4222",
    "grafBaseUrl": "http://graf.graf.svc.cluster.local"
  },
  "artifacts": {
    "statusPath": "/workspace/.agent/status.json",
    "logPath": "/workspace/.agent/log.txt"
  }
}
```

### 2.2 Execution rules

- Load `AgentProvider` by name.
- Render `argsTemplate`, `envTemplate`, and `inputFiles`.
- Execute `binary` + rendered args.
- Write status JSON on completion with exit code and output artifacts.

### 2.3 Exit status

- Exit code `0`: success
- Non-zero: failure (AgentRun status must map to Failed)

## 3) Argo Composition (provider-kubernetes)

### 3.1 AgentRun -> Workflow (minimal composition)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: agentrun-argo
  labels:
    runtime: argo
spec:
  compositeTypeRef:
    apiVersion: agents.proompteng.ai/v1alpha1
    kind: XAgentRun
  resources:
    - name: workflow
      base:
        apiVersion: argoproj.io/v1alpha1
        kind: Workflow
        metadata:
          namespace: argo-workflows
        spec:
          workflowTemplateRef:
            name: ""
          arguments:
            parameters: []
      patches:
        - fromFieldPath: "spec.runtimeOverrides.argo.namespace"
          toFieldPath: "metadata.namespace"
          policy:
            fromFieldPath: Optional
        - fromFieldPath: "spec.parameters"
          toFieldPath: "spec.arguments.parameters"
          transforms:
            - type: map
              map:
                # Implementation detail: convert map to list of {name,value}
                # Use Composition Function to do map->list conversion.
      connectionDetails:
        - fromConnectionSecretKey: workflowName
```

Implementation note: Use a Composition Function to convert `spec.parameters` map into
`Workflow.spec.arguments.parameters` list.

### 3.2 Status mapping

- `Workflow.status.phase` -> `AgentRun.status.phase`
- `Workflow.metadata.name` -> `AgentRun.status.workflowName`
- `Workflow.metadata.uid` -> `AgentRun.status.workflowUID`
- `Workflow.status.startedAt` -> `AgentRun.status.submittedAt`

## 4) Jangar API

### 4.1 Endpoints

- `POST /v1/agents`
- `POST /v1/agent-runs`
- `GET /v1/agent-runs/{id}`
- `GET /v1/agent-runs?agentId=...`

### 4.2 Idempotency

- `Idempotency-Key` header maps to `AgentRun.spec.deliveryId`.

## 5) Runtime image requirements

- Codex runtime image must include:
  - `/usr/local/bin/agent-runner`
  - `/usr/local/bin/codex`
- Jangar runtime image must include:
  - `/usr/local/bin/agent-runner`
  - provider CLIs used for local execution or tooling

## 6) Required workflow template updates

- Replace direct CLI invocation with `agent-runner` where feasible.
- Preserve existing env vars (WORKFLOW_*, AGENT_*, NATS_*).
