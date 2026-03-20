# Torghut Design-System Current Source-of-Truth and Priority Guide (updated 2026-03-20)

## Status

- Date: `2026-03-20`
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
   - `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
   - `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
   - `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
   - `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
   - `docs/torghut/design-system/v6/44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
   - `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
   - `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
   - `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
   - `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
   - `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
   - `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
   - `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
   - `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
   - `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
   - `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
   - `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
   - `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
   - `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
   - `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
   - `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
   - `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
   - `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
   - `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
   - `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`

4. options-lane current design source of truth:
   - `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
   - `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`

## Current priority, not historical priority

The current highest-priority work is:

1. replace route-local promotion truth with compiled admission receipts and rollout shadow in
   `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`;
2. collapse swarm freeze, stage failure, rollout health, and downstream freshness into one admission artifact through
   `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`;
3. bind every Jangar consumer to typed capability receipts and digest parity in
   `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`;
4. separate serving readiness from promotion authority through durable capsules and readiness classes in
   `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`;
5. replace ephemeral live-capital answers with capital leases and profit-trial firebreaks in
   `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`;
6. allocate and revoke live capital through sleeve-scoped lease receipts and falsification events in
   `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`;
7. settle Torghut hypothesis capital through lane capability leases and typed Jangar endpoint contracts in
   `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`;
8. replace URL-derived authority with typed capability leases and lane-local profit clocks in
   `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`;
9. make unknown or contradictory rollout evidence veto-capable through witness mirrors and promotion covenants in
   `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`;
10. make non-observe capital depend on a single cross-plane profit certificate plus lane-scoped options auth/bootstrap
    isolation in
    `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`;
11. replace whole-swarm failure coupling with execution cells and collaboration failover in
    `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`;
12. make rollout truth depend on rollout-epoch acknowledgement and segment circuit breakers in
    `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`;
13. force submission parity and options bootstrap escrow through the Torghut plan contract in
    `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`;
14. force capital-stage decisions through the hypothesis capital governor, promotion-certificate, and data-quorum
    contract in `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`;
15. make admission truth durable with dependency provenance, consumer acknowledgement, and replayable collaboration in
    `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`;
16. extend that control plane with the segment-authority-graph and promotion-certificate fail-safe in
    `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`;
17. make non-shadow capital depend on expiring profit reservations, schema fitness, and simulation slot ownership in
    `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`;
18. wire Torghut scheduler and status through the segment-firebreak handoff in
    `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`;
19. make sleeve-level capital, deallocation, and evidence decay explicit in
    `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`;
20. keep producer-authored freshness and proof bundles active by continuing the ledger direction defined in
    `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`;
21. isolate control-plane failure domains with rollout-safe gates in
    `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`;
22. retain hypothesis-specific profitability guardrails from
    `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`,
    but make them subordinate to fresh data quorum, immutable evidence bundles, and lease revocation;
23. execute the merged control-plane/profitability program with the March 15-16 base, the March 19 authority stack,
    and the March 20 witness-quorum, admission-receipt, fact-receipt, binding-contract, profit-certificate,
    capital-lease, falsification-ledger, settlement-exchange, authority-capsule, and profit-clock contracts layered
    on top.

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
- `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- `docs/torghut/design-system/v6/44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
- `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
- `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
- `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`

## How to interpret ambiguous docs

When a document mixes design, proof, and closeout material:

1. trust the exact date in the header;
2. check whether it is describing a baseline snapshot, a landed implementation update, or a current recommendation;
3. prefer current source files and current contract docs when there is any conflict;
4. treat milestone language like "completed" or "closeout" as scoped to that dated workstream, not as proof that no
   important work remains.
