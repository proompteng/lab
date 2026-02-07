# Controller kubectl Version Compatibility

Status: Draft (2026-02-07)
## Overview
Controllers interact with the Kubernetes API by spawning the `kubectl` binary (`primitives-kube.ts` and `kube-watch.ts`). This implicitly makes controller correctness dependent on the `kubectl` version baked into the image. We should document and enforce a compatibility policy.

## Goals
- Define a supported `kubectl` version skew policy for controller images.
- Make it easy to verify which `kubectl` version is running.

## Non-Goals
- Migrating controllers to a full Kubernetes client SDK in this phase.

## Current State
- `kubectl` is invoked directly:
  - `services/jangar/src/server/primitives-kube.ts` calls `spawn('kubectl', ...)`
  - `services/jangar/src/server/kube-watch.ts` calls `spawn('kubectl', ['get', ..., '--watch', ...])`
- Helm chart does not surface or validate the kubectl version.
- Cluster Kubernetes version is not tracked in this repo; GitOps manifests do not pin it.

## Design
### Compatibility policy
- Controller image must include `kubectl` within a supported skew of the cluster (documented per Kubernetes guidance).
- Operationally: bake `kubectl` version into the image build and expose it via:
  - `JANGAR_KUBECTL_VERSION` env var (build-time)
  - or a startup log line running `kubectl version --client --short`

### Chart changes (optional)
- Add `controllers.env.vars.JANGAR_KUBECTL_VERSION` passthrough (documented).

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_KUBECTL_VERSION` | `JANGAR_KUBECTL_VERSION` | Exposes build-time kubectl version for debugging. |

## Rollout Plan
1. Add runtime logging of `kubectl version --client`.
2. Add CI check that controller image build pins a known kubectl version (build pipeline work).

Rollback:
- Disable the logging; keep pinned version in images.

## Validation
```bash
kubectl -n agents exec deploy/agents-controllers -- kubectl version --client --short
kubectl -n agents logs deploy/agents-controllers | rg -n \"kubectl\"
```

## Failure Modes and Mitigations
- kubectl/client-server incompatibility causes subtle failures: mitigate with a documented skew policy and proactive logging.
- Missing kubectl binary in image: mitigate by adding a startup self-check that fails fast with a clear error.

## Acceptance Criteria
- Operators can determine the kubectl client version from logs or exec.
- Controller images follow an explicit kubectl skew policy.

## References
- Kubernetes version skew policy: https://kubernetes.io/releases/version-skew-policy/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
