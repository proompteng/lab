# CRD: Agent `spec.config` Schema and Validation

Status: Draft (2026-02-06)

## Overview
`Agent.spec.config` is currently an untyped map with `x-kubernetes-preserve-unknown-fields`. This gives flexibility but provides weak validation and poor UX: invalid keys/values are only discovered at runtime.

This doc proposes a production-safe pattern to progressively add validation without breaking existing Agents.

## Goals
- Reduce runtime failures due to invalid Agent config.
- Provide a migration path from untyped config to validated config.

## Non-Goals
- Hard-coding provider-specific schemas into the core Agent CRD immediately.

## Current State
- Go type preserves unknown fields:
  - `services/jangar/api/agents/v1alpha1/types.go` → `AgentSpec.Config map[string]apiextensionsv1.JSON` with pruning preserve unknown fields.
- Generated CRD preserves unknown fields:
  - `charts/agents/crds/agents.proompteng.ai_agents.yaml` → `.spec.versions[].schema.openAPIV3Schema.properties.spec.properties.config`.
- Controller consumes config dynamically (provider-specific):
  - Primary reconcile loop: `services/jangar/src/server/agents-controller.ts` (Agent/AgentRun reconciliation).

## Design
### Phase 1: “Config schema reference” (optional)
Add a field:
```yaml
spec:
  configSchemaRef:
    kind: ConfigMap
    name: agent-config-schema
    key: schema.json
```
Where `schema.json` is a JSON Schema (draft-07 or Kubernetes-compatible subset).

Controllers validate `spec.config` against the referenced schema when present:
- If validation fails: set `Ready=False` with reason `InvalidConfig` and do not schedule runs.

### Phase 2: Provider-specific typed subfields
Introduce `spec.providerConfig` as a `oneOf` in a future CRD version once schemas stabilize.

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `controller.enabled` / `JANGAR_AGENTS_CONTROLLER_ENABLED` | toggles Agent reconciliation | Validation is only enforced when controllers are running. |
| `controller.namespaces` / `JANGAR_AGENTS_CONTROLLER_NAMESPACES` | scope | Determines where Agent config validation applies. |

## Rollout Plan
1. Implement schema-ref validation as opt-in (no behavior change for existing Agents).
2. Add documentation + examples in `charts/agents/examples/agent-sample.yaml`.
3. Add a canary Agent with a schemaRef in non-prod and validate status behavior.

Rollback:
- Remove `spec.configSchemaRef` from Agents; controller falls back to permissive behavior.

## Validation
Helm/template (ensure CRD includes new field if added):
```bash
helm template agents charts/agents --include-crds | rg -n \"configSchemaRef\"
```

kubectl:
```bash
kubectl -n agents apply -f charts/agents/examples/agent-sample.yaml
kubectl -n agents get agent <name> -o yaml | rg -n \"configSchemaRef|InvalidConfig|conditions\"
```

## Failure Modes and Mitigations
- Schema too strict breaks existing Agents: mitigate by making validation opt-in via schemaRef.
- Schema unavailable (missing ConfigMap/Secret): mitigate by setting `Ready=False` with clear reason and message.

## Acceptance Criteria
- When a schemaRef is provided, invalid configs are rejected before scheduling runs.
- Existing Agents without schemaRef continue to work unchanged.

## References
- Kubernetes CRD validation: https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Go API types: `services/jangar/api/agents/v1alpha1/types.go`
- CRD generation entrypoint: `services/jangar/api/agents/generate.go`
- Generated CRDs shipped with the chart: `charts/agents/crds/`
- Examples used by CI/local validation: `charts/agents/examples/`

### Regenerating CRDs

```bash
# Regenerates `charts/agents/crds/*` via controller-gen, then patches/normalizes CRDs.
go generate ./services/jangar/api/agents

# Validates CRDs + examples + rendered chart assumptions.
scripts/agents/validate-agents.sh
```

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`, desired state in Git):
- `agents` Argo CD app (namespace `agents`) installs `charts/agents` via kustomize-helm (release `agents`, chart `version: 0.9.1`, `includeCRDs: true`). See `argocd/applications/agents/kustomization.yaml`.
- Images pinned for `agents`:
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` (from `controlPlane.image.*`).
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809` (from `image.*`).
- Namespaced reconciliation: `controller.namespaces: [agents]`, `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- `jangar` Argo CD app (namespace `jangar`) deploys the product UI/control plane plus default “primitive” CRs (AgentProvider/Agent/Memory/etc). See `argocd/applications/jangar/kustomization.yaml`.
- Jangar image pinned for `jangar` (`deploy/jangar`): `registry.ide-newton.ts.net/lab/jangar:19448656@sha256:15380bb91e2a1bb4e7c59dce041859c117ceb52a873d18c9120727c8e921f25c` (from `argocd/applications/jangar/kustomization.yaml`).

Render the exact YAML Argo CD applies:

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/jangar > /tmp/jangar.rendered.yaml
```

Verify live cluster state (requires kubeconfig):

```bash
mise exec kubectl@1.30.6 -- kubectl get application -n argocd agents
mise exec kubectl@1.30.6 -- kubectl get application -n argocd jangar
mise exec kubectl@1.30.6 -- kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
mise exec kubectl@1.30.6 -- kubectl get deploy -n agents
mise exec kubectl@1.30.6 -- kubectl get deploy -n jangar
mise exec kubectl@1.30.6 -- kubectl get crd | rg 'proompteng\.ai'
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl rollout status -n jangar deploy/jangar
```

### Rollout plan (GitOps)
1. Regenerate CRDs and commit the updated `charts/agents/crds/*`.
2. Update `charts/agents/Chart.yaml` `version:` if the CRD changes are shipped to users; keep GitOps pinned version in sync (`argocd/applications/agents/kustomization.yaml`).
3. Merge to `main`; Argo CD applies updated CRDs (`includeCRDs: true`).

### Validation
- Local:
  - `scripts/agents/validate-agents.sh`
  - `mise exec helm@3.15.4 -- helm lint charts/agents`
- Cluster (requires kubeconfig):
  - `mise exec kubectl@1.30.6 -- kubectl get crd | rg 'agents\.proompteng\.ai|orchestration\.proompteng\.ai|approvals\.proompteng\.ai'`
