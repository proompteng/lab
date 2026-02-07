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

See `docs/agents/designs/handoff-common.md`.
