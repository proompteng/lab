# Torghut Documentation

## Canonical design docs (production-facing)

Start here:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` (current authority map)
- `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md` (Jangar recovery-ledger and consumer-attestation contract)
- `docs/torghut/design-system/v6/59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md` (Torghut lane-balance-sheet and dataset-seat auction contract)
- `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md` (Jangar authority-session and rollout-lease contract)
- `docs/torghut/design-system/v6/58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md` (Torghut profit-cohort and freshness-insurance contract)
- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md` (Jangar authority capsule and readiness-class contract)
- `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md` (Torghut capability lease and lane-local profit clock contract)
- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md` (Jangar admission receipt contract)
- `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md` (Torghut capital lease contract)
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md` (cross-system current contract)
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md` (Torghut-local handoff)
- `docs/torghut/design-system/README.md` (design-system index)
- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md` (implementation completion audit)
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md` (single merged production design)
- `docs/torghut/design-system/v1/overview.md` (system overview)
- `docs/torghut/design-system/v1/agentruns-handoff.md` (handoff pack for AgentRuns)

## Source of truth (as deployed)

- GitOps manifests: `argocd/applications/torghut/**`
  - Live and sim runtime manifests explicitly set `TRADING_JANGAR_QUANT_HEALTH_URL`; do not rely on route-time
    derivation from other Jangar URLs.
- TA replay procedure (concrete steps): `argocd/applications/torghut/README.md`
- Historical simulation operations playbook: `docs/torghut/rollouts/historical-simulation-playbook.md`
- Incident context (example): `docs/incidents/2025-12-20-longhorn-upgrade-kafka-failure.md`

## Service developer docs

- Trading service (FastAPI) local dev: `services/torghut/README.md`
- DB migrations (Alembic): `services/torghut/migrations/README.md`
- Postgres table deep-dive reference: `docs/torghut/postgres-table-reference.md`
- Build/release commands: `docs/torghut/ci-cd.md`
- Whitepaper research workflow trigger runbook: `docs/torghut/whitepaper-research-workflow.md`

## Legacy / supporting docs

The following are older snapshots or focused notes. They may be useful, but should not be treated as the primary design
reference:

- `docs/torghut/system-design.md`
- `docs/torghut/architecture.md`
- `docs/torghut/operations-legacy.md`
- `docs/torghut/topics-and-schemas.md`
