# Jangar Control-Plane CRD CEL Compatibility for AgentRun Parameters

Status: Draft (2026-03-04)

## Current State

- The `AgentRun` CRD defines a CEL rule that disallows `workflow.step.parameters.prompt` and top-level `spec.parameters.prompt`.
- The existing rule used `has(self.parameters, 'prompt')`, which is rejected by Kubernetes CEL validation in our CI chart installation path.
- This rejection appears during CRD validation in the `agents-ci` pipeline and blocks chart application.

## Problem

- The control-plane chart and generated schema artifacts can become inconsistent with the CEL dialect accepted by the runtime Kubernetes API server.
- Invalid CEL expressions in `x-kubernetes-validations` fail admission when the CRD is applied, which is a release-blocking issue regardless of runtime controller behavior.

## Design Goals

- Preserve the existing validation intent: do not allow legacy `prompt` usage in `spec.parameters` or `workflow.parameters`.
- Keep the CRD and schema rule sets compatible with supported Kubernetes CEL syntax.
- Avoid any runtime or behavioral changes to controller reconciliation.

## Alternatives Considered

- Option A: remove both `parameters.prompt` CEL validations.
  - Pros: immediate compatibility with all CEL parsers.
  - Cons: loses protection against invalid `prompt` usage and increases risk of runtime validation drift.
- Option B: retain intent and switch to presence checks on the map key (`has(self.parameters.prompt)`) (selected).
  - Pros: preserves validation intent and aligns with Kubernetes CEL macro support.
  - Cons: requires manual propagation to every schema/CRD artifact that carries the same rule.
- Option C: move the constraint out of CRD CEL into admission webhook or controller-side validation.
  - Pros: more custom error semantics and easier complex logic.
  - Cons: introduces new control-plane surface, new failure mode, and additional rollout scope.

## Decision

- Choose Option B: replace invalid two-argument `has` usage with map-key presence checks in both chart CRD and all generated schema mirrors:
  - `!has(self.parameters) || !has(self.parameters.prompt)`
- This keeps behavior stable, blocks bad payloads at the API layer, and removes install-time CRD parsing failures.

## Implementation

- Update `charts/agents/crds/agents.proompteng.ai_agentruns.yaml` rules in:
  - `spec.versions[*].schema.openAPIV3Schema.properties.spec.properties.workflow.items[].properties.parameters.x-kubernetes-validations`
  - `spec.versions[*].schema.openAPIV3Schema.properties.spec.x-kubernetes-validations`
- Keep rule message text unchanged:
  - `spec.parameters.prompt is not allowed; use ImplementationSpec.spec.text`
- Apply the same expression update in schema artifact mirrors under `schemas/custom/` for:
  - `AgentRun-agents.proompteng.ai-v1alpha1.json`
  - `AgentRun-v1alpha1.json`
  - `AgentRun.json`
  - `AgentRun_agents.proompteng.ai_v1alpha1.json`
  - `AgentRun_v1alpha1.json`
  - `agents.proompteng.ai/AgentRun_v1alpha1.json`
  - `agents.proompteng.ai/v1alpha1/AgentRun.json`
  - `agents.proompteng.ai_v1alpha1_AgentRun.json`

## Validation

- CI validation path (`agents-ci`) should proceed past CRD install once the expression parses.
- Manual/targeted checks:
  - `bunx oxfmt --check` on changed files.
  - `bun run --filter @proompteng/jangar lint`.
  - `cd services/jangar && bunx tsc --noEmit --project tsconfig.paths.json`.
  - Existing Jangar control-plane tests for migration and controller/watch behavior.

## Rollout and Risks

- Rollout impact is additive and validation-only; controller runtime is unchanged.
- Main risk is missing propagation across schema mirrors; this is mitigated by updating all current artifacts in the PR.
- If future CRD/schema generation is automated, this class of drift can be reduced by making generation the single source of truth.
