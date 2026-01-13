# Jangar Controller Design

Status: Draft (2026-01-13)

## Purpose
Jangar is the control plane and controller for the Agents CRDs. It reconciles AgentRun, ImplementationSpec, ImplementationSource, Memory, and AgentProvider resources and drives execution via runtime adapters.

## Scope
- Watch and reconcile Agents CRDs in configured namespaces.
- Normalize incoming work (GitHub + Linear) into ImplementationSpec objects.
- Resolve Agent + Provider + ImplementationSpec into an execution plan.
- Dispatch runs via runtime adapters and keep status up to date.

Non-goals:
- Managing cluster ingress or database lifecycle.
- Defining provider-specific integration schemas beyond the ImplementationSource abstraction.

## Control Plane Architecture
- Controller manager with leader election.
- Reconcilers per CRD.
- Runtime adapter layer (Argo/Temporal/Job/Custom) behind a common interface.
- Integration layer (GitHub + Linear) that maps external issues to ImplementationSpec.
- Storage abstraction via Memory CRD.

## Reconciliation Overview
### AgentRun
Inputs:
- `spec.agentRef`
- `spec.implementationSpecRef` or `spec.implementation.inline`
- `spec.runtime`
- `spec.workload`
- `spec.parameters`, `spec.secrets`

Steps:
1. Validate required fields and access policy.
2. Fetch Agent and AgentProvider.
3. Resolve ImplementationSpec (or inline payload).
4. Build the agent-runner spec (render templates, resolve secrets).
5. Select runtime adapter from `spec.runtime` and submit workload.
6. Persist runtime identifiers and update status conditions.
7. Reconcile runtime status to completion; emit artifacts if provided.

Status:
- `status.phase`: Pending | Running | Succeeded | Failed | Cancelled
- `status.runtimeRef`: opaque runtime identifier(s)
- `status.startedAt`, `status.finishedAt`
- `status.conditions`: Accepted, InvalidSpec, InProgress, Succeeded, Failed

### ImplementationSpec
Inputs:
- `spec.source` (optional)
- `spec.text` (required for plaintext)

Steps:
1. Validate size limits and schema.
2. Normalize text and summary fields.
3. If sourced, ensure provenance metadata is consistent.

Status:
- `status.syncedAt`
- `status.sourceVersion`
- `status.conditions`: Ready, InvalidSpec, Stale

### ImplementationSource
Inputs:
- Provider config for GitHub or Linear.

Steps:
1. Authenticate and connect (webhook or poll).
2. Normalize external issue payload into ImplementationSpec.
3. Create or update ImplementationSpec objects.
4. Record sync cursor and errors in status.

Status:
- `status.lastSyncedAt`
- `status.cursor`
- `status.conditions`: Ready, Syncing, Error

### Memory
Inputs:
- `spec.type`
- `spec.connection.secretRef`

Steps:
1. Validate secret reference exists.
2. Record capabilities and connection health.

Status:
- `status.conditions`: Ready, InvalidSpec, Unreachable

## Runtime Adapter Interface
Runtime adapters implement a common contract:
- `Submit(runSpec) -> runtimeRef`
- `GetStatus(runtimeRef) -> phase, timestamps, artifacts`
- `Cancel(runtimeRef) -> void`

Adapters should be idempotent and tolerate retries.

## Agent Provider Rendering
AgentProvider defines how to invoke `/usr/local/bin/agent-runner`:
- Render `argsTemplate` and `envTemplate` against resolved AgentRun + ImplementationSpec data.
- Materialize `inputFiles` into the runtime workspace.
- Collect `outputArtifacts` paths.

## Validation and Schema Constraints
- Use OpenAPI schema for required fields and types.
- Mark flexible dictionaries with `x-kubernetes-preserve-unknown-fields` or `additionalProperties`.
- Enforce size limits on ImplementationSpec text to avoid etcd/API size errors.

## Concurrency and Safety
- Leader election to prevent duplicate reconciliation.
- Finalizers on AgentRun to ensure runtime cleanup.
- Reconcile is idempotent; retries do not duplicate runs.
- Use per-run de-duplication keys (e.g., `metadata.uid`).

## Observability
- Structured logs with `agentRun.uid` and `implementationSpec.uid`.
- Metrics: reconcile duration, submit latency, success/failure counts by runtime/provider.
- Kubernetes Events for submit/start/finish/failure.

## Configuration
- Namespace allowlist for watch scope.
- Integration settings for GitHub + Linear.
- Runtime adapter configuration (per-adapter credentials/endpoints).
- Memory backend selection policy (default + overrides).

## Security
- Service account with least privilege for CRDs and runtime submission.
- Secret access constrained via AgentRun allowlist.
- No plaintext credentials in CRDs; use Secret references.

## Failure Modes
- Runtime submission failure -> AgentRun Failed with reason.
- Integration errors -> ImplementationSource Error with retry backoff.
- Memory connection failure -> Memory Unreachable and reconcile backoff.

## Open Questions
- Exact schema for `spec.runtime` for each adapter.
- Size limits for ImplementationSpec text.
- Whether AgentRun should be able to override memory selection.
