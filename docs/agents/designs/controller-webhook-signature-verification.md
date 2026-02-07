# Webhook Signature Verification: ImplementationSource

Status: Draft (2026-02-07)

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
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Controller code: `services/jangar/src/server/` (see the doc’s **Current State** section for the exact files)
- Chart wiring (env/args/volumes): `charts/agents/templates/deployment-controllers.yaml`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

