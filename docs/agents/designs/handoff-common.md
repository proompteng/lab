# Agents: Shared Handoff Appendix (Repo + Chart + Cluster)

Status: Current (2026-02-07)

This document centralizes the “always the same” operational facts for the Agents stack so individual design docs
can stay focused on their specific topic.

## Source of truth (repo)

- Helm chart (templates, CRDs, defaults): `charts/agents/`
- Chart values + schema:
  - Defaults: `charts/agents/values.yaml`
  - Schema: `charts/agents/values.schema.json`
  - Environment overlays (examples): `charts/agents/values-{dev,kind,local,prod,ci}.yaml`
- GitOps desired state (production install):
  - Argo CD Application: `argocd/applications/agents/application.yaml`
  - Helm via kustomize: `argocd/applications/agents/kustomization.yaml`
  - Values overlay: `argocd/applications/agents/values.yaml`
  - Extra primitives (Agent/Provider/VCP/etc): `argocd/applications/agents/*.yaml`

## Current cluster desired state (GitOps)

As of 2026-02-07 (repo `main`), the repo declares:

- Argo CD app `agents` deploys to namespace `agents`. See `argocd/applications/agents/application.yaml`.
- Install mechanism: kustomize `helmCharts` with `includeCRDs: true` and Helm release name `agents`. See
  `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (from `argocd/applications/agents/values.yaml`):
  - Control plane (Deployment `agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (Deployment `agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Controllers enabled: `controllers.enabled: true`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation (not cluster-scoped): `controller.namespaces: [agents]` and `rbac.clusterScoped: false`.
  See `argocd/applications/agents/values.yaml`.
- Database connection:
  - `database.secretRef.name: jangar-db-app`
  - `database.secretRef.key: uri`
  See `argocd/applications/agents/values.yaml`.
- gRPC is enabled and explicitly managed via both chart values and env vars:
  - `grpc.enabled: true`
  - `env.vars.JANGAR_GRPC_ENABLED: "true"`
  See `argocd/applications/agents/values.yaml`.
- GitHub VersionControlProvider is declared in GitOps as `VersionControlProvider/github`. See
  `argocd/applications/agents/codex-versioncontrolprovider.yaml`.

Note on “live cluster state”: this repo is GitOps-first, so treat `argocd/applications/**` + `charts/agents/**` as
the desired state. Validate live state with the commands in the next section (requires read access to `argocd` and
`agents` namespaces).

## Validation commands (local render)

Render the full desired install (Helm via kustomize, matching Argo CD):

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml
rg -n \"^kind: (Deployment|Service|CustomResourceDefinition)$\" /tmp/agents.yaml | head
```

Validate schema / examples / chart renderability (includes kubeconform and size checks):

```bash
scripts/agents/validate-agents.sh
```

Validate Argo CD manifests (basic structure + kubeconform):

```bash
scripts/argo-lint.sh
scripts/kubeconform.sh argocd
```

If `kubectl` is not installed locally, use:

```bash
mise exec kubectl@1.30.0 -- kubectl version --client
```

## Validation commands (live cluster)

These commands confirm the live cluster matches the GitOps desired state.

```bash
# Argo CD view (requires access to namespace argocd)
kubectl get application -n argocd agents -o yaml | rg -n \"sync|health|revision\"

# Workloads
kubectl get deploy -n agents
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers

# CRDs (cluster-scoped)
kubectl get crd | rg 'proompteng\\.ai'
```

## Rollout discipline (GitOps)

When changing behavior that affects runtime (CRDs, controllers, chart templates, or default values):

1. Update code and chart together:
   - Controllers/runtime: `services/jangar/src/server/**`
   - CRD types: `services/jangar/api/agents/v1alpha1/**` → regenerate CRDs into `charts/agents/crds/`
   - Chart templates/values: `charts/agents/templates/**`, `charts/agents/values*.yaml`, `charts/agents/values.schema.json`
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
3. If new config is needed in prod, update `argocd/applications/agents/values.yaml`.
4. Merge to `main`; Argo CD will reconcile automatically.
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Repo source of truth: `charts/agents/` + `services/jangar/` + `argocd/applications/agents/`

