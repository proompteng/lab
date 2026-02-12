# 03. ImplementationSpec Catalog

## Objective
Define the canonical ImplementationSpec inventory required to run the full-loop autonomous Torghut pipeline.

## In Scope
- canonical spec names and versions,
- required keys per stage,
- mapping from specs to AgentRuns,
- lifecycle/versioning policy.

## Catalog (Minimum)

### `torghut-v3-research-intake-v1`
Purpose:
- convert hypotheses into structured candidate specs.

Required keys:
- `researchPrompt`
- `universe`
- `featureSchemaVersion`
- `outputPath`

### `torghut-v3-candidate-build-v1`
Purpose:
- implement strategy plugin and tests from approved candidate spec.

Required keys:
- `repository`
- `base`
- `head`
- `candidateSpecPath`
- `strategyCatalogPath`

### `torghut-v3-backtest-robustness-v1`
Purpose:
- run backtests, walk-forward, stress, and produce metrics bundle.

Required keys:
- `datasetSnapshotId`
- `strategyId`
- `strategyVersion`
- `costModelVersion`
- `artifactPath`

### `torghut-v3-gate-evaluation-v1`
Purpose:
- evaluate gate matrix and emit pass/fail report.

Required keys:
- `gateConfigPath`
- `metricsBundlePath`
- `artifactPath`

### `torghut-v3-shadow-paper-run-v1`
Purpose:
- deploy candidate in shadow/paper and collect execution telemetry.

Required keys:
- `torghutNamespace`
- `gitopsPath`
- `strategyConfigPatchPath`
- `evaluationWindow`

### `torghut-v3-live-ramp-v1`
Purpose:
- apply staged live notional/risk changes under approvals.

Required keys:
- `torghutNamespace`
- `gitopsPath`
- `rampStage`
- `confirm`

### `torghut-v3-incident-recovery-v1`
Purpose:
- execute kill switch + rollback + recovery verification.

Required keys:
- `torghutNamespace`
- `incidentId`
- `rollbackTarget`
- `confirm`

### `torghut-v3-audit-pack-v1`
Purpose:
- compile evidence package for promotion or post-incident review.

Required keys:
- `runId`
- `artifactRefs`
- `complianceProfile`
- `outputPath`

## Canonical Template Mapping

| ImplementationSpec | AgentRun template |
| --- | --- |
| `torghut-v3-research-intake-v1` | `torghut-v3-research-intake-sample` |
| `torghut-v3-candidate-build-v1` | `torghut-v3-candidate-build-sample` |
| `torghut-v3-backtest-robustness-v1` | `torghut-v3-backtest-robustness-sample` |
| `torghut-v3-gate-evaluation-v1` | `torghut-v3-gate-eval-sample` |
| `torghut-v3-shadow-paper-run-v1` | `torghut-v3-shadow-paper-sample` |
| `torghut-v3-live-ramp-v1` | `torghut-v3-live-ramp-sample` |
| `torghut-v3-incident-recovery-v1` | `torghut-v3-incident-recovery-sample` |
| `torghut-v3-audit-pack-v1` | `torghut-v3-audit-pack-sample` |

Compatibility note:
- `torghut-v3-audit-evidence-impl-v1` is retained as a temporary alias for one release cycle, while
  `torghut-v3-audit-pack-v1` is canonical for new runs.

## Naming and Versioning Rules
- use `torghut-v3-<lane>-v<major>` naming,
- breaking contract change requires major version bump,
- deprecated specs retained at least one release cycle.

## Agent Implementation Scope (Significant)
Workstream A: manifest generation
- author and validate all ImplementationSpec manifests.

Workstream B: contract testing
- test required-key enforcement and invalid-run failure behavior.

Workstream C: template mapping
- map every spec to one or more AgentRun templates.

Workstream D: operational docs
- keep spec index and usage examples synchronized.

Owned areas:
- `docs/torghut/design-system/v3/full-loop/templates/**`
- `argocd/applications/agents/**` (if storing operational specs there)
- `docs/agents/**`

Minimum deliverables:
- complete spec manifest set,
- contract tests,
- usage examples,
- maintenance/versioning runbook.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-implspec-catalog-ops-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `catalogPath`
- Expected artifacts:
  - ImplementationSpec manifests,
  - contract tests for required keys,
  - documentation index updates.
- Exit criteria:
  - all full-loop stages have versioned specs and templates,
  - all required-key constraints validated in test runs.
