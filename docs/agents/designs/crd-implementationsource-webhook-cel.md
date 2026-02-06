# CRD: ImplementationSource Webhook CEL Invariants

Status: Draft (2026-02-06)

## Overview
ImplementationSource supports webhook-driven ingestion. Certain fields must be present together (e.g., `webhook.enabled` implies a `secretRef`). Today, some of these invariants are enforced in code, but encoding them in CRD CEL rules provides immediate feedback at apply time.

## Goals
- Encode basic webhook invariants as CRD CEL rules.
- Reduce runtime “misconfigured source” errors.

## Non-Goals
- Encoding provider-specific rules that require external calls.

## Current State
- CRD exists: `charts/agents/crds/agents.proompteng.ai_implementationsources.yaml`.
- Webhook runtime logic: `services/jangar/src/server/implementation-source-webhooks.ts`.
- Signature verification expects a secret when webhook enabled (see `selectVerifiedSources(...)`).

## Design
### Proposed CEL validations
- If `spec.webhook.enabled == true` then `spec.webhook.secretRef.name` and `.key` must be non-empty.
- If provider is GitHub, require that `spec.webhook.events` includes the expected event types (optional).

Example CEL:
```yaml
x-kubernetes-validations:
  - rule: '!(has(self.spec.webhook) && self.spec.webhook.enabled) || (has(self.spec.webhook.secretRef) && self.spec.webhook.secretRef.name != "" && self.spec.webhook.secretRef.key != "")'
    message: "webhook.enabled requires webhook.secretRef.{name,key}"
```

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `controller.enabled` / `JANGAR_AGENTS_CONTROLLER_ENABLED` | toggles reconciliation | CEL rules validate at API server on apply, independent of controller runtime. |

## Rollout Plan
1. Add CEL rules in CRD generation (Go markers) and regenerate `charts/agents/crds`.
2. Canary in non-prod by applying misconfigured ImplementationSources and confirming rejection.

Rollback:
- Revert CRD validation rules (requires CRD management plan).

## Validation
```bash
helm template agents charts/agents --include-crds | rg -n \"implementationsources|x-kubernetes-validations\"
kubectl -n agents apply -f charts/agents/examples/implementationsource-github.yaml
```

## Failure Modes and Mitigations
- Validation is too strict for legacy objects: mitigate by introducing rules only when fields exist, and by staging rollouts.
- Cluster API server older than CEL support level: mitigate by checking Kubernetes version and gating rules accordingly.

## Acceptance Criteria
- Misconfigured webhook-enabled ImplementationSources are rejected at apply time.
- Valid sources continue to work without modification.

## References
- Kubernetes CRD validation rules (CEL): https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation-rules

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
