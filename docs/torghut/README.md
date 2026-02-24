# Torghut Documentation

## Canonical design docs (production-facing)

Start here:

- `docs/torghut/design-system/README.md` (v1 index)
- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md` (implementation completion audit)
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md` (single merged production design)
- `docs/torghut/design-system/v1/overview.md` (system overview)
- `docs/torghut/design-system/v1/agentruns-handoff.md` (handoff pack for AgentRuns)

## Source of truth (as deployed)

- GitOps manifests: `argocd/applications/torghut/**`
- TA replay procedure (concrete steps): `argocd/applications/torghut/README.md`
- Incident context (example): `docs/incidents/2025-12-20-longhorn-upgrade-kafka-failure.md`

## Service developer docs

- Trading service (FastAPI) local dev: `services/torghut/README.md`
- DB migrations (Alembic): `services/torghut/migrations/README.md`
- Build/release commands: `docs/torghut/ci-cd.md`
- Whitepaper research workflow trigger runbook: `docs/torghut/whitepaper-research-workflow.md`

## Legacy / supporting docs

The following are older snapshots or focused notes. They may be useful, but should not be treated as the primary design
reference:

- `docs/torghut/system-design.md`
- `docs/torghut/architecture.md`
- `docs/torghut/operations-legacy.md`
- `docs/torghut/topics-and-schemas.md`
