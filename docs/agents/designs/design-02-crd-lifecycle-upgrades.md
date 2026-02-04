# Design 02: CRD Lifecycle Upgrades

Status: Draft (2026-02-04)

## Purpose
Define how Agents CRDs evolve over time, including schema changes, version additions, and safe upgrades
for clusters running Jangar and the Helm chart.

## Goals
- Provide a predictable upgrade path for CRD schema changes.
- Keep Helm installs and upgrades deterministic across environments.
- Ensure Jangar only runs when required CRDs and versions are present.
- Minimize operator downtime and avoid data loss during version transitions.
- Establish CI checks that prevent incompatible CRD changes from landing.

## Non-Goals
- Automated, in-cluster migration jobs for user data.
- Supporting external CRD managers beyond Helm and GitOps.
- Backporting to deprecated API versions after removal.

## Design Principles
1) CRDs are installed by Helm from `charts/agents/crds/` and are the source of truth in clusters.
2) Schema changes are validated in CI before release.
3) Versioned upgrades are explicit and reversible until the final storage version switch.
4) Controllers fail fast if CRDs or versions are missing or incompatible.

## Current Baseline
- Single version for Agents primitives: `v1alpha1`.
- CRDs generated from Go types in `services/jangar/api/agents/v1alpha1` and committed to
  `charts/agents/crds/`.
- Non-agent primitives remain static YAML in `charts/agents/crds/` until Go API packages exist.

## Upgrade Classes
### 1) Schema-only changes (same version)
Allowed when changes are backward compatible for existing stored objects.
Examples:
- Adding optional fields.
- Adding validation that existing objects already satisfy.
- Adding `additionalPrinterColumns` or descriptions.

Prohibited without a new version:
- Removing fields.
- Changing types or requiredness in a way that can invalidate stored objects.
- Tightening validation that could reject existing objects.

### 2) Versioned upgrades (new API version)
Required for incompatible schema changes. Introduce a new version (e.g., `v1beta1`) and a conversion
webhook before switching the storage version.

## Versioning Strategy
### Served and storage versions
- Add the new version as `served: true, storage: false` first.
- Keep the previous version served to maintain compatibility during rollout.
- Only switch `storage: true` to the new version after conversion is validated in production.

### Conversion webhook
- Conversion webhook must be live before any CRD advertises multiple versions.
- Conversion logic lives in Jangar and must round-trip without data loss for supported fields.
- Conversion must preserve unknown fields for schemaless subtrees (`spec.config`, `spec.parameters`,
  `spec.runtime.config`).

### Stored versions migration
- Once `storage` flips to the new version, existing objects must be migrated by Kubernetes via
  storage version conversion. Expect this during writes and background storage migration.
- Jangar must tolerate mixed stored versions during the transition window.

## Helm and GitOps Upgrade Flow
1) Upgrade the Helm chart with new CRDs and the new Jangar image.
2) Jangar starts only if required CRDs and versions are detected; otherwise it fails fast with
   actionable errors.
3) When a new API version is introduced:
   - Deploy Jangar with conversion support first.
   - Ship CRDs with the new version served, old version still served and storage.
   - Validate conversion by applying both versions and ensuring status updates succeed.
4) After validation, release a chart update that flips storage to the new version.

## Compatibility Guardrails
- CRD size limit: JSON <= 256KB per CRD.
- All CRDs include `subresources.status`, `status.conditions[]`, and `status.observedGeneration`.
- Root schema must remain structural; only specific subtrees are schemaless.
- Required fields and validations must match controller behavior.

## Controller Responsibilities
- Preflight on startup: verify CRDs exist, required versions are served, and schema expectations are met.
- Expose clear logs and readiness failure when CRDs are missing or incompatible.
- Use `observedGeneration` and conditions to avoid stale status writes during upgrades.

## CI Validation
Required checks for every CRD change:
- Regenerate CRDs and diff against `charts/agents/crds/`.
- Validate CRD size limits.
- Validate examples against CRDs.
- Ensure new versions include conversion webhook wiring before multi-version release.

## Rollback Strategy
- If a rollout fails before flipping storage, revert to the prior chart version and keep the old
  version served.
- If storage has already switched, rollback requires keeping the new version served and restoring
  a compatible controller build. Do not remove the new version until data is migrated back.

## Acceptance Criteria
- A chart upgrade that adds a new version succeeds without data loss.
- Jangar rejects startup when required CRD versions are missing.
- CI blocks incompatible schema changes without a version bump.
- Operators can follow a documented, multi-step process to move storage to the new version.

## Related Docs
- `docs/agents/crd-best-practices.md`
- `docs/agents/crd-yaml-spec.md`
- `docs/agents/agents-helm-chart-implementation.md`
