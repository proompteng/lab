# Agents: Shared Handoff Appendix (Repo + Chart + Cluster)

Status: Current (2026-02-07)

This document centralizes the “always the same” operational facts for the Agents stack so individual design docs
can stay focused on their specific topic.

## Production / GitOps (source of truth)
These design docs are written against the repo’s GitOps desired state. Treat the following as the primary sources of
truth and validate the live cluster against them.

Primary sources:
- Helm chart: `charts/agents/`
- GitOps desired state: `argocd/applications/agents/`

Related apps (often involved in end-to-end runs):
- `argocd/applications/jangar/`
- `argocd/applications/froussard/`

## Repo Source Of Truth (Quick Map)
Chart:
- Chart templates/CRDs/defaults: `charts/agents/`
- Values + schema:
  - Defaults: `charts/agents/values.yaml`
  - Schema: `charts/agents/values.schema.json`
  - Example overlays: `charts/agents/values-{dev,kind,local,prod,ci}.yaml`

GitOps desired state (production install):
- Argo CD Application: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml`
- Values overlay: `argocd/applications/agents/values.yaml`
- Primitives (Agent/Provider/VCP/system prompt/etc): `argocd/applications/agents/*.yaml`

## How To Find Current Pins (Chart Version, Images, Namespaces)
Avoid hardcoding live cluster details into design docs. When you need to know the current pins, read them from the
repo:

```bash
# Chart version + install mechanism
sed -n '1,200p' argocd/applications/agents/kustomization.yaml

# Images / runner image / key env vars
sed -n '1,260p' argocd/applications/agents/values.yaml
rg -n \"^(image|controlPlane\\.image|runner\\.image):\" argocd/applications/agents/values.yaml
```

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

## Validation commands (live cluster)

These commands confirm the live cluster matches the GitOps desired state.

```bash
# Kubernetes API server version
kubectl version --short
kubectl get --raw /version

# Argo CD view (requires access to namespace argocd)
kubectl get application -n argocd agents -o yaml | rg -n \"sync|health|revision\"

# Workloads
kubectl get deploy -n agents
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers

# CRDs (cluster-scoped)
kubectl get crd | rg 'proompteng\\.ai'
```

## Operational Contracts (Agents Runtime)

Git + GitHub side effects:
- In production AgentRuns, the agent workload is responsible for `git commit`, `git push`, and PR creation.
- The runner/controller must not commit/push/create/update PRs as a fallback.

PR metadata handoff:
- The runner can create placeholder metadata files (for artifact collection).
- The agent can write PR number/URL to `PR_NUMBER_PATH` / `PR_URL_PATH`; the runner reads and forwards them and must
  not clobber agent-written values.

Job retries:
- Default Kubernetes Job retries for AgentRun workloads should be disabled (`backoffLimit: 0`) to avoid repeating
  side effects. Allow opt-in overrides via `spec.runtime.config.backoffLimit` or `JANGAR_AGENT_RUNNER_BACKOFF_LIMIT`.

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
