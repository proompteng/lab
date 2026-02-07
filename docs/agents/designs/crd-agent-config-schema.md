# CRD: Agent `spec.config` Schema and Validation

Status: Draft (2026-02-07)
## Overview
`Agent.spec.config` is currently an untyped map with `x-kubernetes-preserve-unknown-fields`. This gives flexibility but provides weak validation and poor UX: invalid keys/values are only discovered at runtime.

This doc proposes a production-safe pattern to progressively add validation without breaking existing Agents.

## Goals
- Reduce runtime failures due to invalid Agent config.
- Provide a migration path from untyped config to validated config.

## Non-Goals
- Hard-coding provider-specific schemas into the core Agent CRD immediately.

## Current State
- Go type preserves unknown fields:
  - `services/jangar/api/agents/v1alpha1/types.go` → `AgentSpec.Config map[string]apiextensionsv1.JSON` with pruning preserve unknown fields.
- Generated CRD preserves unknown fields:
  - `charts/agents/crds/agents.proompteng.ai_agents.yaml` → `.spec.versions[].schema.openAPIV3Schema.properties.spec.properties.config`.
- Controller consumes config dynamically (provider-specific):
  - Primary reconcile loop: `services/jangar/src/server/agents-controller.ts` (Agent/AgentRun reconciliation).

## Design
### Phase 1: “Config schema reference” (optional)
Add a field:
```yaml
spec:
  configSchemaRef:
    kind: ConfigMap
    name: agent-config-schema
    key: schema.json
```
Where `schema.json` is a JSON Schema (draft-07 or Kubernetes-compatible subset).

Controllers validate `spec.config` against the referenced schema when present:
- If validation fails: set `Ready=False` with reason `InvalidConfig` and do not schedule runs.

### Phase 2: Provider-specific typed subfields
Introduce `spec.providerConfig` as a `oneOf` in a future CRD version once schemas stabilize.

## Config Mapping
| Helm value / env var | Effect | Behavior |
|---|---|---|
| `controller.enabled` / `JANGAR_AGENTS_CONTROLLER_ENABLED` | toggles Agent reconciliation | Validation is only enforced when controllers are running. |
| `controller.namespaces` / `JANGAR_AGENTS_CONTROLLER_NAMESPACES` | scope | Determines where Agent config validation applies. |

## Rollout Plan
1. Implement schema-ref validation as opt-in (no behavior change for existing Agents).
2. Add documentation + examples in `charts/agents/examples/agent-sample.yaml`.
3. Add a canary Agent with a schemaRef in non-prod and validate status behavior.

Rollback:
- Remove `spec.configSchemaRef` from Agents; controller falls back to permissive behavior.

## Validation
Helm/template (ensure CRD includes new field if added):
```bash
helm template agents charts/agents --include-crds | rg -n \"configSchemaRef\"
```

kubectl:
```bash
kubectl -n agents apply -f charts/agents/examples/agent-sample.yaml
kubectl -n agents get agent <name> -o yaml | rg -n \"configSchemaRef|InvalidConfig|conditions\"
```

## Failure Modes and Mitigations
- Schema too strict breaks existing Agents: mitigate by making validation opt-in via schemaRef.
- Schema unavailable (missing ConfigMap/Secret): mitigate by setting `Ready=False` with clear reason and message.

## Acceptance Criteria
- When a schemaRef is provided, invalid configs are rejected before scheduling runs.
- Existing Agents without schemaRef continue to work unchanged.

## References
- Kubernetes CRD validation: https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
