# Torghut Documentation

Use this page as the current operator source map. The historical design corpus remains useful context, but live
decisions must start from GitOps, runtime code, readiness endpoints, and current runbooks. Repository-wide
documentation authority rules live in `../documentation-authority.md`.

## Current Truth

Trust these surfaces in order:

- Source-read current state: `docs/torghut/current-source-state.md`
- Live GitOps: `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`,
  `argocd/applications/torghut-hyperliquid-feed/**`, and
  `argocd/applications/torghut-hyperliquid-runtime/**`.
- Service code: `services/torghut/app/**`, `services/torghut/scripts/**`, and `services/torghut/tests/**`.
- Runtime status: `GET /readyz`, `GET /trading/status`, `GET /trading/revenue-repair`, and
  `GET /trading/consumer-evidence`.
- Release automation: `.github/workflows/torghut-release.yml`, `.github/workflows/torghut-ci.yml`,
  `.github/workflows/torghut-deploy-automerge.yml`, and `packages/scripts/src/torghut/update-manifests.ts`.

## Current Runbooks

- Torghut app GitOps and TA replay: `argocd/applications/torghut/README.md`
- Trading service local development: `services/torghut/README.md`
- Current source-state map: `docs/torghut/current-source-state.md`
- DB migrations: `services/torghut/migrations/README.md`
- CI/CD and release commands: `docs/torghut/ci-cd.md`
- Historical simulation operations: `docs/torghut/rollouts/historical-simulation-playbook.md`
- Production readiness proof probes: `docs/torghut/production-readiness-proof-runbook.md`
- Whitepaper issue to Kafka to Torghut to AgentRun workflow: `docs/torghut/whitepaper-research-workflow.md`
- Postgres table reference: `docs/torghut/postgres-table-reference.md`

## Whitepaper Research

The current whitepaper path is service-owned:

`GitHub issue -> Froussard -> Kafka -> Torghut whitepaper worker -> Jangar AgentRun -> Torghut finalize`

The old namespace-local Argo `WorkflowTemplate/torghut-whitepaper-autoresearch-profit-target` has been retired from
GitOps. Do not reintroduce it for new research dispatch.

## Design Corpus

The design-system tree is an archive and background corpus, not the first source for live operations:

- `docs/torghut/design-system/README.md` explains the archive layout.
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md` is the compact production topology baseline.
- `docs/torghut/design-system/v6/index.md` indexes historical proof/capital design contracts. Treat those as context
  until verified against live GitOps, code, and runtime readback.
- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` is retained as a historical
  authority-map snapshot.

When a design file says `Accepted`, `implementation-ready`, or `current`, read that as the status at the time the file
was written unless the file explicitly points to current code, GitOps, runtime APIs, and validation evidence. Current
service behavior wins over dated design text.

## Legacy And Supporting Notes

These files are useful background only:

- `docs/torghut/system-design.md`
- `docs/torghut/architecture.md`
- `docs/torghut/operations-legacy.md`
- `docs/torghut/topics-and-schemas.md`
