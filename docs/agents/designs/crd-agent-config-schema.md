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
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
