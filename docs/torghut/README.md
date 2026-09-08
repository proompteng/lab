# Torghut Documentation

Use this page as the current operator source map. Retained design contracts provide context, but live decisions must
start from GitOps, runtime code, readiness endpoints, and current runbooks. Repository-wide documentation authority
rules live in `../documentation-authority.md`.

## Current Truth

Trust these surfaces in order:

- Source-read current state: `docs/torghut/current-source-state.md`
- Live GitOps: `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`,
  `argocd/applications/torghut-hyperliquid-feed/**`, and
  `argocd/applications/torghut-hyperliquid-runtime/**`.
- Service code: `services/torghut/app/**`, `services/torghut/scripts/**`, and `services/torghut/tests/**`.
- Runtime status: `GET /readyz`, `GET /trading/status`, `GET /trading/revenue-repair`, and
  `GET /trading/consumer-evidence`.
- Release automation: the Torghut image builders in `.github/workflows/torghut-*-build-push.yaml` publish one
  commit-correlated image set from `main`; `argocd/applications/kargo/warehouses.yaml` creates Freight and
  `argocd/applications/kargo/stages.yaml` promotes it directly to `kargo/torghut`. Argo tracks that branch. There is no
  release PR, manifest updater script, or manual sync in the image release path.

## Current Runbooks

- Profitability architecture, audit, research gates, and implementation handoff:
  `docs/torghut/profitability/README.md`
- Torghut app GitOps and TA replay: `argocd/applications/torghut/README.md`
- Storage write-pressure remediation design: `docs/torghut/storage-write-pressure-remediation-design.md`
- Trading service local development: `services/torghut/README.md`
- Current source-state map: `docs/torghut/current-source-state.md`
- Data-plane recovery for TigerBeetle, options archive, and Hyperliquid readiness:
  `docs/torghut/data-plane-recovery.md`
- DB migrations: `services/torghut/migrations/README.md`
- CI/CD and release commands: `docs/torghut/ci-cd.md`
- Historical simulation operations: `docs/torghut/rollouts/historical-simulation-playbook.md`
- Current write-pressure rollout evidence: `docs/torghut/rollouts/2026-07-14-storage-write-pressure-remediation.md`
- Production readiness proof probes: `docs/torghut/production-readiness-proof-runbook.md`
- Whitepaper issue to Kafka to Torghut to AgentRun workflow: `docs/torghut/whitepaper-research-workflow.md`
- Postgres table reference: `docs/torghut/postgres-table-reference.md`

## Whitepaper Research

The current whitepaper path is service-owned:

`GitHub issue -> Froussard -> Kafka -> Torghut whitepaper worker -> Jangar AgentRun -> Torghut finalize`

The old namespace-local Argo `WorkflowTemplate/torghut-whitepaper-autoresearch-profit-target` has been retired from
GitOps. Do not reintroduce it for new research dispatch.

## Retained Design Contracts

The design-system tree contains historical rationale and implementation contracts still cited by source, tests,
configuration, or maintained docs. It is not the first source for live operations:

- `docs/torghut/design-system/README.md` explains the archive layout.
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md` is the compact production topology baseline.
- `docs/torghut/design-system/v6/index.md` indexes historical proof/capital design contracts. Treat those as context
  until verified against live GitOps, code, and runtime readback.
- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` is retained as a historical
  authority-map snapshot.

When a design file says `Accepted`, `implementation-ready`, or `current`, read that as the status at the time the file
was written unless the file explicitly points to current code, GitOps, runtime APIs, and validation evidence. Current
service behavior wins over dated design text.

One-time rollout journals and superseded plans are removed after their reusable instructions move into a maintained
runbook. Git history remains available for deleted snapshots.

## Legacy And Supporting Notes

These files are useful background only:

- `docs/torghut/system-design.md`
- `docs/torghut/architecture.md`
- `docs/torghut/operations-legacy.md`
- `docs/torghut/topics-and-schemas.md`
