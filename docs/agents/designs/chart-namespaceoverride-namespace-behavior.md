# Chart namespaceOverride vs Release Namespace Behavior

Status: Draft (2026-02-06)

## Overview
The chart uses `namespaceOverride` to force all rendered resources into a namespace different from `.Release.Namespace`. This is useful in some GitOps setups but can be hazardous if only part of a release is overridden (e.g. CRDs are cluster-scoped, but Roles/RoleBindings are namespaced).

This doc defines safe usage and guardrails.

## Goals
- Make namespace selection behavior explicit for all chart resources.
- Prevent accidental “split-brain” installs (resources in multiple namespaces).

## Non-Goals
- Supporting multi-namespace installs from a single Helm release.

## Current State
- Value: `charts/agents/values.yaml` → `namespaceOverride`.
- Most templates set `metadata.namespace: {{ .Values.namespaceOverride | default .Release.Namespace }}`:
  - Examples: `charts/agents/templates/deployment.yaml`, `charts/agents/templates/service.yaml`, `charts/agents/templates/rbac.yaml`.
- GitOps typically installs into namespace `agents` and does not set `namespaceOverride` explicitly.

## Design
### Contract
- If `namespaceOverride` is set, it MUST be used consistently across all namespaced resources in the chart.
- Chart MUST fail render if:
  - `namespaceOverride` is set to an empty/whitespace string.
  - `namespaceOverride` is set but `.Release.Namespace` differs and `createNamespace=false` (optional guardrail depending on GitOps practice).

### Documentation requirement
Add a README section:
- “Do not set `namespaceOverride` unless Argo/Helm release namespace is locked.”

## Config Mapping
| Helm value | Rendered namespace | Intended behavior |
|---|---|---|
| `namespaceOverride: \"\"` | `.Release.Namespace` | Normal Helm behavior. |
| `namespaceOverride: agents` | `agents` | Forces all namespaced resources into `agents`. |

## Rollout Plan
1. Document contract and guardrails.
2. Add schema validation (`minLength: 1` when set).
3. Add template validation for common foot-guns.

Rollback:
- Remove `namespaceOverride`; rely on `.Release.Namespace`.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"namespace:\"
kubectl get ns agents
```

## Failure Modes and Mitigations
- Resources created in unexpected namespace: mitigate via render review + guardrail validation.
- Argo CD app sync fails due to namespace mismatch: mitigate by keeping release namespace and override aligned.

## Acceptance Criteria
- Rendered manifests place all namespaced resources in exactly one namespace.
- Invalid override values are rejected at render time.

## References
- Helm template rendering concepts: https://helm.sh/docs/chart_template_guide/

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart behavior: `charts/agents/values.yaml`, `charts/agents/values.schema.json`, `charts/agents/templates/`
- Chart render-time validation: `charts/agents/templates/validation.yaml`
- GitOps desired state:
  - `agents` app (CRDs + controllers + service): `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
  - `jangar` app (product deployment + primitives): `argocd/applications/jangar/kustomization.yaml`
  - Product enablement: `argocd/applicationsets/product.yaml`

### Values → env var mapping (chart)
- Control plane env var merge + rendering: `charts/agents/templates/deployment.yaml`
- Controllers env var merge + rendering: `charts/agents/templates/deployment-controllers.yaml`
- Common pattern: `.Values.env.vars` are merged with component-specific vars (control plane: `.Values.controlPlane.env.vars`, controllers: `.Values.controllers.env.vars`). Component-specific keys win.

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
1. Change chart templates/values/schema in `charts/agents/**`.
2. If the chart `version:` changes, keep `charts/agents/Chart.yaml` and `argocd/applications/agents/kustomization.yaml` in sync.
3. Validate rendering locally (no cluster access required):

```bash
mise exec helm@3.15.4 -- helm lint charts/agents
mise exec helm@3.15.4 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml --include-crds > /tmp/agents.helm.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
scripts/agents/validate-agents.sh
```

4. Merge to `main`; Argo CD reconciles.

### Validation (post-merge)
- Confirm Argo sync + workloads healthy:

```bash
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl logs -n agents deploy/agents-controllers --tail=200
```
