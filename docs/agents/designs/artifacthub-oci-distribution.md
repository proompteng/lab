# Artifact Hub OCI Distribution

Status: Current (2026-02-05)

## Purpose
Define how the Agents Helm chart is packaged, published as an OCI artifact, and surfaced on Artifact Hub.

## Current State

- Chart metadata: `charts/agents/Chart.yaml` includes Artifact Hub annotations and CRD listings.
- Package metadata: `charts/agents/artifacthub-pkg.yml` is versioned alongside the chart.
- Repository metadata: `artifacthub-repo.yml` exists at repo root.
- CI publishing: `.github/workflows/agents-sync.yml` filters `charts/agents` into the `proompteng/charts` repo,
  packages the chart, and pushes it to `oci://ghcr.io/proompteng/charts`.
- Manual publishing: `packages/scripts/src/agents/publish-chart.ts` packages and pushes the chart, verifying that
  `artifacthub-pkg.yml` and `Chart.yaml` versions match.
- Cluster: not applicable; this is a packaging and distribution workflow.

## Distribution Model

- Registry: GHCR (`oci://ghcr.io/proompteng/charts`).
- Chart tag: must match `Chart.yaml` `version`.
- `artifacthub-pkg.yml` version must match `Chart.yaml`.
- `appVersion` should align with the Jangar image tag in `charts/agents/values.yaml` or the release artifact.

## Release Flow

- Bump `Chart.yaml` `version` and `appVersion`.
- Update `charts/agents/artifacthub-pkg.yml` version and metadata.
- Validate locally:
  - `helm lint charts/agents`
  - `scripts/agents/validate-agents.sh`
- Merge to `main` to trigger `.github/workflows/agents-sync.yml`, or run
  `packages/scripts/src/agents/publish-chart.ts` manually.

## Artifact Hub Requirements

- `Chart.yaml` annotations list CRDs, images, and docs.
- `artifacthub-pkg.yml` includes version, sign-off, and links.
- Example CRDs referenced in annotations exist in `charts/agents/examples`.

## Verification

- `helm show chart oci://ghcr.io/proompteng/charts/agents --version <version>` renders the chart metadata.
- Artifact Hub displays the chart and CRD examples without warnings.

## Risks and Mitigations

- Version drift: `publish-chart.ts` and CI enforce version parity between `Chart.yaml` and `artifacthub-pkg.yml`.
- Registry auth failures: use scoped tokens (`AGENTS_SPLIT_TOKEN`) in CI.
- Split-repo drift: CI always re-splits from `main` using `git filter-repo`.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Validation

- Exercise the primary flow and confirm expected status, logs, or metrics.
- Confirm no regression in existing workflows, CI checks, or chart rendering.
