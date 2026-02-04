# Design 02: CRD Lifecycle Upgrades

Status: Current (2026-02-04)

## Purpose
Define the lifecycle and upgrade flow for Agents CRDs, including generation, validation, packaging, rollout,
compatibility rules, and CI enforcement. This design turns the current CRD guidance into a repeatable,
upgrade-safe process for the Helm chart and the Jangar controller.

## Goals
- Ensure CRDs are generated from the Go types where they exist and committed as static YAML.
- Keep CRDs and controller behavior in lock-step during upgrades.
- Prevent breaking upgrades by enforcing compatibility checks and versioning rules.
- Validate examples and schema size limits in CI before release.
- Provide a clear operational playbook for CRD upgrades and rollbacks.

## Non-goals
- Runtime CRD creation by Jangar.
- Crossplane-managed CRDs.
- Multi-version conversion webhooks before a v1beta1 schema exists.

## References
- `docs/agents/agents-helm-chart-implementation.md`
- `docs/agents/crd-best-practices.md`
- `docs/agents/crd-yaml-spec.md`
- `docs/agents/ci-validation-plan.md`

## Current State
- Agents CRDs are stored in `charts/agents/crds/`.
- Agent primitives are defined in `services/jangar/api/agents/v1alpha1` and generated via `controller-gen`.
- Supporting primitives are maintained as static YAML in `charts/agents/crds/`.
- Examples live in `charts/agents/examples/` and are expected to validate against CRDs.
- Helm installs CRDs from `crds/` and Jangar should fail fast if they are missing.

## Design Principles
1) CRDs are installed by Helm, not at runtime.
2) Schema and controller behavior must upgrade together.
3) Single-version CRDs (v1alpha1) remain the default until a conversion webhook is required.
4) All CRDs expose status subresources and conditions.
5) CI validates schema, examples, and size limits on every change.

## Lifecycle Overview
### 1) Authoring
- Update Go types in `services/jangar/api/agents/v1alpha1` for agent primitives.
- Update static YAML in `charts/agents/crds/` for non-agent primitives.
- If behavior changes, update the controller reconciliation logic in Jangar at the same time.

### 2) Generation
- Generate CRDs from Go types via `controller-gen`.
- Commit generated YAML to `charts/agents/crds/`.
- Ensure subresources.status, status.conditions, observedGeneration, and printer columns are present.

### 3) Validation
- Schema checks:
  - Structural schema, no top-level `x-kubernetes-preserve-unknown-fields: false`.
  - Only explicit schemaless subtrees.
  - Required field validation for core primitives (see `crd-yaml-spec.md`).
- Size checks:
  - Enforce 256KB max JSON size per CRD; strip descriptions if needed.
- Example checks:
  - Validate `charts/agents/examples/` against the CRDs.

### 4) Packaging
- Helm chart includes CRDs in `charts/agents/crds/`.
- `Chart.yaml` annotations list CRDs and examples for Artifact Hub.
- README and values schema reflect any new CRD fields or behavior changes.

### 5) Deployment
- Helm installs CRDs before templates; Jangar validates CRD presence on startup.
- Operators apply `helm upgrade` for CRD changes and ensure controller and CRDs are in sync.
- Multi-namespace installs require cluster-scoped RBAC when `controller.namespaces` spans namespaces.

### 6) Observability
- All CRDs expose conditions and observedGeneration so upgrades surface state transitions.
- Additional printer columns for user-facing status fields are required for key types.

## Upgrade Rules
### Backward compatibility
- Avoid removing or renaming fields in v1alpha1.
- Additive changes are preferred (new optional fields, new status fields).
- Tightening validation on existing fields requires a deprecation plan.

### Breaking changes
- If a breaking schema change is required, plan a new version (v1beta1) with a conversion webhook.
- Conversion should be lossless where possible; otherwise document irreversible transformations.
- Keep v1alpha1 served until a full migration guide exists.

### Deprecations
- Announce deprecated fields in the design doc and release notes.
- Keep deprecated fields accepted by schema and ignored by controller for at least one minor release.
- Add controller warnings when deprecated fields are used.

## CI Enforcement
- Regenerate CRDs and compare output to `charts/agents/crds/`.
- Validate schema structure, size limits, and printer columns.
- Validate examples against CRDs.
- Run `helm lint` on `charts/agents`.

## Rollback Strategy
- Helm rollback restores previous CRDs, but controllers must also be rolled back to the matching version.
- Avoid introducing CRD fields that would prevent older controllers from starting.
- Document rollback steps in the release checklist when CRDs change.

## Acceptance Criteria
- CRDs are generated or updated and committed with matching controller changes.
- CI validates schema structure, size limits, and examples.
- Helm install and upgrade succeed on a clean cluster.
- Jangar reports a clear error if CRDs are missing or mismatched.

## Open Questions
- When to introduce a formal v1beta1 timeline and conversion webhook implementation plan.
- Whether to add automated compatibility checks against previous CRD versions.
