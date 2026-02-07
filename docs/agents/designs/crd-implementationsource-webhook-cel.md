# CRD: ImplementationSource Webhook CEL Invariants

Status: Draft (2026-02-07)

## Overview
ImplementationSource supports webhook-driven ingestion. Certain fields must be present together (e.g., `webhook.enabled` implies a `secretRef`). Today, some of these invariants are enforced in code, but encoding them in CRD CEL rules provides immediate feedback at apply time.

## Goals
- Encode basic webhook invariants as CRD CEL rules.
- Reduce runtime “misconfigured source” errors.

## Non-Goals
- Encoding provider-specific rules that require external calls.

## Current State
- CRD exists: `charts/agents/crds/agents.proompteng.ai_implementationsources.yaml`.
- Webhook runtime logic: `services/jangar/src/server/implementation-source-webhooks.ts`.
- Signature verification expects a secret when webhook enabled (see `selectVerifiedSources(...)`).

## Design
### Proposed CEL validations
- If `spec.webhook.enabled == true` then `spec.webhook.secretRef.name` and `.key` must be non-empty.
- If provider is GitHub, require that `spec.webhook.events` includes the expected event types (optional).

Example CEL:
```yaml
x-kubernetes-validations:
  - rule: '!(has(self.spec.webhook) && self.spec.webhook.enabled) || (has(self.spec.webhook.secretRef) && self.spec.webhook.secretRef.name != "" && self.spec.webhook.secretRef.key != "")'
    message: "webhook.enabled requires webhook.secretRef.{name,key}"
```

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `controller.enabled` / `JANGAR_AGENTS_CONTROLLER_ENABLED` | toggles reconciliation | CEL rules validate at API server on apply, independent of controller runtime. |

## Rollout Plan
1. Add CEL rules in CRD generation (Go markers) and regenerate `charts/agents/crds`.
2. Canary in non-prod by applying misconfigured ImplementationSources and confirming rejection.

Rollback:
- Revert CRD validation rules (requires CRD management plan).

## Validation
```bash
helm template agents charts/agents --include-crds | rg -n \"implementationsources|x-kubernetes-validations\"
kubectl -n agents apply -f charts/agents/examples/implementationsource-github.yaml
```

## Failure Modes and Mitigations
- Validation is too strict for legacy objects: mitigate by introducing rules only when fields exist, and by staging rollouts.
- Cluster API server older than CEL support level: mitigate by checking Kubernetes version and gating rules accordingly.

## Acceptance Criteria
- Misconfigured webhook-enabled ImplementationSources are rejected at apply time.
- Valid sources continue to work without modification.

## References
- Kubernetes CRD validation rules (CEL): https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation-rules
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- CRDs packaged by chart: `charts/agents/crds/`
- Go types (when generated): `services/jangar/api/agents/v1alpha1/`
- Validation pipeline: `scripts/agents/validate-agents.sh`

