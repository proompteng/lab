# CRD Best Practices (Workflow Engines)

Status: Current (2026-01-19)

## Sources Mapped
- Workflow engines: generate CRDs from Go types, post-process for size, validate examples.
- Pipeline systems: keep CRDs as YAML, patch schema with controller-gen, enforce size limits, conversion webhook.
- Minimal schemaless CRDs + optional runtime creation (not adopted).

## Adopted Practices for Agents CRDs
### Schema & Generation
- Generate CRDs from Go types with `controller-gen` and publish static YAML into `charts/agents/crds`.
- Keep CRDs structural and avoid top-level `x-kubernetes-preserve-unknown-fields: false`; mark only specific subtrees as schemaless.
- Use `x-kubernetes-preserve-unknown-fields` or `additionalProperties` for:
  - `Agent.spec.config`
  - `AgentRun.spec.parameters`
  - `AgentRun.spec.runtime.config`
  - `ImplementationSpec.spec.text` (string only; keep size bounded)

### Size & Stability
- Enforce max JSON size of 256KB per CRD (Tekton).
- If a CRD grows too large, strip descriptions or provide a minimal variant.
- Avoid embedding massive schemas; keep reusable types shallow.

### Status & UX
- Enable `subresources.status` for all CRDs.
- Use `status.conditions` + `observedGeneration` for reconciliation.
- Add `additionalPrinterColumns` for AgentRun:
  - Succeeded/Reason
  - StartTime/CompletionTime
  - Runtime type

### Validation Strategy
- Use CEL validations for user-facing invariants only.
- Avoid heavy CEL on controller-managed objects.
- Add doc-level contracts where schema is intentionally loose.

### Conversion & Versioning
- Prefer a single version (v1alpha1) while unused.
- If/when v1beta1 arrives, implement conversion webhook (Tekton model).

### CI & Examples
- Validate sample manifests against CRDs in CI.
- Keep examples close to CRDs and updated with each schema change.

## Explicit Non‑adoptions
- Do not create CRDs at runtime from Jangar (Flyte does this, but it conflicts with Helm/Artifact Hub best practice).

## Checklist for CRD Changes
- [ ] Update Go types + controller-gen output.
- [ ] Check CRD JSON size (<= 256KB).
- [ ] Validate examples against CRDs.
- [ ] Update printer columns if user-visible fields change.
- [ ] Review CEL rules for cost and correctness.
