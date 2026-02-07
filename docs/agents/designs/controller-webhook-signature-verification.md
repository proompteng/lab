# Webhook Signature Verification: ImplementationSource

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
ImplementationSource webhooks are an ingress boundary. Signature verification is implemented for GitHub (`x-hub-signature(-256)`) and Linear (`linear-signature`). This doc defines the operational contract: how secrets are stored, rotated, and validated, and how failure is surfaced safely.

## Goals
- Ensure webhook signatures are verified whenever webhook ingestion is enabled.
- Provide safe secret rotation without downtime.
- Make failure modes explicit and observable.

## Non-Goals
- Replacing webhook auth with mTLS or OIDC.

## Current State
- Signature verification code:
  - GitHub: `verifyGitHubSignature(...)` in `services/jangar/src/server/implementation-source-webhooks.ts`
  - Linear: `verifyLinearSignature(...)` in the same file
  - Verification selects candidate ImplementationSources and checks secrets: `selectVerifiedSources(...)`
- Secret lookup:
  - Reads secret data via Kubernetes client (kubectl): `getSecretData(...)` in `implementation-source-webhooks.ts` and `services/jangar/src/server/primitives-kube.ts`.
- On invalid signature, responds 401: `implementation-source-webhooks.ts` (e.g. “Invalid webhook signature”).
- Chart does not provide first-class values for webhook signing secrets (they are referenced in CRDs).

## Design
### Contract
- If `ImplementationSource.spec.webhook.enabled=true`:
  - `spec.webhook.secretRef` MUST be set.
  - Requests MUST be rejected with 401 if signature is missing/invalid.
- Secret rotation:
  - Support dual-secret window by allowing multiple secret refs (future CRD enhancement) OR by temporarily accepting both sha1 and sha256 (already supported for GitHub).

### Proposed CRD evolution (optional)
Add to ImplementationSource:
```yaml
spec:
  webhook:
    secretRefs:
      - name: old
        key: token
      - name: new
        key: token
```
and verify against any.

## Config Mapping
| Config surface | Key | Intended behavior |
|---|---|---|
| ImplementationSource CR | `spec.webhook.secretRef` | Points to Secret used for signature verification. |
| ImplementationSource CR | `spec.webhook.enabled` | Enables signature verification and webhook processing. |

## Rollout Plan
1. Document required headers + secret formats for GitHub/Linear.
2. Add validation: if enabled but secretRef missing, set `Ready=False` and emit an error.
3. Implement dual-secret support for rotation if needed.

Rollback:
- Revert to single-secret verification; rotate back to old secret.

## Validation
```bash
kubectl -n agents get implementationsource -o yaml | rg -n \"webhook:|secretRef:\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"Invalid webhook signature|signature\"
```

## Failure Modes and Mitigations
- Missing signature headers cause false rejects: mitigate by documenting provider setup steps and returning a clear 401 message.
- Secret missing blocks ingestion: mitigate via status conditions and clear errors.
- Rotation causes downtime: mitigate with dual-secret support or staggered rotation windows.

## Acceptance Criteria
- Webhooks are rejected unless signatures verify against configured secrets.
- Rotation can be performed with a documented, testable procedure.

## References
- GitHub webhook signature docs: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Linear webhook security docs: https://developers.linear.app/docs/graphql/webhooks

