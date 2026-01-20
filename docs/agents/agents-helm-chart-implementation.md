# Agents Helm Chart Implementation Design (Next Iteration)

Status: Current (2026-01-19)

## Purpose
Define the next iteration required to make `charts/agents` a fully functional, production‑ready Helm chart that installs CRDs, deploys the Jangar control plane, and supports the full primitive lifecycle (Agent, AgentRun, AgentProvider, ImplementationSpec, ImplementationSource, Memory).

This document is implementation‑grade: it describes *what* needs to exist in the chart, controller, and CI validation to make the chart “complete” and operable in real clusters.

## Goals
- Ship a single Helm chart that installs all Agents CRDs and deploys Jangar in a usable, production‑safe configuration.
- Keep CRDs and controller in sync (schema and behavior).
- Support the full primitive set: Agent, AgentRun, AgentProvider, ImplementationSpec, ImplementationSource, Memory.
- Allow AgentRun to execute as a Kubernetes Job with a provided or default image.
- Support multi‑namespace reconciliation with correct RBAC.
- Ensure artifact hub compliance (README, CRD metadata, examples).

## Non‑Goals
- Bundling an embedded database, backups, ingress, or migrations job in the chart.
- Implementing a separate operator beyond Jangar.
- Fully automating Crossplane → native CRD migration (only provide guidance and tools).

## Current State Summary
- CRDs live under `charts/agents/crds/` and are referenced in `charts/agents/Chart.yaml` annotations.
- Jangar implements the native v1alpha1 types in `services/jangar/api/agents/v1alpha1` and a controller in `services/jangar/src/server/agents-controller.ts`.
- Crossplane XRDs have been retired to `packages/crossplane/deprecated/archived/…` and are not used by Jangar.
- The chart is “minimal” but lacks a documented, end‑to‑end implementation plan for completeness, validation, and migration.

## Design Principles
1) **CRDs are installed by Helm, not at runtime**. Jangar should verify CRD availability and emit actionable errors; it should not create CRDs by default. This aligns with Artifact Hub and Helm best practices.
2) **Controller behavior matches CRD schema**. Any schema change must be reflected in Jangar’s reconciliation logic.
3) **Minimal defaults, explicit overrides**. Only the necessary defaults in `values.yaml`; real deployments pass secrets and images explicitly.
4) **Deterministic upgrades**. CRDs and examples are static YAML, version‑controlled, and validated in CI.

## Scope: What “Fully Functional” Means
A fully functional chart must provide:
- **CRDs** for all primitives, installed via `charts/agents/crds/`.
- **Jangar deployment + service** with documented env configuration.
- **Optional gRPC service port** (ClusterIP only) for `agentctl` access within the cluster.
- **RBAC** that matches what Jangar actually does (jobs/secrets/configmaps/CRDs).
- **Controller configuration** (namespaces, concurrency, resync interval) exposed via values.
- **Examples** for each CRD and implementation source.
- **CI validation** to ensure CRDs and examples are valid and up‑to‑date.
- **Crossplane removal guidance** (no migration required).
- **agentctl** packaged under `services/jangar/**` and backed by Jangar gRPC APIs.

## CRD Lifecycle
### Source of truth
- Go types in `services/jangar/api/agents/v1alpha1/types.go` are the schema source.
- CRDs are generated from these types via `controller-gen`, then committed to `charts/agents/crds/`.

### Requirements
- `subresources.status` on all CRDs.
- `status.conditions[]` and `status.observedGeneration` on all CRDs.
- Keep schemas structural and avoid top-level `x-kubernetes-preserve-unknown-fields: false`; only mark specific subtrees as schemaless.
- Validate max JSON size <= 256KB per CRD.
- Provide `additionalPrinterColumns` for common status fields.

### CRD install behavior
- Helm installs CRDs automatically from `crds/`.
- Jangar should **fail fast** with a clear error if CRDs are missing (e.g., on startup or reconcile loop).
- Optional future enhancement: a `crds.install` flag that toggles Helm’s `--skip-crds` parity in CI or automation (not a runtime controller responsibility).

## Controller Responsibilities (Jangar)
### Core reconcile flow
Jangar is the controller for all primitives and must:
- Reconcile **Agent** and validate provider references.
- Reconcile **AgentProvider** templates and expose invalid spec errors.
- Reconcile **ImplementationSpec** and **ImplementationSource** (webhook-only).
- Reconcile **Memory** and validate referenced Secrets.
- Reconcile **AgentRun** and submit workloads to the configured runtime adapter.

### AgentRun → Job runtime (required)
- If `spec.runtime.type == "job"`, Jangar submits a Kubernetes Job in the target namespace.
- Image resolution priority:
  1. `AgentRun.spec.workload.image`
  2. `JANGAR_AGENT_RUNNER_IMAGE`
  3. `JANGAR_AGENT_IMAGE`
- Job inputs must include a JSON spec (e.g., `run.json`) and optional provider input files.
- Job should be labeled with `agents.proompteng.ai/agent-run` for tracking.

### AgentRun → Workflow runtime (native)
- If `spec.runtime.type == "workflow"`, Jangar orchestrates a step-based workflow using Kubernetes Jobs.
- Define steps in `spec.workflow.steps[]`; each step can provide:
  - `name` (required, unique within the workflow)
  - `parameters` (merged over top-level `spec.parameters`)
  - `implementationSpecRef` or `implementation.inline` (optional overrides)
  - `workload` (optional override for image/resources/volumes)
  - `retries` and `retryBackoffSeconds` (per-step retry policy)
- The controller runs steps sequentially, creating a Job per attempt and advancing only after success.
- Failed steps retry up to `retries`, waiting `retryBackoffSeconds` between attempts.
- Status reporting:
  - `status.workflow.phase` reflects overall workflow state (`Running`, `Succeeded`, `Failed`).
  - `status.workflow.steps[]` tracks per-step phase, attempt count, timestamps, and job reference.
  - `status.phase` mirrors workflow phase for compatibility with existing clients.

### Runtime adapters (expected to exist)
- `workflow` (native step runner), `job`, `temporal`, `custom` adapters with clear error messages when configuration is missing.

### RBAC alignment
Controller behavior requires permissions to:
- Read/write all Agents CRDs and their `status` subresources.
- Create/update/delete Jobs for workflow runtime execution.
- Read Secrets referenced by Agent/Memory/ImplementationSource.
- Create/update ConfigMaps for run inputs.
- Emit Events.

## Helm Chart Structure
### Required files
- `charts/agents/Chart.yaml`
- `charts/agents/values.yaml`
- `charts/agents/values.schema.json`
- `charts/agents/README.md`
- `charts/agents/crds/*.yaml`
- `charts/agents/templates/*.yaml`

### Values schema completeness
`values.schema.json` must cover:
- Image configuration (`repository`, `tag`, `digest`, pull policy, pull secrets).
- Database configuration (URL, secret ref, CA secret).
- Controller settings (`enabled`, `namespaces`, `intervalSeconds`, `concurrency`).
- Agent comms configuration (NATS, optional).
- gRPC service configuration (`grpc.enabled`, `grpc.port`, `grpc.servicePort`).
- RBAC and service account options.
- Resource requests/limits, probes, node selectors, tolerations, security context.

### RBAC modes
Support two modes:
- **Namespaced** (default): Role/RoleBinding in the release namespace. Suitable when `controller.namespaces` is unset or contains only the release namespace.
- **Cluster‑scoped** (optional): ClusterRole/ClusterRoleBinding when `controller.namespaces` includes multiple namespaces or `"*"`.

Design note: Without cluster‑scoped RBAC, multi‑namespace reconciliation will fail.

### CRDs and Examples
- CRDs are static YAML in `crds/`.
- Examples live in `charts/agents/examples/` and are referenced in `Chart.yaml` annotations.
- Examples must be validated in CI against the CRD schemas.

## Migration: Crossplane → Native CRDs
### Why migration is required
Crossplane claim CRDs (`Agent`, `AgentRun`, `AgentProvider`) conflict with native CRDs because they share the same group/kind. Only one set can exist in a cluster.

### Migration strategy (documented, not fully automated)
1) Export Crossplane claims (`Agent`, `AgentRun`, `AgentProvider`) as YAML.
2) Convert claim specs into native CRD specs:
   - Remove Crossplane‑specific fields (`runtime`, `inputs`, `payloads`, etc.).
   - Map provider references and runtime configuration into native schema.
3) Delete Crossplane XRDs and compositions.
4) Install `charts/agents` (native CRDs), then apply converted manifests.

Deliverable: a mapping table and a one‑off conversion script (optional) to ease migration.

## CI Validation (Required)
Add or update CI checks to ensure:
- CRDs are generated from Go types and match `charts/agents/crds/`.
- CRDs pass schema validation and size limits.
- Examples validate against CRDs.
- `helm lint` passes on `charts/agents`.

Reference: `docs/agents/ci-validation-plan.md`

## Acceptance Criteria
A release is considered “fully functional” when:
- Helm install succeeds on a clean cluster (minikube/kind) with CRDs installed.
- Jangar starts and reports healthy readiness/liveness.
- Sample CRDs apply cleanly and appear in `kubectl get`.
- An AgentRun with `runtime.type=job` creates a Job and updates status.
- RBAC is correct for single and multi‑namespace deployments.
- CI validates CRDs and examples.

## Implementation Plan (Next Iteration)
1) **CRD and Schema Lock‑in**
   - Regenerate CRDs from `services/jangar/api/agents/v1alpha1` and commit to `charts/agents/crds/`.
   - Validate schemas and CRD size limits.
2) **RBAC Mode Update**
   - Add a cluster‑scoped RBAC toggle for multi‑namespace reconciliation.
3) **Values Schema Completion**
   - Ensure `values.schema.json` fully reflects `values.yaml`.
4) **Controller Guardrails**
   - Add startup validation for missing CRDs with actionable logs/errors.
5) **CI Validation**
   - Add CI steps for CRD generation diff, kubeconform example validation, and Helm lint.
6) **Migration Guide**
   - Add a dedicated doc for Crossplane → native migration and optionally a converter script.

## Open Questions
- Should the chart support an optional CRD install guard (e.g., pre‑install job) for clusters that skip `crds/`? Current best practice says no, but some GitOps tools may need explicit handling.
- Do we need to package optional “extras” (PDB/HPA/NetworkPolicy) as a separate chart or overlay?

## References
- `docs/agents/agents-helm-chart-design.md`
- `docs/agents/ci-validation-plan.md`
- `docs/agents/crd-yaml-spec.md`
- `docs/agents/rbac-matrix.md`
- `docs/agents/crossplane-migration.md`
- `services/jangar/api/agents/v1alpha1/types.go`
- `charts/agents/README.md`
