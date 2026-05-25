# Agents Platform Primitives

This directory documents the domain primitives used by the Agents control plane to run long-horizon agent work. The
primitives are provider-decoupled, implemented as native CRDs, and reconciled by the Agents controller with a
pluggable workflow runtime (no vendor coupling in the base chart).

## Scope

These documents describe:

- Agent execution primitives (`Agent`, `AgentRun`, `AgentProvider`, and the `agent-runner` entrypoint)
- Memory primitives (`Memory`, `MemoryStore`, and provider-backed datasets)
- Orchestration primitives (`Orchestration`, `OrchestrationRun`, and composable steps/DAGs)
- Supporting primitives required for long-horizon runs (artifacts, signals, approvals, schedules, budgets)
- Agents’ role as the control plane (policy, lifecycle, and unified API surface)
- Workflow/runtime contracts for vendor-neutral orchestration

## Repository locations

- Native Agents CRDs + chart: `charts/agents/`
- Agents controller + APIs: `services/agents/`
- Jangar domain APIs/consumers: `services/jangar/`
- agentctl CLI (gRPC): `services/agents/agentctl/`
- GitOps delivery (Argo CD apps): `argocd/applications/`

## Control plane

Agents remains the control plane for every primitive documented here. External callers should interact with
Agents APIs; Jangar consumes those APIs for domain-specific surfaces.

The TanStack Start operator UI for listing, inspecting, and creating these primitives is documented in
[`../control-plane-ui.md`](../control-plane-ui.md).

## Documents

- `agent.md`
- `memory.md`
- `orchestration.md`
- `supporting-primitives.md`
- `../control-plane-ui.md`

Jangar-specific primitive consumers remain under `docs/jangar/primitives/`:

- [`control-plane.md`](../../jangar/primitives/control-plane.md)
- [`code-search.md`](../../jangar/primitives/code-search.md)
- [`jangar-implementation.md`](../../jangar/primitives/jangar-implementation.md)
- [`production-validation.md`](../../jangar/primitives/production-validation.md)
- [`agents-control-plane-log-viewer.md`](../../jangar/agents-control-plane-log-viewer.md)
