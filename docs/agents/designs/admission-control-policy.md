# Admission Control Policy for AgentRuns

Status: Current (2026-02-05)

## Purpose
Reject unsafe or invalid AgentRuns before runtime submission by enforcing controller-level policies.

## Current State
- Label policy: `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED`, `..._ALLOWED`, `..._DENIED`.
- Image policy: `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED`, `..._DENIED`.
- Secret policy: `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`.
- Agent-level policy:
  - `Agent.spec.security.allowedSecrets` and `allowedServiceAccounts` gate secrets and service accounts used by
    AgentRuns.
  - Auth secrets configured via `controller.authSecret` must be allowlisted by the Agent.
- Enforcement lives in `services/jangar/src/server/agents-controller.ts` and sets `InvalidSpec` conditions when
  policy checks fail.
- Cluster: the `agents` ArgoCD values do not set admission policy env vars, so the controller currently runs with
  permissive defaults.

## Design
- Validate AgentRun labels, workload images, and requested secrets before creating runtime Jobs.
- Surface policy failures as `InvalidSpec` conditions with clear `reason` values.
- Keep policy configuration centralized in Helm values and rendered into env vars.

## Configuration
`charts/agents/values.yaml` maps to controller env vars:
- `controller.admissionPolicy.labels.required` → `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED`
- `controller.admissionPolicy.labels.allowed` → `JANGAR_AGENTS_CONTROLLER_LABELS_ALLOWED`
- `controller.admissionPolicy.labels.denied` → `JANGAR_AGENTS_CONTROLLER_LABELS_DENIED`
- `controller.admissionPolicy.images.allowed` → `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED`
- `controller.admissionPolicy.images.denied` → `JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED`
- `controller.admissionPolicy.secrets.blocked` → `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`

## Enforcement Behavior
- Label violations return `InvalidSpec` with `MissingRequiredLabels`, `LabelNotAllowed`, or `LabelBlocked`.
- Image violations return `InvalidSpec` with `ImageNotAllowed` or `ImageBlocked`.
- Secret violations return `InvalidSpec` with `SecretNotAllowed` or `SecretBlocked`.

## Related Policy Systems
- Orchestration submissions enforce ApprovalPolicies and Budgets via
  `services/jangar/src/server/primitives-policy.ts` and `orchestration-submit.ts`.
- SecretBindings restrict which Secrets can be referenced by Agents and Orchestrations.

## Validation
- Create an AgentRun with a forbidden label or image and confirm `InvalidSpec` status.
- Create an AgentRun with a disallowed secret and confirm it is blocked.
