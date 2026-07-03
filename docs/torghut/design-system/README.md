# Torghut Design System

This directory is the historical design corpus for Torghut. It is useful for rationale, contract archaeology, and
implementation background. It is not the primary live operations source of truth.

For current operational decisions, start with `docs/torghut/README.md`, live GitOps, service code, and runtime status
endpoints.

## Current Entry Points

- Production topology baseline: `v1/torghut-autonomous-trading-system.md`
- Historical simulation baseline: `v1/historical-dataset-simulation.md`
- Trading-day simulation automation: `v1/trading-day-simulation-automation.md`
- Design archive index: `v6/index.md`
- Historical authority-map snapshot:
  `current-source-of-truth-and-priority-guide-2026-03-09.md`

## Corpus Layout

- `v1/`: cohesive production topology pass aligned to early production reality.
- `v2/`: research and profitability blueprint; may drift from production.
- `v3/`: flexible quant strategy engine and full-loop autonomy handoff.
- `v4/`: quant and LLM profitability expansion pack.
- `v5/`: strategy build pack and per-paper technique synthesis.
- `v6/`: historical intraday autonomy, proof, capital authority, and Jangar/Torghut contract archive. The March 2026 options-lane series in `v6/33` through `v6/37` is rationale/archaeology, not current cluster health or trading authority.

## Operator Rule

Before treating any dated design file as current truth, verify it against:

- `argocd/applications/torghut/**`
- `services/torghut/**`
- `GET /readyz`
- `GET /trading/status`
- `GET /trading/revenue-repair`
- relevant Argo application and Kubernetes object state

## Historical Audits

- `implementation-status-matrix-2026-02-21.md`
- `implementation-audit.md`
