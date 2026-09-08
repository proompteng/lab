# Torghut Design-System Current Source-of-Truth and Priority Guide (updated 2026-05-13)

## Status

- Date: `2026-05-13`
- Purpose: distinguish live source-of-truth docs from historical milestone records and identify the current highest-priority work
- Scope: `docs/torghut/design-system/**`, `docs/torghut/**`, `argocd/applications/torghut/**`, `services/torghut/**`, `services/jangar/**`
- Archive note: this file is a historical authority-map snapshot. For current operations, start with
  `docs/torghut/README.md`, live GitOps, service code, and runtime readback.


Current authority note: this file is retained as a historical map. It must not be used as the current priority list
without validating against `docs/torghut/README.md`, live GitOps, service code, runtime endpoints, and CI.

2026-07-04 source-read audit note: each existing design document in this corpus now carries a
`Source Implementation Audit (2026-07-04)` block. Use that block, plus current source/GitOps, before relying on any
older priority ordering or handoff claim in this file.

## Why this document exists

The Torghut design corpus has accumulated several generations of:

- production topology docs,
- design contracts,
- implementation closeouts,
- incident/root-cause writeups,
- current-state snapshots.

That is useful history, but it creates a real operator problem: dated closeout records can be mistaken for the current
source of truth.

This guide records the reading order and authority map as of the snapshot above. It is retained for history; current
truth now lives in the compact Torghut documentation index plus live GitOps/runtime state.

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
   - `docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`
   - `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
   - `docs/torghut/design-system/v6/192-torghut-freshness-carry-and-repair-proof-slo-2026-05-13.md`
   - `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`
   - `docs/torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
   - `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
   - `docs/agents/designs/184-jangar-reliability-settlement-ledger-and-rollout-slo-escrow-2026-05-12.md`
   - `docs/torghut/design-system/v6/188-torghut-profit-freshness-frontier-and-zero-notional-repair-market-2026-05-12.md`
   - `docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`
   - `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`
   - `docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
   - `docs/torghut/design-system/v6/152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`
   - `docs/agents/designs/147-jangar-hypothesis-scoped-capital-adjudication-ledger-2026-05-07.md`
   - `docs/torghut/design-system/v6/151-torghut-hypothesis-scoped-capital-adjudication-and-profit-gates-2026-05-07.md`
   - `docs/torghut/design-system/v6/137-torghut-renewal-bond-profit-escrow-and-evidence-carry-2026-05-07.md`
   - `docs/agents/designs/133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
   - `docs/torghut/design-system/v6/136-torghut-stage-coherent-profit-escrow-and-proof-age-arbitrage-2026-05-07.md`
   - `docs/agents/designs/132-jangar-stage-freshness-escrow-and-capital-authority-reclocking-2026-05-07.md`
   - `docs/agents/designs/115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
   - `docs/torghut/design-system/v6/119-torghut-evidence-renewal-batches-and-capital-quiescence-gates-2026-05-06.md`
   - `docs/agents/designs/114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
   - `docs/torghut/design-system/v6/118-torghut-proof-route-parity-and-options-informed-repair-scheduler-2026-05-06.md`
   - `docs/agents/designs/97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`
   - `docs/torghut/design-system/v6/101-torghut-proof-debt-retirement-and-shadow-capital-handoff-2026-05-06.md`
   - `docs/agents/designs/89-jangar-brownout-adoption-ladder-and-quant-capital-contract-2026-05-05.md`
   - `docs/torghut/design-system/v6/93-torghut-evidence-priced-hypothesis-market-and-capital-ladder-2026-05-05.md`
   - `docs/agents/designs/88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
   - `docs/torghut/design-system/v6/92-torghut-proof-cost-market-and-options-catalog-firebreak-2026-05-05.md`
   - `docs/agents/designs/83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
   - `docs/torghut/design-system/v6/87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`
   - `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
   - `docs/torghut/design-system/v6/81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
   - `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
   - `docs/torghut/design-system/v6/80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`
   - `docs/agents/designs/67-jangar-runtime-evidence-epochs-and-artifact-parity-gates-2026-05-05.md`
   - `docs/torghut/design-system/v6/72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`
   - `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
   - `docs/torghut/design-system/v6/64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`
   - `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
   - `docs/agents/designs/64-jangar-recovery-warrants-and-rollout-cohorts-contract-2026-03-21.md`
   - `docs/torghut/design-system/v6/63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
   - `docs/torghut/design-system/v6/63-torghut-opportunity-books-and-evidence-drift-warrants-contract-2026-03-21.md`
   - `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
   - `docs/torghut/design-system/v6/62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
   - `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
   - `docs/torghut/design-system/v6/61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
   - `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
   - `docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
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
   - `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
   - `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
   - `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
   - `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
   - `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
   - `docs/agents/designs/57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`
   - `docs/agents/designs/58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`
   - `docs/agents/designs/58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`
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
   - `docs/torghut/design-system/v6/53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
   - `docs/torghut/design-system/v6/54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`
   - `docs/torghut/design-system/v6/66-torghut-property-based-testing-coverage-and-lint-hardening-2026-03-28.md`
   - `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`
   - `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
   - `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
   - `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
   - `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
   - `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
   - `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
   - `docs/torghut/design-system/v6/57-torghut-profit-clock-cutover-and-regime-auction-contract-2026-03-20.md`
   - `docs/torghut/design-system/v6/57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`
   - `docs/torghut/design-system/v6/58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
   - `docs/torghut/design-system/v6/59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`

4. options-lane historical design snapshots:
   - `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
   - `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
   - `docs/torghut/design-system/v6/35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
   - `docs/torghut/design-system/v6/36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
   - `docs/torghut/design-system/v6/37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md`

These March 2026 options-lane files are retained for rationale and archaeology only. They are no longer current
authority for implementation, promotion, cluster health, or live trading decisions. Use live GitOps, service code,
runtime status, and the current Torghut index before acting on any options-lane detail.

## Current priority, not historical priority

The current highest-priority work is:

The May 13 repair-outcome dividend ledger is the current top priority after freshness-carry and repair-bid settlement
landed:

- make Torghut publish `repair_outcome_dividend_ledger` from status, health, readyz, and consumer-evidence surfaces so
  dispatchable zero-notional repair lots have a typed outcome receipt or open escrow in
  `docs/torghut/design-system/v6/193-torghut-repair-outcome-dividend-ledger-and-capital-reentry-frontier-2026-05-13.md`;
- make Jangar consume repair outcome escrows in terminal debt compaction before widening additional repair dispatch in
  `docs/agents/designs/189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md`;
- preserve `max_notional=0`, shadow capital, and live-submit holds while measuring retired, preserved, or no-delta
  repair reason codes against `zero_notional_or_stale_evidence_rate`, `routeable_candidate_count`,
  `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

The May 13 freshness-carry handoff remains an active supporting priority:

- make Torghut publish `freshness_carry_ledger` from status, health, readyz, and consumer-evidence surfaces so TA
  signal, TCA, empirical, market-context, quant-evidence, and source-serving freshness are priced as explicit repair
  dimensions in
  `docs/torghut/design-system/v6/192-torghut-freshness-carry-and-repair-proof-slo-2026-05-13.md`;
- keep partial or stale freshness at `max_notional=0` while exposing bounded zero-notional repair SLOs that Jangar can
  pressure-budget through
  `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`.

The May 13 source-serving proof handoff remains an active supporting priority:

- make Torghut publish `source_serving_repair_receipt_ledger` from status and consumer-evidence surfaces so repair
  receipts cite source commit, serving build commit, serving image digest, manifest image digest, and required contract
  canaries before stale evidence can graduate in
  `docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`;
- make Jangar consume source-serving verdicts before deploy widening, merge-ready, paper support, or live support in
  `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`.

The May 13 repair-bid settlement handoff remains the next supporting priority:

- make Torghut preserve the raw route evidence clearinghouse packet while compacting broad negative evidence into
  bounded, deduped, zero-notional repair lots in
  `docs/torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`;
- make Jangar dispatch only current compacted Torghut repair lots with a value gate, output receipt, TTL, dedupe key,
  and `max_notional=0` in
  `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`.

The May 12 reliability-settlement handoff remains the next supporting priority:

- make Jangar preserve 15-minute, 6-hour, and 7-day failure debt, provider-capacity holds, rollout SLO receipts,
  least-privilege database projections, and stage-specific admission in
  `docs/agents/designs/184-jangar-reliability-settlement-ledger-and-rollout-slo-escrow-2026-05-12.md`;
- make Torghut rank stale proof repairs by expected post-cost profit unlock and execute only zero-notional repairs until
  signal, market context, empirical, TCA, schema, route, and Jangar settlement evidence are current in
  `docs/torghut/design-system/v6/188-torghut-profit-freshness-frontier-and-zero-notional-repair-market-2026-05-12.md`.

The May 8 execution-trust handoff is
`docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`, the
zero-notional profit-repair settlement ledger. It follows
`docs/torghut/design-system/v6/183-torghut-receipt-settled-capital-reentry-cohorts-2026-05-08.md`, the observe-mode
capital reentry cohort ledger.
The May 7 contract-graduation and executable-alpha contracts are the current implementation handoff:

- make Jangar graduate accepted design contracts through live runtime receipts before they can widen material action in
  `docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`;
- make Torghut zero-notional alpha repairs produce executable before/after receipts before paper or live capital can
  widen in
  `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`.

The May 7 source-rollout and proof-floor settlement contracts are the current implementation handoff:

- settle Jangar source head, Argo revision, desired image, live image, controller heartbeat, route status, database
  projection, watch cache, and Torghut proof-floor evidence into one action-class receipt in
  `docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`;
- price Torghut proof-floor blockers as settlement bonds, distinguish stale TCA recompute from bad TCA policy repair,
  and keep capital zero-notional until closure receipts and Jangar source-rollout settlement agree in
  `docs/torghut/design-system/v6/152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`.

The May 7 renewal-bond and stage-coherence contracts remain the preceding implementation handoff:

- make Torghut preserve fresh empirical proof as evidence carry while Jangar stage renewal, stale TCA, market-context
  contradictions, quant ingestion lag, or alpha-readiness blockers keep paper/live notional at zero in
  `docs/torghut/design-system/v6/137-torghut-renewal-bond-profit-escrow-and-evidence-carry-2026-05-07.md`;
- make Jangar expose active stage renewal bonds and controller ingestion settlement so Torghut can distinguish
  `current`, `renewing`, `repair_only`, `stale`, and `blocked` platform proof states in
  `docs/agents/designs/133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`;
- keep stale but promising proof available only for zero-notional repair ranking, not capital authority, in
  `docs/torghut/design-system/v6/136-torghut-stage-coherent-profit-escrow-and-proof-age-arbitrage-2026-05-07.md`;
- reclock Jangar stage freshness into explicit capital-authority inputs in
  `docs/agents/designs/132-jangar-stage-freshness-escrow-and-capital-authority-reclocking-2026-05-07.md`.

The May 6 provenance and lease-graduation contracts remain the preceding implementation handoff:

- make Jangar failure-domain leases source-qualified so arbitrary runner pod suffixes cannot masquerade as database
  outage evidence in
  `docs/agents/designs/101-jangar-evidence-provenance-firewall-and-lease-graduation-contract-2026-05-06.md`;
- make Torghut profit promotion depend on source-qualified proof, current empirical jobs, non-empty relevant data
  planes, rejection-drag measurement, and a matching Jangar action lease in
  `docs/torghut/design-system/v6/105-torghut-proof-provenance-firewall-and-profit-lease-graduation-2026-05-06.md`;
- reconcile Jangar healthy route/database checks with shadow failure-domain holdbacks through one action-class clock in
  `docs/agents/designs/100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`;
- expire stale Torghut proof and route hypotheses into explicit rehydration lanes before paper or live capital can
  advance in
  `docs/torghut/design-system/v6/104-torghut-proof-expiry-clock-and-hypothesis-rehydration-lanes-2026-05-06.md`.

The earlier May 6 discover cutover contracts remain the preceding implementation handoff:

- bind Jangar serving, repair, normal dispatch, rollout widening, merge readiness, and Torghut capital to one
  least-privilege cutover receipt in
  `docs/agents/designs/97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`;
- retire Torghut proof debt through compact receipts before shadow, paper, or live capital can advance in
  `docs/torghut/design-system/v6/101-torghut-proof-debt-retirement-and-shadow-capital-handoff-2026-05-06.md`.

The May 5 cross-plane contracts are now the latest active architecture layer:

- adopt Jangar brownout decisions by action class, keep bounded repair work open under explicit budgets, and expose a
  Torghut quant capital posture only after dispatch and rollout enforcement are validated in
  `docs/agents/designs/89-jangar-brownout-adoption-ladder-and-quant-capital-contract-2026-05-05.md`;
- price Torghut hypotheses by expected edge, empirical freshness, data quality, Jangar posture, and repair cost before
  allocating zero-notional repair, paper probes, or live capital in
  `docs/torghut/design-system/v6/93-torghut-evidence-priced-hypothesis-market-and-capital-ladder-2026-05-05.md`;
- let negative evidence overrule stale positive receipts for dispatch, rollout widening, and Torghut paper/live
  capital while repair lanes remain bounded in
  `docs/agents/designs/88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`;
- price proof producers and isolate options-catalog query failures from broader Torghut replay in
  `docs/torghut/design-system/v6/92-torghut-proof-cost-market-and-options-catalog-firebreak-2026-05-05.md`;
- convert Jangar authority-clearance cells into a budgeted repair exchange with closure warrants so degraded execution
  trust, image-pull blockers, route timeouts, and external-capital holds can run only bounded repair work until proof
  closes in
  `docs/agents/designs/83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`;
- convert Torghut profit debt into a repair-alpha exchange with zero-notional session proof budgets so stale empirical
  proof, missing quant health, signal-continuity alerts, feature gaps, drift gaps, and stale TCA compete by expected
  learning value before any paper/live capital widening in
  `docs/torghut/design-system/v6/87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`;
- make Jangar the settlement authority for action classes by joining serving, execution, rollout, watch, workflow,
  route, database, and downstream consumer clocks in
  `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`;
- reconcile Torghut live-submission liveness with Jangar settlement, profit clocks, stale empirical jobs,
  market-context freshness, and rollback readiness before non-shadow capital in
  `docs/torghut/design-system/v6/81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`;
- reclock Jangar rollout safety from settled event, execution, database, route, watch, workflow-artifact, and empirical
  proof before dispatch, rollout widening, or external capital in
  `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`;
- reclock Torghut live submission from capital proof clocks so route liveness cannot authorize non-shadow capital while
  Jangar settlement, empirical proof, hypotheses, signal freshness, or rollback state is held in
  `docs/torghut/design-system/v6/80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`;
- make Torghut readiness, trading status, Jangar quant health, and capital promotion depend on bounded hot-path proof
  projections and settled profit cells in
  `docs/torghut/design-system/v6/77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md`;
- make Jangar serving, dispatch, deploy widening, review ingest, and Torghut promotion consume route-authority fuses
  and deploy quarantine in
  `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`;
- make Torghut consume Jangar least-privilege profit projections consistently across capital routes in
  `docs/torghut/design-system/v6/76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`;
- make Jangar publish least-privilege evidence projections for deploy and Torghut consumers in
  `docs/agents/designs/71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`;
- make Jangar stage launch, deploy verification, and Torghut consumer authority depend on runtime evidence epochs and
  artifact parity gates in
  `docs/agents/designs/67-jangar-runtime-evidence-epochs-and-artifact-parity-gates-2026-05-05.md`;
- make Torghut research, portfolio proof, and capital promotion depend on cross-plane evidence epochs that bind
  Jangar authority, Torghut health, data freshness, artifact parity, and post-cost portfolio proof in
  `docs/torghut/design-system/v6/72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`.

The March 27 profitability-proof contracts are also active operator work for the retained internal-history window:

- convert Kafka-retained recent history into immutable replay bundles and archive-backed profitability proof in
  `docs/torghut/design-system/v6/53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`;
- turn the retained March 16 through March 27 internal window into a frozen selection/holdout sleeve-proof contract in
  `docs/torghut/design-system/v6/54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`.

The March 28 service-quality contract is also active engineering work for Torghut's trading core:

- move Torghut to Hypothesis-backed property/stateful testing, branch-coverage enforcement, and stricter lint gates in
  `docs/torghut/design-system/v6/66-torghut-property-based-testing-coverage-and-lint-hardening-2026-03-28.md`.

The March 29 onboarding glossary is the current terminology companion for engineers entering this codebase:

- use `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md` when the problem
  is understanding Torghut vocabulary, runtime flow, replay flow, decision persistence, or why a sleeve is flat.

1. cut Jangar over to shadow-compiled, sealed recovery epochs and enforce backlog-seat ownership before rollout in
   `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`;
2. cut Torghut over to lane-local profit windows and escrow enforcement with typed quant-route parity in
   `docs/torghut/design-system/v6/64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`;
3. bind Jangar runnable work to durable recovery epochs and backlog seats so stale runtime debt cannot relaunch after
   cutover in `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`;
4. bind Torghut lane authority to profit windows funded by explicit evidence escrows in
   `docs/torghut/design-system/v6/63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`;
5. make Jangar runtime completeness and consumer-facing authority explicit through projections and latency classes in
   `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`;
6. turn Torghut route-time gates into lane books and bounded query firebreaks in
   `docs/torghut/design-system/v6/62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`;
7. make Jangar runtime completeness and stale-stage debt explicit through execution receipts and recovery cells in
   `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`;
8. turn Torghut mixed evidence into lane-scoped evidence seats and a bounded profit repair exchange in
   `docs/torghut/design-system/v6/61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`;
9. make Jangar runtime completeness and consumer-scoped stage admission explicit through runtime kits and admission
   passports in
   `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`;
10. turn Torghut lane gating into hypothesis passports and a capability quote auction in
    `docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`;
11. retire stale freeze and rollout debt into a durable recovery ledger with consumer-scoped attestations in
    `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`;
12. replace route-time lane gating with lane balance sheets and dataset-seat auctions in
    `docs/torghut/design-system/v6/59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`;
13. replace request-time control-plane truth with authority sessions and rollout leases in
    `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`;
14. turn Jangar authority capsules into journaled, replayable cell-scoped truth in
    `docs/agents/designs/58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`;
15. repair cutover from broad status reduction to durable authority capsules and freeze-expiry workflows in
    `docs/agents/designs/58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`;
16. compile small Jangar authority capsules and reconcile stale swarm-freeze truth through
    `docs/agents/designs/57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`;
17. replace route-local promotion truth with compiled admission receipts and rollout shadow in
    `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`;
18. collapse swarm freeze, stage failure, rollout health, and downstream freshness into one admission artifact through
    `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`;
19. bind every Jangar consumer to typed capability receipts and digest parity in
    `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`;
20. separate serving readiness from promotion authority through durable capsules and readiness classes in
    `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`;
21. allocate Torghut capital through authority-session-bound profit cohorts and bounded freshness insurance in
    `docs/torghut/design-system/v6/58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`;
22. turn Torghut profit clocks into reserve records with forecast-calibration escrow and probe-class capital in
    `docs/torghut/design-system/v6/57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`;
23. cut Torghut over from generic status-route gating to typed profit clocks and regime auctions in
    `docs/torghut/design-system/v6/57-torghut-profit-clock-cutover-and-regime-auction-contract-2026-03-20.md`;
24. replace ephemeral live-capital answers with capital leases and profit-trial firebreaks in
    `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`;
25. allocate and revoke live capital through sleeve-scoped lease receipts and falsification events in
    `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`;
26. settle Torghut hypothesis capital through lane capability leases and typed Jangar endpoint contracts in
    `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`;
27. replace URL-derived authority with typed capability leases and lane-local profit clocks in
    `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`;
28. move from coarse gate payloads to durable profit clocks and a lane-aware capital auction in
    `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`;
29. make unknown or contradictory rollout evidence veto-capable through witness mirrors and promotion covenants in
    `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`;
30. make non-observe capital depend on a single cross-plane profit certificate plus lane-scoped options auth/bootstrap
    isolation in
    `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`;
31. replace whole-swarm failure coupling with execution cells and collaboration failover in
    `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`;
32. make rollout truth depend on rollout-epoch acknowledgement and segment circuit breakers in
    `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`;
33. force submission parity and options bootstrap escrow through the Torghut plan contract in
    `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`;
34. force capital-stage decisions through the hypothesis capital governor, promotion-certificate, and data-quorum
    contract in `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`;
35. make admission truth durable with dependency provenance, consumer acknowledgement, and replayable collaboration in
    `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`;
36. extend that control plane with the segment-authority-graph and promotion-certificate fail-safe in
    `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`;
37. make non-shadow capital depend on expiring profit reservations, schema fitness, and simulation slot ownership in
    `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`;
38. wire Torghut scheduler and status through the segment-firebreak handoff in
    `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`;
39. make sleeve-level capital, deallocation, and evidence decay explicit in
    `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`;
40. keep producer-authored freshness and proof bundles active by continuing the ledger direction defined in
    `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`;
41. isolate control-plane failure domains with rollout-safe gates in
    `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`;
42. retain hypothesis-specific profitability guardrails from
    `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`,
    but make them subordinate to fresh data quorum, immutable evidence bundles, and lease revocation;
43. execute the merged control-plane/profitability program with the March 15-16 base, the March 19 authority stack,
    and the March 20 readiness-class, session, journal, cutover, reserve, witness-quorum, admission-receipt,
    fact-receipt, binding-contract, profit-certificate, capital-lease, falsification-ledger, settlement-exchange,
    authority-capsule, runtime-kit, admission-passport, hypothesis-passport, capability-quote-auction, profit-clock,
    profit-cohort, consumer-projection, latency-class-admission, lane-book, and query-firebreak contracts layered on
    top.

## Supporting discover-stage rationale

These March 20 documents remain useful as the evidence-backed discover bridge into the later session, cutover, and
profit-cohort contracts above, but they are not the newest operator contract layer:

- `docs/agents/designs/57-jangar-authority-capsules-and-route-parity-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md`

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
- `docs/agents/designs/57-jangar-authority-capsules-and-route-parity-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md`

They should inform decisions, but they should not be treated as the single current operator checklist without checking
the current contract docs above.

## Current design docs that remain active

These are still active contract docs rather than historical snapshots:

- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
- `docs/agents/designs/64-jangar-recovery-warrants-and-rollout-cohorts-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/63-torghut-opportunity-books-and-evidence-drift-warrants-contract-2026-03-21.md`
- `docs/torghut/design-system/v1/historical-dataset-simulation.md`
- `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
- `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
- `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
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
- `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`
- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
- `docs/agents/designs/57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`
- `docs/agents/designs/58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`
- `docs/agents/designs/58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
- `docs/torghut/design-system/v6/54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`
- `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
- `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
- `docs/torghut/design-system/v6/57-torghut-profit-clock-cutover-and-regime-auction-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`
- `docs/torghut/design-system/v6/58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
- `docs/torghut/design-system/v6/34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`

## How to interpret ambiguous docs

When a document mixes design, proof, and closeout material:

1. trust the exact date in the header;
2. check whether it is describing a baseline snapshot, a landed implementation update, or a current recommendation;
3. prefer current source files and current contract docs when there is any conflict;
4. treat milestone language like "completed" or "closeout" as scoped to that dated workstream, not as proof that no
   important work remains.
