# Torghut Design System v6

This directory is a historical design archive. It records Torghut architecture, research, proof, capital-authority,
and Jangar integration decisions made during the v6 program. It is not a current operations guide.

For current truth, start with:

- `docs/torghut/README.md`
- `docs/torghut/current-source-state.md`
- `argocd/applications/torghut/**`
- `services/torghut/**`
- live `/readyz`, `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence` responses

## Foundational Contracts

- `01-beyond-tsmom-system-architecture-and-latency-model.md`
- `02-regime-adaptive-expert-router-design.md`
- `03-dspy-llm-decision-layer-over-jangar.md`
- `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
- `05-evaluation-benchmark-and-contamination-control-standard.md`
- `06-production-rollout-operations-and-governance.md`
- `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
- `08-profitability-research-validation-execution-governance-system.md`
- `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
- `10-timesfm-foundation-model-router-parity.md`
- `11-deeplob-bdlob-microstructure-intelligence.md`
- `13-production-gap-closure-master-plan-2026-03-03.md`

These files describe the original v6 program. Their status language is historical unless current source, GitOps, tests,
and runtime evidence independently confirm it.

## Retained Evidence Maps

- `29-completion-matrix-2026-03-07.yaml` is machine-consumed by Torghut completion-trace tests and must remain aligned
  with the runtime matrix.
- `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md` records the program's historical
  disposition and rollout gates.
- `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md` records the historical integrated-system
  design.

## Later Design Records

The remaining numbered files are dated design, repair, proof, and closeout records. They are retained for referenced
contracts and source archaeology, not as a build order or an operations journal. Search the directory by the concrete
domain or contract identifier needed; do not infer current authority from sequence numbers, document status labels, or
the newest filename.

Completed rollout journals, orphaned proposals, and superseded catalogs belong in Git history. Before keeping or
removing an individual record, follow `docs/documentation-authority.md` and verify inbound references from live code,
configuration, tests, or maintained documentation.
