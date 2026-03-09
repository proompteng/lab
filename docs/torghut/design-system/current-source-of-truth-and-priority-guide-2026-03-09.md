# Torghut Design-System Current Source-of-Truth and Priority Guide (2026-03-09)

## Status

- Date: `2026-03-09`
- Purpose: distinguish live source-of-truth docs from historical milestone records and identify the current highest-priority work
- Scope: `docs/torghut/design-system/**`, `docs/torghut/**`, `argocd/applications/torghut/**`, `services/torghut/**`, `services/jangar/**`

## Why this document exists

The Torghut design corpus has accumulated several generations of:

- production topology docs,
- design contracts,
- implementation closeouts,
- incident/root-cause writeups,
- current-state snapshots.

That is useful history, but it creates a real operator problem: dated closeout records can be mistaken for the current
source of truth.

This guide is the current reading order and authority map.

## Use this first

If the question is "what should I trust right now?", start here:

1. deployed/runtime source of truth:
   - `argocd/applications/torghut/**`
   - `services/torghut/README.md`
   - `services/torghut/app/config.py`
2. production-topology source of truth:
   - `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
   - `docs/torghut/design-system/v1/historical-dataset-simulation.md`
   - `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
3. current autonomy/promotion contract source of truth:
   - `docs/torghut/design-system/v6/06-production-rollout-operations-and-governance.md`
   - `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
   - `docs/torghut/design-system/v6/27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
   - `docs/torghut/design-system/v6/28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
   - `docs/torghut/design-system/v6/32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
   - `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
4. options-lane current design source of truth:
   - `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
   - `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`

## Current priority, not historical priority

The current highest-priority work is:

1. authoritative empirical evidence generation for benchmark parity, foundation-router parity, and Janus-Q;
2. recurring prove-and-promote automation that exercises the empirical ledger repeatedly;
3. HMM posterior maturity only after the empirical-authority gap is closed enough to matter operationally.

This means the current next work is not:

- "add a promotion lane";
- "add manifest validation";
- "add empirical-job persistence";
- "add rollout phase manifests";
- "enable one-off historical simulation."

Those slices are already materially in the source tree.

## Read these as historical records, not live contract truth

These docs are still valuable, but mainly as dated rationale, proof, or closeout records:

- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md`
- `docs/torghut/design-system/implementation-audit.md`
- `docs/torghut/design-system/v6/13-production-gap-closure-master-plan-2026-03-03.md`
- `docs/torghut/design-system/v6/15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
- `docs/torghut/design-system/v6/16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
- `docs/torghut/design-system/v6/16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
- `docs/torghut/design-system/v6/17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
- `docs/torghut/design-system/v6/18-trading-readiness-and-rollout-stability-2026-03-04.md`
- `docs/torghut/design-system/v6/29-code-investigated-vnext-architecture-reset-2026-03-06.md`
- `docs/torghut/design-system/v6/30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md`
- `docs/torghut/design-system/v6/31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`

They should inform decisions, but they should not be treated as the single current operator checklist without checking
the current contract docs above.

## Current design docs that remain active

These are still active contract docs rather than historical snapshots:

- `docs/torghut/design-system/v1/historical-dataset-simulation.md`
- `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
- `docs/torghut/design-system/v6/01-beyond-tsmom-system-architecture-and-latency-model.md`
- `docs/torghut/design-system/v6/04-alpha-discovery-and-autonomous-improvement-pipeline.md`
- `docs/torghut/design-system/v6/05-evaluation-benchmark-and-contamination-control-standard.md`
- `docs/torghut/design-system/v6/06-production-rollout-operations-and-governance.md`
- `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
- `docs/torghut/design-system/v6/09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
- `docs/torghut/design-system/v6/32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
- `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
- `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
- `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`

## How to interpret ambiguous docs

When a document mixes design, proof, and closeout material:

1. trust the exact date in the header;
2. check whether it is describing a baseline snapshot, a landed implementation update, or a current recommendation;
3. prefer current source files and current contract docs when there is any conflict;
4. treat milestone language like "completed" or "closeout" as scoped to that dated workstream, not as proof that no
   important work remains.
