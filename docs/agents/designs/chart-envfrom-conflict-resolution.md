# Chart envFrom Conflict Resolution

Status: Draft (2026-02-07)

## Overview
The Agents chart supports both explicit `env:` entries and bulk import via `envFrom` (Secrets/ConfigMaps). Kubernetes allows both, but precedence can be confusing: explicitly defined `env:` variables take precedence over values from `envFrom`.

This doc defines how the chart should use these mechanisms safely and what operators should expect.

## Goals
- Make `envFrom` behavior predictable for production installs.
- Avoid “silent overrides” of critical configuration.
- Provide guidance for GitOps-managed Secret/ConfigMap injection.

## Non-Goals
- Building a full secret management system (use External Secrets, SOPS, etc.).
- Adding new CRDs for configuration.

## Current State
- Chart templates render `envFrom` if `envFromSecretRefs` or `envFromConfigMapRefs` are non-empty:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- The same templates also render explicit `env:` entries from:
  - `.Values.env.vars` (template-generated list)
  - `.Values.env.secrets`, `.Values.env.config`, `.Values.env.extra`
- Cluster desired state uses `envFromSecretRefs` in `argocd/applications/agents/values.yaml`.

## Design
### Recommended contract
- `envFromSecretRefs` / `envFromConfigMapRefs` are intended for:
  - Provider credentials (non-chart-specific vars).
  - Optional feature toggles that are safe to override.
- Chart-managed “safety” vars MUST always be set via explicit `env:` so they win over `envFrom`.

### Future improvement (chart-level validation)
Add a Helm validation rule (in `charts/agents/templates/validation.yaml`) that:
- Fails the render if `envFrom*` is used to set any reserved keys (a documented denylist), unless an explicit override value is also provided under `.Values.env.vars` or component-local `*.env.vars`.

## Config Mapping
| Helm value | Rendered pod spec | Behavior |
|---|---|---|
| `envFromSecretRefs: [\"agents-github-token-env\"]` | `envFrom.secretRef` | Imports all keys as env vars; may be overridden by explicit `env:`. |
| `envFromConfigMapRefs: [\"agents-flags\"]` | `envFrom.configMapRef` | Imports all keys as env vars; may be overridden by explicit `env:`. |
| `env.extra[{name,value}]` | explicit `env:` | Highest precedence; good for chart-managed defaults. |
| `env.secrets[{name,secretName,key}]` | explicit `env:` via `secretKeyRef` | Highest precedence; used for specific, named secrets. |
| `env.config[{name,configMapName,key}]` | explicit `env:` via `configMapKeyRef` | Highest precedence; used for specific, named config keys. |

## Rollout Plan
1. Document reserved keys + precedence in `charts/agents/README.md`.
2. Add render-time validation (denylist) behind a new value `validation.reservedEnvKeysEnforced` default `false`.
3. Enable enforcement in `values-prod.yaml` after a canary.

Rollback:
- Disable enforcement flag and re-sync Argo CD.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"envFrom:|secretRef:|configMapRef:\"
```

Live:
```bash
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].envFrom}'
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].env}'
```

## Failure Modes and Mitigations
- Secret injects a key that shadows a chart-managed key: mitigate with reserved-key validation + docs.
- Operators expect `envFrom` to override `env:`: mitigate by making precedence explicit in design docs and chart README.
- Large Secrets exceed env var limits: mitigate by using explicit `env.secrets` for the minimal set of keys.

## Acceptance Criteria
- A reserved-key denylist exists and is enforced in production.
- Operators can safely add `envFrom*` without destabilizing chart defaults.

## References
- Kubernetes: define env vars and `envFrom`: https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/

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
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
