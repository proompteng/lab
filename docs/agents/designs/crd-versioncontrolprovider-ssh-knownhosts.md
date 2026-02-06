# CRD: VersionControlProvider SSH and known_hosts

Status: Draft (2026-02-06)

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
