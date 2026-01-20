# Supporting Primitives for Long-Horizon Agents

This document enumerates the additional primitives required to run long-horizon agent workflows safely
and portably. These are platform-level contracts managed by Jangar.

## 1) Artifact

**Purpose:** durable storage for logs, patches, datasets, model outputs.

- Claim: `Artifact`
- Execution: `ArtifactRef` embedded in AgentRun/OrchestrationRun status
- Provider-agnostic (S3, GCS, MinIO, local)

Key fields:

- `spec.storageRef`
- `spec.lifecycle.ttlDays`
- `status.uri`, `status.checksum`

## 2) Signal

**Purpose:** external event + coordination signal.

- Claim: `Signal` (definitions)
- `SignalDelivery` (events)

Used for:

- external approvals
- human-in-the-loop checkpoints
- system callbacks from webhooks

## 3) ApprovalPolicy

**Purpose:** gate and enforce compliance rules.

- Supports manual approvals, automated checks, and policy exceptions
- Used by Orchestration steps (ApprovalGate)

## 4) Schedule

**Purpose:** time-based triggers for AgentRuns and OrchestrationRuns.

- `Schedule` defines cron, timezone, and target resource
- Native implementation uses Kubernetes `CronJob` to create AgentRun/OrchestrationRun instances (no vendor workflows)
- `targetRef.kind` must reference an existing `AgentRun` or `OrchestrationRun` template in the cluster

## 5) Budget

**Purpose:** cost and resource ceilings for long-horizon workloads.

- `Budget` defines CPU, GPU, token, and dollar limits
- Jangar enforces policy and halts runs when exceeded

## 6) Tool

**Purpose:** standardized interface for non-agent commands or platform actions.

- `Tool` declares interface and required inputs/outputs
- `ToolRun` is the execution record
- Used for `git merge`, `deploy`, `validate`, `scan`, etc.

## 7) SecretBinding

**Purpose:** centralized access control for secrets and external credentials.

- Bindings explicitly list allowed secret names for each Agent/Orchestration
- Prevents direct access by runtimes without Jangar approval

## 8) Workspace

**Purpose:** persistent or ephemeral workspaces for multi-step runs.

- `Workspace` defines storage class, size, and lifecycle
- Orchestration steps can mount a shared workspace
- Native implementation provisions PVCs and reflects PVC status in Workspace status

## Common design rules

- Each primitive is provider-agnostic and resolved by Jangar via provider refs.
- Status fields must be consistent across providers.
- Every primitive emits audit events for traceability.
