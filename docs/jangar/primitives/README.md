# Jangar Platform Primitives

This directory documents the domain primitives used by the Jangar control plane to run long-horizon agent work. The
primitives are designed to be provider-decoupled and compatible with Crossplane configuration packages, while
integrating with the existing Argo workflow runtime in this repository.

## Scope

These documents describe:

- Agent execution primitives (`Agent`, `AgentRun`, `AgentProvider`, and the `agent-runner` entrypoint)
- Memory primitives (`Memory`, `MemoryStore`, and provider-backed datasets)
- Orchestration primitives (`Orchestration`, `OrchestrationRun`, and composable steps/DAGs)
- Supporting primitives required for long-horizon runs (artifacts, signals, approvals, schedules, budgets)
- CI + packaging requirements for OCI-compliant Crossplane configuration packages
- Jangar’s role as the control plane (policy, lifecycle, and unified API surface)

## Repository locations

- Crossplane configuration packages: `packages/crossplane/`
- GitOps delivery (Argo CD apps): `argocd/applications/`
- Argo workflow templates: `argocd/applications/argo-workflows/`, `argocd/applications/froussard/`
- Facteur orchestration runtime: `services/facteur/internal/argo/`, `services/facteur/internal/orchestrator/`
- Codex workflows: `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`

## Control plane

Jangar remains the control plane for every primitive documented here. All external callers must interact with
Jangar APIs; Jangar creates and manages the underlying CRDs and reconciles status for user-facing consumers.

## Current platform services (Argo CD apps)

Relevant live services in the current GitOps manifests include:

- `crossplane`
- `argo-workflows`
- `nats`
- `kafka`
- `temporal`
- `jangar`
- `facteur`
- `froussard`

## Documents

- `agent.md`
- `agent-implementation.md`
- `memory.md`
- `memory-implementation.md`
- `orchestration.md`
- `orchestration-implementation.md`
- `supporting-primitives.md`
- `control-plane.md`
- `ci-and-packaging.md`
- `jangar-implementation.md`
- `ci-workflows.md`
