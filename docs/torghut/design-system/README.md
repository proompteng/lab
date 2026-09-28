# Torghut Design System

This directory contains retained Torghut design contracts. It is useful for rationale, contract archaeology, and
implementation background, but it is not the primary live operations source of truth.

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

- `v1/`: historical cohesive production topology pass aligned to early production reality.
- `v2/`: historical research and profitability blueprint; may drift from production.
- `v3/`: historical flexible quant strategy engine and full-loop autonomy handoff.
- `v4/`: historical quant and LLM profitability expansion pack.
- `v5/`: historical strategy build pack and per-paper technique synthesis.
- `v6/`: historical intraday autonomy, proof, capital authority, and Jangar/Torghut contract archive. The March 2026 options-lane series in `v6/33` through `v6/37` is rationale/archaeology, not current cluster health or trading authority.

## Authority And Retention

A file inside this directory may explain why a design existed, but it is not current production truth without live
code, GitOps, and runtime validation. Keep files only while a live external consumer or maintained current document
needs them, or when they preserve clearly unique historical rationale/provenance. Archive-to-archive references,
generated catalogs, and obsolete indexes do not justify retention. Completed rollout journals and orphaned proposals
belong in Git history. Use `../../documentation-authority.md` and `../README.md` before treating any dated design as
actionable.

## Operator Rule

Before treating any dated design file as current truth, verify it against:

- `argocd/applications/torghut/**`
- `services/torghut/**`
- `GET /readyz`
- `GET /trading/status`
- `GET /trading/revenue-repair`
- relevant Argo application and Kubernetes object state

## Archive Boundary

The retired 2026-07-04 implementation audit and status matrix were generated snapshots, not maintained production
authority. The retained files below are individually useful contracts or historical rationale; this archive is not
enumerated by a generated catalog. For current behavior, use `docs/torghut/README.md`, live GitOps, service code, and
runtime readback.
