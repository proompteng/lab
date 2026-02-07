# CRD: VersionControlProvider SSH and known_hosts

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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

