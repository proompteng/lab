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
