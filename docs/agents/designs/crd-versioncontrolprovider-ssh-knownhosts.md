# CRD: VersionControlProvider SSH and known_hosts

Status: Draft (2026-02-07)

## Overview
VersionControlProvider supports SSH configuration (host, user, private key secret, known_hosts ConfigMap ref). This is operationally sensitive: incorrect known_hosts handling can lead to MITM risk, and missing known_hosts can break cloning.

This doc defines a secure-by-default contract for SSH usage.

## Goals
- Make SSH clone behavior secure by default (host key verification).
- Provide a clear configuration and rotation process for known_hosts and keys.

## Non-Goals
- Implementing a new SSH client; rely on standard Git/SSH behavior in runner images.

## Current State
- Chart values include SSH fields under `versionControlProvider.auth.ssh.*`:
  - `charts/agents/values.yaml`
- Example manifests exist:
  - `charts/agents/examples/versioncontrolprovider-github.yaml`
  - `charts/agents/examples/versioncontrolprovider-github-app.yaml`
- CRD exists:
  - `charts/agents/crds/agents.proompteng.ai_versioncontrolproviders.yaml`

## Design
### Contract
- If SSH is used (`cloneProtocol: ssh` or similar):
  - `knownHostsConfigMapRef` MUST be provided (no disabling host key checking by default).
  - Private key Secret must be mounted into runner jobs in a controlled, read-only path.

### Rotation
- known_hosts rotation:
  - Update ConfigMap contents and trigger runner job restart on next run (no long-lived pods).
- key rotation:
  - Update Secret, then re-run jobs.

## Config Mapping
| Config surface | Field | Intended behavior |
|---|---|---|
| VersionControlProvider CR | `spec.auth.ssh.knownHostsConfigMapRef` | Source of known_hosts data for host key verification. |
| VersionControlProvider CR | `spec.auth.ssh.privateKeySecretRef` | Source of SSH private key used by runner jobs. |

## Rollout Plan
1. Document required known_hosts config and provide an example ConfigMap.
2. Add controller-side validation:
   - If SSH auth selected but knownHosts missing, set Ready=False and block execution.

Rollback:
- Switch provider to HTTPS token auth temporarily if SSH path breaks.

## Validation
```bash
kubectl -n agents get versioncontrolprovider -o yaml | rg -n \"ssh:|knownHosts|privateKey\"
kubectl -n agents get configmap | rg known-hosts
```

## Failure Modes and Mitigations
- Missing known_hosts causes clone failure: mitigate by validation + examples.
- Host key changes break cloning: mitigate by documented rotation workflow and staging.
- Disabling host key checking introduces MITM risk: mitigate by forbidding it by default.

## Acceptance Criteria
- SSH usage requires explicit known_hosts configuration.
- Controllers surface misconfigurations as Ready=False with actionable messages.

## References
- OpenSSH `known_hosts` format: https://man.openbsd.org/sshd.8#SSH_KNOWN_HOSTS_FILE_FORMAT
- Git over SSH: https://git-scm.com/book/en/v2/Git-on-the-Server-The-Protocols

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
