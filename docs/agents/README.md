# Agents Documentation

Status: Current source map (2026-08-22).

The generic Agents platform is owned by `services/agents` and the `charts/agents` Helm release. Jangar consumes Agents
state for domain-specific workflows; it does not own the generic Agents API, controllers, CRDs, or resource browser.

## Start Here

- Source-read implementation map: `current-source-state.md`
- Safe AgentRun creation: `agentrun-creation-guide.md`
- CRD contract and YAML examples: `crd-yaml-spec.md`
- Helm implementation contract: `agents-helm-chart-implementation.md`
- Installation, upgrade, and incident operations: `runbooks.md`
- Control-plane UI: `control-plane-ui.md`
- Linear intake and source-bound operations: `linear-mcp.md`
- Codex MCP integration: `codex-mcp-agents.md`
- Workflow-loop launches: `agentrun-workflow-loop-launch-guide.md`
- CI validation: `ci-validation-plan.md`

## Authority Order

When sources disagree, use this order:

1. GitOps desired state under `argocd/applications/agents/**`.
2. Helm values, templates, and CRDs under `charts/agents/**`.
3. Runtime code and API contracts under `services/agents/**` and `packages/agent-contracts/**`.
4. Current operational docs in this directory.
5. Retained design contracts under `designs/**`.

Live Argo, Kubernetes, API, and CI readback is required before claiming a rollout or behavior is operational. A dated
design contract never outranks current source or runtime evidence.

## Platform References

- Helm intent and scope: `agents-helm-chart-design.md`
- Agent CLI: `agentctl.md` and `agentctl-*.md`
- Controller behavior: `jangar-controller-design.md` and `leader-election-design.md`
- CRD generation and compatibility: `crd-best-practices.md` and `crd-yaml-spec.md`
- Security: `threat-model.md` and `rbac-matrix.md`
- Production requirements: `production-readiness-design.md`
- Retention: `agent-run-retention-design.md`
- Distribution: `market-readiness-and-distribution.md`
- Version-control providers: `version-control-provider-design.md`

The `designs/**` tree contains only contracts still referenced by code, configuration, tests, current documentation, or
another retained contract. Start with `designs/README.md`; do not treat the directory as an exhaustive current catalog.

## Common Change Flows

### CRDs

- Update API types under `services/agents/api/agents/v1alpha1/**`.
- Regenerate `charts/agents/crds/**` through the owning generator.
- Update `charts/agents/examples/**` when the public contract changes.
- Run `scripts/agents/validate-agents.sh`.

### Helm And GitOps

- Update `charts/agents/values.yaml`, `charts/agents/values.schema.json`, and `charts/agents/templates/**`.
- Update `argocd/applications/agents/values.yaml` when production desired state changes.
- Render and validate with the commands in `designs/handoff-common.md`.

### Runtime Behavior

- Update `services/agents/**` and the matching `packages/agent-contracts/**` types.
- Add focused tests beside the changed implementation.
- Validate the service, chart render, and a representative AgentRun when behavior crosses the Kubernetes boundary.

## Documentation Retention

Keep operational docs concise and source-backed. Delete completed handoffs, rollout journals, retired investigations,
and orphaned design proposals once current source or a maintained runbook carries the useful contract. Git history is
the archive for removed snapshots.
