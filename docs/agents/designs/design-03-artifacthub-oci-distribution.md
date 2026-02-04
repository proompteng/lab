# Design 03: Artifact Hub OCI Distribution

Status: Draft (2026-02-04)

## Context
We want the Agents Helm chart to be discoverable on Artifact Hub and distributed as an OCI artifact. The chart already targets a minimal control plane (`docs/agents/agents-helm-chart-design.md`) and the market-readiness checklist calls for Artifact Hub metadata and CRD examples (`docs/agents/market-readiness-and-distribution.md`). This design focuses on how we package, publish, and validate the Helm chart in an OCI registry while meeting Artifact Hub requirements.

## Goals
- Publish the `charts/agents` Helm chart to an OCI registry and surface it on Artifact Hub.
- Keep Artifact Hub metadata authoritative and versioned with the chart.
- Ensure releases are reproducible with predictable tags and metadata.
- Provide a release checklist that is automatable in CI.

## Non-goals
- Rewriting the chart contents or CRDs (covered by existing chart and CRD designs).
- Building a new release system; this design only defines expected inputs/outputs.
- Supporting legacy HTTP index repositories as the primary distribution path (we keep it optional).

## Requirements
- `Chart.yaml` includes Artifact Hub annotations (see market readiness doc).
- `charts/agents/artifacthub-pkg.yml` is present and versioned with the chart.
- OCI registry distribution is the default path for releases.
- CRDs and examples referenced by Artifact Hub metadata exist in the repo.
- Releases are signed and accompanied by SBOMs where applicable.

## Proposed Distribution Model
### Registry and naming
- Use a single OCI registry for public distribution (default: GHCR).
- Store charts under a dedicated namespace, for example:
  - `oci://ghcr.io/proompteng/charts`
- Each chart version is pushed as an OCI tag that matches `Chart.yaml` `version`.

### Artifact Hub metadata
- Package-level metadata lives at `charts/agents/artifacthub-pkg.yml`.
- Repository-level metadata is stored in `artifacthub-repo.yml` at repo root and mirrored into
  an OCI metadata artifact when publishing (Artifact Hub OCI repository metadata layer).
- `Chart.yaml` annotations remain the source of truth for CRDs, images, links, and changelog
  snippets.

### Versioning rules
- Chart version must be SemVer and match the OCI tag.
- `appVersion` should reflect the Jangar release tag when applicable.
- Pre-release versions are allowed but should not be marked as stable in release notes.

## Packaging and Publishing Flow
1. Update `Chart.yaml` with new `version` and `appVersion`.
2. Update `charts/agents/artifacthub-pkg.yml` (links, README location, and CRD examples).
3. Ensure `artifacthub-repo.yml` is updated when repository-level metadata changes.
4. Run local validation:
   - `helm lint charts/agents`
   - `helm template charts/agents` (smoke check)
   - CRD size and schema validation (see CRD best practices doc).
5. Package and publish:
   - `helm package charts/agents`
   - `helm push charts/agents-<version>.tgz oci://ghcr.io/proompteng/charts`
6. Publish repository metadata artifact for Artifact Hub OCI (automated in CI).
7. Verify Artifact Hub ingestion and chart rendering.

## CI/Release Expectations
- Release pipeline should gate on:
  - Helm lint and template validation.
  - CRD validation (structural schema + size <= 256KB).
  - Artifact Hub metadata checks (presence of `artifacthub-pkg.yml` and annotations).
- Upload artifacts:
  - Helm OCI chart package.
  - Chart provenance/signature (cosign or helm provenance, depending on pipeline).
  - SBOM for the Jangar image referenced by the chart (if publishing images concurrently).

## Documentation Updates
- Add release instructions to `docs/agents/market-readiness-and-distribution.md` if the
  pipeline changes or new metadata keys are required.
- Provide install examples that use OCI, for example:
  - `helm install agents oci://ghcr.io/proompteng/charts/agents --version <version>`

## Risks and Mitigations
- **Artifact Hub OCI metadata drift**: enforce CI checks that validate `artifacthub-repo.yml` and
  `artifacthub-pkg.yml` are in sync with chart annotations.
- **Registry auth failures**: use scoped tokens for CI and document recovery steps.
- **Version mismatches**: require a single source of truth (Chart.yaml) and block release on mismatch.

## Open Questions
- Which registry namespace is final for public distribution?
- Do we want to generate Helm provenance (`.prov`) in addition to cosign signatures?
- Should we mirror OCI artifacts to a secondary registry for redundancy?
