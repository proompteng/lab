# Chart Config Checksum Rollouts

Status: Draft (2026-02-06)

## Overview
Kubernetes does not automatically restart pods when referenced Secrets/ConfigMaps change (especially when referenced via env vars). In GitOps environments, this frequently leads to “updated Secret, pods still using old value” incidents.

This doc proposes checksum annotations to trigger Deployment rollouts when selected config inputs change.

## Goals
- Provide an opt-in mechanism to restart control plane/controllers when key Secrets/ConfigMaps change.
- Make the behavior explicit and easy to validate in Helm renders.

## Non-Goals
- Automatically restarting on all Secrets/ConfigMaps in the namespace.

## Current State
- Chart references:
  - DB URL Secret: `charts/agents/templates/deployment.yaml` and `deployment-controllers.yaml`
  - `envFromSecretRefs` / `envFromConfigMapRefs`: same templates
- No checksum annotations exist in pod templates.

## Design
### Proposed values
Add:
- `rolloutChecksums.enabled` (default `false`)
- `rolloutChecksums.secrets: []`
- `rolloutChecksums.configMaps: []`

When enabled, annotate pod templates with:
- `checksum/secret/<name>: <sha256>`
- `checksum/configmap/<name>: <sha256>`

### Implementation detail
- Hash the rendered Secret/ConfigMap data when defined in-chart, and the name only (or `lookup`) when managed externally.
  - In GitOps, `lookup` behavior varies; prefer explicit operator-provided checksums when needed.

## Config Mapping
| Helm value | Rendered annotation | Intended behavior |
|---|---|---|
| `rolloutChecksums.enabled=true` | `checksum/*` annotations | Any change triggers a Deployment rollout. |
| `rolloutChecksums.secrets=[\"agents-github-token-env\"]` | `checksum/secret/agents-github-token-env` | Restart when the referenced Secret changes. |

## Rollout Plan
1. Add feature behind `rolloutChecksums.enabled=false`.
2. Enable in non-prod with one Secret (e.g. GitHub token) to validate.
3. Enable in prod after validating rollout behavior and avoiding excessive restarts.

Rollback:
- Disable the flag; annotation removal stops checksum-triggered rollouts.

## Validation
```bash
helm template agents charts/agents | rg -n \"checksum/\"
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.metadata.annotations}'; echo
```

## Failure Modes and Mitigations
- Too many checksum sources cause frequent rollouts: mitigate with explicit allowlist and opt-in.
- Checksum cannot be computed for external Secrets: mitigate by allowing user-provided checksum values.

## Acceptance Criteria
- Enabling the feature causes a deterministic rollout on config changes.
- Operators can scope restarts to a small list of critical Secrets/ConfigMaps.

## References
- Kubernetes ConfigMaps/Secrets update behavior: https://kubernetes.io/docs/concepts/configuration/configmap/

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
