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
- Historical simulation operations playbook: `docs/torghut/rollouts/historical-simulation-playbook.md`
- Incident context (example): `docs/incidents/2025-12-20-longhorn-upgrade-kafka-failure.md`

## Service developer docs

- Trading service (FastAPI) local dev: `services/torghut/README.md`
- DB migrations (Alembic): `services/torghut/migrations/README.md`
- Postgres table deep-dive reference: `docs/torghut/postgres-table-reference.md`
- Build/release commands: `docs/torghut/ci-cd.md`
- Whitepaper research workflow trigger runbook: `docs/torghut/whitepaper-research-workflow.md`

## Security policy rollout notes

- Security posture changes for Torghut runtime are tracked in `docs/torghut/design-system/v1/security-network-and-rbac.md`.
- Keep the sequence:
  - Capture baseline manifests (`kubectl -n torghut get role,rolebinding,netpol -o yaml`) and health state before sync.
  - Apply GitOps changes in `argocd/applications/torghut/**` and let ArgoCD reconcile.
  - Run post-sync policy checks:
    - `kubectl -n torghut auth can-i get pods --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
    - `kubectl -n torghut auth can-i get pods/log --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
    - `kubectl -n torghut auth can-i create pods --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
    - `kubectl -n torghut auth can-i get namespaces --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
    - `kubectl -n torghut get networkpolicy`
    - `kubectl -n torghut get networkpolicy torghut-ta-egress torghut-ta-ingress-metrics torghut-ws-egress torghut-ws-ingress-metrics torghut-lean-runner-egress torghut-lean-runner-ingress torghut-service-egress torghut-service-ingress torghut-llm-guardrails-exporter-egress torghut-llm-guardrails-exporter-ingress-metrics torghut-clickhouse-guardrails-exporter-egress torghut-clickhouse-guardrails-exporter-ingress-metrics`
    - `kubectl -n torghut rollout status deploy/torghut-ws`
    - `kubectl -n torghut rollout status deploy/torghut-lean-runner`
    - `kubectl -n torghut get pods -l app=torghut-ws`
    - `kubectl -n torghut get pods -l app.kubernetes.io/name=torghut-llm-guardrails-exporter -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
    - `kubectl -n torghut get pods -l app.kubernetes.io/name=torghut-clickhouse-guardrails-exporter -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
  - Record pre/post role and network policy checksums plus this rollout evidence in `${artifactPath}/notes/iteration-<n>.md` (do not commit notes file).
  - If checks fail, rollback to the last-good GitOps revision before widening policies.

## Legacy / supporting docs

The following are older snapshots or focused notes. They may be useful, but should not be treated as the primary design
reference:

- `docs/torghut/system-design.md`
- `docs/torghut/architecture.md`
- `docs/torghut/operations-legacy.md`
- `docs/torghut/topics-and-schemas.md`
