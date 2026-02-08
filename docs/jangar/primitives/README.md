# Jangar Platform Primitives

This directory documents the domain primitives used by the Jangar control plane to run long-horizon agent work. The
primitives are provider-decoupled, implemented as native CRDs, and reconciled by the Jangar controller with a
pluggable workflow runtime (no vendor coupling in the base chart).

## Scope

These documents describe:

- Agent execution primitives (`Agent`, `AgentRun`, `AgentProvider`, and the `agent-runner` entrypoint)
- Memory primitives (`Memory`, `MemoryStore`, and provider-backed datasets)
- Orchestration primitives (`Orchestration`, `OrchestrationRun`, and composable steps/DAGs)
- Supporting primitives required for long-horizon runs (artifacts, signals, approvals, schedules, budgets)
- Jangar’s role as the control plane (policy, lifecycle, and unified API surface)
- Workflow/runtime contracts for vendor-neutral orchestration

## Repository locations

- Native Agents CRDs + chart: `charts/agents/`
- Jangar controller + APIs: `services/jangar/`
- agentctl CLI (gRPC): `services/jangar/agentctl/`
- GitOps delivery (Argo CD apps): `argocd/applications/`

## Control plane

Jangar remains the control plane for every primitive documented here. All external callers must interact with
Jangar APIs; Jangar creates and manages the underlying CRDs and reconciles status for user-facing consumers.

## Documents

- `agent.md`
- `code-search.md`
- `memory.md`
- `orchestration.md`
- `supporting-primitives.md`
- `control-plane.md`
- `jangar-implementation.md`
- `production-validation.md`
- [`agents-control-plane-log-viewer.md`](../agents-control-plane-log-viewer.md)
