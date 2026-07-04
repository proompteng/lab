# Torghut Design System v6: Beyond TSMOM Intraday Autonomy Pack

This index is a historical archive for design contracts, proof records, and implementation closeouts. Do not treat
dated v6 files as current operational truth until they are verified against live GitOps, `services/torghut/**`, and
runtime readback. Start current operations from `docs/torghut/README.md`.

## Status

- Version: `v6`
- Date: `2026-03-03`
- Maturity: `production-quality design pack`
- Scope: intraday strategy architecture upgrade beyond static TSMOM, with regime-adaptive routing, DSPy-governed LLM
  reasoning, contamination-safe evaluation, and production rollout controls
- Implementation status: `Mixed` (historical program closure recorded on `2026-03-03`; source-state refreshed on
  `2026-03-09`; active proof/capital authority evidence refreshed on `2026-05-14T20:12Z`)
- Implementation status (strict, core 01-13 docs, source-state refresh `2026-03-09`): `Implemented=7`, `Partial=5`,
  `Completed=1`
- Evidence (historical closure): `13-production-gap-closure-master-plan-2026-03-03.md` (Wave 0-6 closure + DoD)
- Evidence (current next-work priority, refreshed `2026-05-15T00:30Z`):
  - `docs/agents/designs/207-jangar-consumer-evidence-transport-split-and-source-serving-contract-canary-2026-05-15.md`
  - `213-torghut-consumer-evidence-contract-canary-and-alpha-reentry-transport-2026-05-15.md`
  - `docs/agents/designs/206-jangar-route-adjacent-proof-custody-and-torghut-reentry-admission-2026-05-14.md`
  - `212-torghut-route-adjacent-proof-and-execution-freshness-reentry-2026-05-14.md`
  - `docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md`
  - `212-torghut-revenue-repair-topline-contract-and-alpha-evidence-budget-2026-05-14.md`
  - `docs/agents/designs/206-jangar-consumer-evidence-parity-settlement-and-alpha-release-custody-2026-05-14.md`
  - `212-torghut-consumer-evidence-parity-and-alpha-release-freshness-2026-05-14.md`
  - `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
  - `211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
  - `docs/agents/designs/204-jangar-source-bound-verification-carry-exchange-and-repair-slot-reconciliation-2026-05-14.md`
  - `210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
  - `docs/agents/designs/203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
  - `209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
  - `208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`
  - `docs/agents/designs/202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`
  - `207-torghut-quant-plan-closeout-and-alpha-repair-reentry-handoff-2026-05-14.md`
  - `206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
  - `docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
  - `205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
  - `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
  - `204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`
  - `docs/agents/designs/199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
  - `203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`
  - `docs/agents/designs/198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md`
  - `202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md`
  - `docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md`
  - `202-torghut-alpha-evidence-foreclosure-and-routeable-candidate-reentry-2026-05-14.md`
  - `docs/agents/designs/197-jangar-alpha-evidence-foreclosure-governor-and-runner-custody-2026-05-14.md`
  - `201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
  - `docs/agents/designs/196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md`
  - `200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`
  - `docs/agents/designs/195-jangar-receipt-backed-alpha-foundry-and-rollout-safety-covenant-2026-05-14.md`
  - `199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`
  - `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
  - `198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`
  - `docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
  - `197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`
  - `docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`
  - `197-torghut-serving-promotion-closure-and-no-delta-repair-value-2026-05-13.md`
  - `docs/agents/designs/192-jangar-source-to-serving-promotion-closure-and-repair-value-accounting-2026-05-13.md`
  - `197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`
  - `docs/agents/designs/192-jangar-alpha-readiness-repair-escrow-and-runner-admission-2026-05-13.md`
  - `196-torghut-profit-carry-passports-and-repair-capacity-futures-2026-05-13.md`
  - `docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`
  - `195-torghut-stale-projection-foreclosure-and-route-custody-2026-05-13.md`
  - `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`
  - `193-torghut-route-repair-yield-board-and-hypothesis-reentry-guardrails-2026-05-13.md`
  - `docs/agents/designs/189-jangar-authority-provenance-settlement-and-rollout-reentry-windows-2026-05-13.md`
  - `194-torghut-quant-plan-closeout-and-repair-only-handoff-2026-05-13.md`
  - `193-torghut-account-scoped-quant-witness-bridge-and-route-reentry-2026-05-13.md`
  - `docs/agents/designs/189-jangar-account-scoped-quant-witness-custody-and-route-reentry-2026-05-13.md`
  - `193-torghut-repair-outcome-dividend-ledger-and-capital-reentry-frontier-2026-05-13.md`
  - `docs/agents/designs/189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md`
  - `192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`
  - `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
  - `192-torghut-freshness-carry-and-repair-proof-slo-2026-05-13.md`
  - `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`
  - `192-torghut-typed-consumer-evidence-route-and-capital-safe-repair-dispatch-2026-05-13.md`
  - `docs/agents/designs/188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
  - `191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`
  - `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
  - `190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
  - `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
  - `190-torghut-route-warrant-exchange-and-ingestion-proof-reentry-2026-05-13.md`
  - `docs/agents/designs/186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md`
  - `189-torghut-clock-settled-repair-execution-and-routeability-reentry-2026-05-12.md`
  - `docs/agents/designs/185-jangar-clock-settled-repair-dispatch-and-rollout-custody-2026-05-12.md`
  - `189-torghut-repair-yield-market-and-profit-hypothesis-guardrails-2026-05-12.md`
  - `docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md`
  - `188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
  - `docs/agents/designs/184-jangar-rollout-custody-and-evidence-clock-dispatch-2026-05-12.md`
  - `188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`
  - `docs/agents/designs/184-jangar-rollout-evidence-escrow-and-proof-repair-admission-2026-05-12.md`
  - `188-torghut-evidence-credit-capital-repair-market-2026-05-12.md`
  - `docs/agents/designs/184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`
  - `188-torghut-stage-clearance-consumer-and-repair-lot-broker-2026-05-12.md`
  - `docs/agents/designs/184-jangar-stage-clearance-packets-and-repair-run-lot-ledger-2026-05-12.md`
  - `187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`
  - `docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
  - `186-torghut-routeability-acceptance-cutover-and-fill-quality-loop-2026-05-08.md`
  - `docs/agents/designs/182-jangar-routeability-cutover-backpressure-and-proof-run-admission-2026-05-08.md`
  - `185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`
  - `docs/agents/designs/181-jangar-proof-production-debt-and-routeability-admission-2026-05-08.md`
  - `186-torghut-proof-lease-repair-market-and-capital-hold-2026-05-08.md`
  - `docs/agents/designs/182-jangar-controller-witness-carry-and-failure-debt-maturity-2026-05-08.md`
  - `184-torghut-profit-frontier-reclocking-and-capital-reentry-guardrails-2026-05-08.md`
  - `docs/agents/designs/180-jangar-evidence-settlement-reclocking-and-profit-gated-rollouts-2026-05-08.md`
  - `184-torghut-profit-signal-quorum-and-context-routability-handoff-2026-05-08.md`
  - `docs/agents/designs/180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
  - `184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`
  - `docs/agents/designs/180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`
  - `183-torghut-receipt-settled-capital-reentry-cohorts-2026-05-08.md`
  - `docs/agents/designs/179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`
  - `182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
  - `docs/agents/designs/178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
  - `181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`
  - `docs/agents/designs/177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
  - `180-torghut-resource-priced-evidence-frontier-and-context-spend-escrow-2026-05-08.md`
  - `docs/agents/designs/176-jangar-resource-pressure-escrow-and-runner-qos-gates-2026-05-08.md`
  - `179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`
  - `docs/agents/designs/175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
  - `178-torghut-route-sample-mint-and-capital-proof-ratchet-2026-05-08.md`
  - `docs/agents/designs/174-jangar-observer-rights-and-source-settled-capital-ledger-2026-05-08.md`
  - `177-torghut-profit-repair-broker-and-capital-promotion-gates-2026-05-08.md`
  - `docs/agents/designs/173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
  - `176-torghut-source-bound-evidence-reconciliation-and-capital-admission-ledger-2026-05-08.md`
  - `docs/agents/designs/172-jangar-evidence-reconciliation-broker-and-capital-action-firewall-2026-05-08.md`
  - `176-torghut-revision-priced-route-frontier-and-capital-carry-2026-05-08.md`
  - `docs/agents/designs/172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md`
  - `175-torghut-failure-costed-context-repair-and-route-custody-2026-05-08.md`
  - `docs/agents/designs/171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`
  - `174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md`
  - `docs/agents/designs/170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md`
  - `172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`
  - `docs/agents/designs/168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
  - `171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`
  - `docs/agents/designs/167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
  - `170-torghut-capital-surface-repair-cadence-and-route-edge-market-2026-05-07.md`
  - `docs/agents/designs/166-jangar-repair-cadence-ledger-and-capital-surface-admission-2026-05-07.md`
  - `170-torghut-data-witness-capability-bonds-and-capital-observation-gates-2026-05-07.md`
  - `docs/agents/designs/166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md`
  - `169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`
  - `docs/agents/designs/165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md`
  - `168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`
  - `docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`
  - `166-torghut-paper-edge-witness-notary-and-zero-notional-repair-queue-2026-05-07.md`
  - `docs/agents/designs/162-jangar-contract-witness-notary-and-material-action-gates-2026-05-07.md`
  - `166-torghut-executable-profit-receipts-and-repair-convoy-settlement-2026-05-07.md`
  - `docs/agents/designs/162-jangar-capital-receipt-convergence-and-repair-convoy-admission-2026-05-07.md`
  - `165-torghut-quant-freshness-debt-and-paper-edge-ledgers-2026-05-07.md`
  - `docs/agents/designs/161-jangar-stage-debt-clearinghouse-and-freshness-credit-ledger-2026-05-07.md`
  - `164-torghut-zero-notional-route-repair-packets-and-paper-rehearsal-2026-05-07.md`
  - `docs/agents/designs/160-jangar-split-authority-repair-escrow-and-dispatch-reentry-packets-2026-05-07.md`
  - `163-torghut-quant-stage-cohort-and-evidence-repair-settlement-2026-05-07.md`
  - `docs/agents/designs/159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`
  - `136-torghut-quant-plan-closeout-and-proof-surface-handoff-2026-05-07.md`
  - `163-torghut-repair-outcome-attribution-and-capital-reentry-slo-2026-05-07.md`
  - `docs/agents/designs/159-jangar-closed-loop-repair-outcome-ledger-and-material-action-reentry-2026-05-07.md`
  - `162-torghut-profit-evidence-refill-and-capital-route-reentry-2026-05-07.md`
  - `docs/agents/designs/158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`
  - `161-torghut-shadow-capital-parity-and-no-notional-release-train-2026-05-07.md`
  - `docs/agents/designs/157-jangar-shadow-parity-ledger-and-enforcement-release-train-2026-05-07.md`
  - `160-torghut-proof-surface-activation-ledger-and-capital-receipt-firewall-2026-05-07.md`
  - `docs/agents/designs/156-jangar-runtime-activation-receipts-and-source-drift-quarantine-2026-05-07.md`
  - `159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
  - `docs/agents/designs/155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
  - `158-torghut-route-reacquisition-and-market-context-repair-cells-2026-05-07.md`
  - `docs/agents/designs/154-jangar-repair-cell-admission-and-market-context-trust-gates-2026-05-07.md`
  - `158-torghut-capital-proof-provenance-and-routeable-edge-repair-ledger-2026-05-07.md`
  - `docs/agents/designs/154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`
  - `157-torghut-profit-contract-actuation-and-capital-surface-truth-2026-05-07.md`
  - `docs/agents/designs/153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
  - `155-torghut-capital-repair-outcome-ledger-and-edge-reacquisition-gates-2026-05-07.md`
  - `docs/agents/designs/151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`
  - `156-torghut-repair-closure-yield-ledger-and-capital-unlock-receipts-2026-05-07.md`
  - `docs/agents/designs/152-jangar-material-verdict-authority-and-contradiction-debt-ledger-2026-05-07.md`
  - `154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`
  - `docs/agents/designs/150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`
  - `153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`
  - `docs/agents/designs/149-jangar-wrapper-truth-settlement-and-useful-evidence-gates-2026-05-07.md`
  - `151-torghut-repair-alpha-carry-exchange-and-paper-settlement-ledger-2026-05-07.md`
  - `docs/agents/designs/147-jangar-hot-path-witness-cache-and-repair-settlement-cells-2026-05-07.md`
  - `152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`
  - `docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
  - `151-torghut-hypothesis-scoped-capital-adjudication-and-profit-gates-2026-05-07.md`
  - `docs/agents/designs/147-jangar-hypothesis-scoped-capital-adjudication-ledger-2026-05-07.md`
  - `150-torghut-repair-dividend-order-book-and-capital-warrants-2026-05-07.md`
  - `docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`
  - `149-torghut-profit-evidence-convergence-epochs-and-quant-stage-arbitrage-2026-05-07.md`
  - `docs/agents/designs/145-jangar-observation-epoch-tripwire-and-capital-contradiction-arbiter-2026-05-07.md`
  - `148-torghut-profit-evidence-reactivation-scheduler-and-paper-gate-receipts-2026-05-07.md`
  - `docs/agents/designs/144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`
  - `147-torghut-proof-escrow-hypothesis-repair-and-capital-settlement-2026-05-07.md`
  - `docs/agents/designs/143-jangar-least-privilege-evidence-escrow-and-capital-proof-settlement-2026-05-07.md`
  - `147-torghut-profit-repair-leases-and-forecast-registry-settlement-2026-05-07.md`
  - `docs/agents/designs/143-jangar-profit-repair-lease-control-plane-and-controller-witness-exchange-2026-05-07.md`
  - `147-torghut-stale-proof-repair-exchange-and-route-stable-capital-quorum-2026-05-07.md`
  - `docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`
  - `146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md`
  - `docs/agents/designs/142-jangar-repair-dividend-handoff-gates-and-actuation-contracts-2026-05-07.md`
  - `145-torghut-proof-renewal-leases-and-capital-reentry-state-market-2026-05-07.md`
  - `docs/agents/designs/141-jangar-proof-renewal-leases-and-trading-state-custody-2026-05-07.md`
  - `145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md`
  - `docs/agents/designs/141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`
  - `144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md`
  - `docs/agents/designs/140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
  - `143-torghut-empirical-relay-receipts-and-paper-gate-settlement-2026-05-07.md`
  - `docs/agents/designs/139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`
  - `142-torghut-alpha-truth-windows-and-capital-reentry-warrants-2026-05-07.md`
  - `docs/agents/designs/138-jangar-proof-truth-windows-and-contradiction-arbiter-2026-05-07.md`
  - `141-torghut-watch-debt-profit-repair-market-and-capital-reentry-gates-2026-05-07.md`
  - `docs/agents/designs/137-jangar-watch-debt-clearing-and-profit-repair-leases-2026-05-07.md`
  - `140-torghut-post-cost-alpha-reentry-and-proof-query-market-2026-05-07.md`
  - `docs/agents/designs/136-jangar-verification-trust-escrow-and-query-budgeted-evidence-settlement-2026-05-07.md`
  - `140-torghut-endpoint-parity-profit-repair-and-capital-route-auction-2026-05-07.md`
  - `docs/agents/designs/136-jangar-controller-authority-settlement-and-endpoint-parity-ledger-2026-05-07.md`
  - `139-torghut-profit-evidence-custody-and-capital-reentry-auction-2026-05-07.md`
  - `docs/agents/designs/135-jangar-rollout-availability-escrow-and-consumer-evidence-custody-2026-05-07.md`
  - `139-torghut-profit-data-witness-and-forecast-repair-exchange-2026-05-07.md`
  - `docs/agents/designs/135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
  - `138-torghut-profit-stats-census-and-tca-reactivation-market-2026-05-07.md`
  - `docs/agents/designs/134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
  - `138-torghut-capital-efficiency-proof-exchange-and-profit-clock-2026-05-07.md`
  - `docs/agents/designs/134-jangar-profit-clock-settlement-router-and-evidence-margin-arbiter-2026-05-07.md`
  - `137-torghut-renewal-bond-profit-escrow-and-evidence-carry-2026-05-07.md`
  - `docs/agents/designs/133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
  - `136-torghut-stage-coherent-profit-escrow-and-proof-age-arbitrage-2026-05-07.md`
  - `docs/agents/designs/132-jangar-stage-freshness-escrow-and-capital-authority-reclocking-2026-05-07.md`
  - `136-torghut-capital-repair-escrow-and-freshness-auction-2026-05-07.md`
  - `docs/agents/designs/132-jangar-schedule-lease-rehydration-and-stage-trust-settlement-2026-05-07.md`
  - `136-torghut-quant-plan-closeout-and-proof-surface-handoff-2026-05-07.md`
  - `135-torghut-capital-qualified-alpha-router-and-execution-repair-ladder-2026-05-06.md`
  - `docs/agents/designs/131-jangar-capital-qualification-receipts-and-rollout-repair-arbiter-2026-05-06.md`
  - `135-torghut-forecast-evidence-bonds-and-capital-reentry-escrow-2026-05-06.md`
  - `docs/agents/designs/131-jangar-cross-plane-evidence-custody-and-dispatch-escrow-2026-05-06.md`
  - `134-torghut-profitability-proof-floor-and-evidence-repair-market-2026-05-06.md`
  - `docs/agents/designs/130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
  - `133-torghut-capital-readiness-cache-and-profit-carry-governor-2026-05-06.md`
  - `docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
  - `133-torghut-stable-jangar-receipts-and-closed-session-capital-hold-2026-05-06.md`
  - `docs/agents/designs/129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
  - `133-torghut-consumer-evidence-return-path-and-shadow-settlement-2026-05-06.md`
  - `docs/agents/designs/129-jangar-consumer-evidence-return-ledger-and-rollout-settlement-2026-05-06.md`
  - `132-torghut-dependency-quorum-rehydration-and-profit-inventory-handoff-2026-05-06.md`
  - `docs/agents/designs/128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
  - `132-torghut-forecast-profit-tournament-and-capital-reentry-guardrails-2026-05-06.md`
  - `docs/agents/designs/128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
  - `131-torghut-active-profit-inventory-and-quant-carry-fuses-2026-05-06.md`
  - `docs/agents/designs/127-jangar-activation-inventory-ledger-and-product-gap-fuses-2026-05-06.md`
  - `131-torghut-session-capital-bonds-and-profit-rehearsal-exchange-2026-05-06.md`
  - `docs/agents/designs/127-jangar-session-rehearsal-conductor-and-capital-settlement-gates-2026-05-06.md`
  - `130-torghut-evidence-product-order-book-and-profit-carry-ladder-2026-05-06.md`
  - `docs/agents/designs/126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
  - `129-torghut-proof-carry-watermarks-and-zero-decision-capital-drain-2026-05-06.md`
  - `docs/agents/designs/125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
  - `128-torghut-data-plane-disruption-premium-and-freshness-settlement-2026-05-06.md`
  - `docs/agents/designs/124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
  - `127-torghut-market-context-claims-and-lane-profit-settlement-2026-05-06.md`
  - `docs/agents/designs/123-jangar-market-context-contradiction-ledger-and-lane-capital-holds-2026-05-06.md`
  - `126-torghut-hypothesis-custody-ledger-and-data-cost-profit-reserve-2026-05-06.md`
  - `docs/agents/designs/122-jangar-evidence-pressure-governor-and-data-cost-rollout-cells-2026-05-06.md`
  - `125-torghut-profit-priced-evidence-renewal-and-capital-reentry-ledger-2026-05-06.md`
  - `docs/agents/designs/121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`
  - `125-torghut-proof-renewal-train-and-capital-reentry-sequencer-2026-05-06.md`
  - `docs/agents/designs/121-jangar-controller-witness-uplink-and-proof-renewal-train-2026-05-06.md`
  - `124-torghut-capital-action-verdict-consumer-and-profit-hypothesis-settlement-2026-05-06.md`
  - `docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
  - `124-torghut-data-plane-proof-quarantine-and-profit-renewal-fuse-2026-05-06.md`
  - `docs/agents/designs/120-jangar-data-plane-proof-quarantine-and-profit-repair-fuse-2026-05-06.md`
  - `123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md`
  - `docs/agents/designs/119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
  - `122-torghut-profit-renewal-bids-and-capital-shadow-ledger-2026-05-06.md`
  - `docs/agents/designs/118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
  - `121-torghut-opening-bell-proof-ladder-and-account-scoped-alpha-reentry-2026-05-06.md`
  - `docs/agents/designs/117-jangar-opening-proof-reconciliation-and-account-scope-capital-veto-2026-05-06.md`
  - `121-torghut-evidence-debt-tranches-and-profit-unblock-ladder-2026-05-06.md`
  - `docs/agents/designs/117-jangar-evidence-debt-tranches-and-capital-unblock-ledger-2026-05-06.md`
  - `120-torghut-capital-activation-receipts-and-shadow-profit-proof-queue-2026-05-06.md`
  - `docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
  - `119-torghut-evidence-renewal-batches-and-capital-quiescence-gates-2026-05-06.md`
  - `docs/agents/designs/115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
  - `118-torghut-proof-route-parity-and-options-informed-repair-scheduler-2026-05-06.md`
  - `docs/agents/designs/114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
  - `117-torghut-contradiction-priced-profit-repair-and-capital-readmission-2026-05-06.md`
  - `docs/agents/designs/113-jangar-contradiction-settlement-and-profit-repair-auction-2026-05-06.md`
  - `116-torghut-session-scoped-alpha-ledger-and-replay-capital-scheduler-2026-05-06.md`
  - `docs/agents/designs/112-jangar-session-scoped-proof-settlement-and-stale-alert-netting-2026-05-06.md`
  - `115-torghut-proof-spend-market-and-negative-evidence-consumer-2026-05-06.md`
  - `docs/agents/designs/111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`
  - `114-torghut-convergence-bound-proof-replay-and-capital-readmission-2026-05-06.md`
  - `docs/agents/designs/110-jangar-gitops-convergence-escrow-and-promotion-evidence-ledger-2026-05-06.md`
  - `113-torghut-live-sim-parity-and-empirical-proof-replay-escrow-2026-05-06.md`
  - `docs/agents/designs/109-jangar-promotion-escrow-replay-cells-and-consumer-parity-gates-2026-05-06.md`
  - `112-torghut-dual-key-capital-clearance-and-intraday-proof-loop-2026-05-06.md`
  - `docs/agents/designs/108-jangar-action-class-capital-clearance-and-proof-clock-arbiter-2026-05-06.md`
  - `111-torghut-reciprocal-evidence-authority-and-profit-escrow-2026-05-06.md`
  - `docs/agents/designs/107-jangar-reciprocal-evidence-authority-and-contradiction-escrow-2026-05-06.md`
  - `110-torghut-options-hypothesis-leases-and-capital-reentry-ladder-2026-05-06.md`
  - `docs/agents/designs/106-jangar-proof-debt-retirement-exchange-and-experiment-lease-arbiter-2026-05-06.md`
  - `109-torghut-profit-proof-budget-consumer-and-options-runway-2026-05-06.md`
  - `docs/agents/designs/105-jangar-evidence-pressure-runways-and-profit-proof-budgets-2026-05-06.md`
  - `108-torghut-capital-clearance-market-and-negative-evidence-ledger-2026-05-06.md`
  - `docs/agents/designs/104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`
  - `108-torghut-proof-repair-closure-receipts-and-profit-settlement-2026-05-06.md`
  - `docs/agents/designs/104-jangar-repair-closure-receipts-and-settlement-finality-2026-05-06.md`
  - `107-torghut-decision-custody-cells-and-capital-reentry-2026-05-06.md`
  - `docs/agents/designs/103-jangar-torghut-decision-custody-cells-and-rollout-proof-exchange-2026-05-06.md`
  - `107-torghut-profit-repair-roi-ledger-and-capital-settlement-gates-2026-05-06.md`
  - `docs/agents/designs/103-jangar-material-action-settlement-board-and-profit-repair-gates-2026-05-06.md`
  - `106-torghut-live-proof-recovery-ledger-and-options-data-firewall-2026-05-06.md`
  - `docs/agents/designs/102-jangar-dual-authority-dispatch-ledger-and-capital-proof-firewall-2026-05-06.md`
  - `105-torghut-proof-provenance-firewall-and-profit-lease-graduation-2026-05-06.md`
  - `docs/agents/designs/101-jangar-evidence-provenance-firewall-and-lease-graduation-contract-2026-05-06.md`
  - `105-torghut-capital-reentry-evidence-feed-and-readiness-debt-netting-2026-05-06.md`
  - `docs/agents/designs/101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`
  - `105-torghut-account-scoped-hypothesis-liquidity-and-options-bootstrap-2026-05-06.md`
  - `docs/agents/designs/101-jangar-account-scoped-proof-liquidity-and-query-budget-2026-05-06.md`
  - `104-torghut-proof-expiry-clock-and-hypothesis-rehydration-lanes-2026-05-06.md`
  - `docs/agents/designs/100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`
  - `103-torghut-hypothesis-lease-arbiter-and-options-profit-runway-2026-05-06.md`
  - `docs/agents/designs/99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`
  - `103-torghut-hypothesis-rehydration-and-proof-gap-auction-2026-05-06.md`
  - `docs/agents/designs/99-jangar-proof-gap-auction-and-hypothesis-rehydration-runway-2026-05-06.md`
  - `102-torghut-profit-proof-exchange-and-capital-slo-budget-2026-05-06.md`
  - `docs/agents/designs/98-jangar-action-slo-budget-and-profit-proof-exchange-2026-05-06.md`
  - `101-torghut-proof-debt-retirement-and-shadow-capital-handoff-2026-05-06.md`
  - `docs/agents/designs/97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`
  - `101-torghut-scoped-quant-proof-leases-and-paper-capital-settlement-2026-05-06.md`
  - `docs/agents/designs/97-jangar-scoped-proof-lease-arbiter-and-capital-reentry-settlement-2026-05-06.md`
  - `100-torghut-session-proof-train-and-profitability-warrants-2026-05-06.md`
  - `docs/agents/designs/96-jangar-session-proof-train-and-capital-authority-separation-2026-05-06.md`
  - `100-torghut-market-context-negative-evidence-and-shadow-capital-router-2026-05-06.md`
  - `docs/agents/designs/96-jangar-observed-action-authority-and-negative-evidence-reclocking-2026-05-06.md`
  - `99-torghut-profit-proof-escrow-and-repair-dividend-slo-2026-05-05.md`
  - `docs/agents/designs/95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
  - `98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md`
  - `docs/agents/designs/94-jangar-proof-backed-rollout-brake-and-repair-debt-ledger-2026-05-05.md`
  - `96-torghut-control-plane-proof-feed-and-profit-route-budget-contract-2026-05-05.md`
  - `docs/agents/designs/92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`
  - `94-torghut-session-edge-ledger-and-cost-aware-capital-allocator-2026-05-05.md`
  - `docs/agents/designs/90-jangar-proof-capacity-leases-and-route-slo-governor-2026-05-05.md`
  - `93-torghut-recovery-budget-profit-ladder-and-session-cost-ledger-2026-05-05.md`
  - `docs/agents/designs/89-jangar-action-settlement-windows-and-recovery-budget-governor-2026-05-05.md`
  - `93-torghut-evidence-priced-hypothesis-market-and-capital-ladder-2026-05-05.md`
  - `docs/agents/designs/89-jangar-brownout-adoption-ladder-and-quant-capital-contract-2026-05-05.md`
  - `92-torghut-proof-cost-market-and-options-catalog-firebreak-2026-05-05.md`
  - `docs/agents/designs/88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
  - `91-torghut-causal-replay-exchange-and-capital-reentry-governor-2026-05-05.md`
  - `docs/agents/designs/87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`
  - `90-torghut-proof-receipt-router-and-capital-query-firebreak-2026-05-05.md`
  - `docs/agents/designs/86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`
  - `89-torghut-zero-notional-proof-runway-and-profit-debt-exchange-2026-05-05.md`
  - `docs/agents/designs/85-jangar-proof-debt-exchange-and-rollout-credit-windows-2026-05-05.md`
  - `88-torghut-session-proof-budget-consumer-and-capital-reentry-contract-2026-05-05.md`
  - `docs/agents/designs/84-jangar-material-action-settlement-and-proof-budget-cutover-2026-05-05.md`
  - `88-torghut-profit-slo-lanes-and-session-replay-governor-2026-05-05.md`
  - `docs/agents/designs/84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md`
  - `88-torghut-session-proof-liquidity-and-hypothesis-market-maker-2026-05-05.md`
  - `docs/agents/designs/84-jangar-evidence-liquidity-router-and-stale-digest-quarantine-2026-05-05.md`
  - `87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`
  - `docs/agents/designs/83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
  - `87-torghut-capital-lease-consumer-and-profit-repair-marketplace-2026-05-05.md`
  - `docs/agents/designs/83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
  - `86-torghut-profit-repair-auction-and-proof-runway-consumer-2026-05-05.md`
  - `docs/agents/designs/82-jangar-proof-runway-cutover-and-consumer-authority-2026-05-05.md`
  - `86-torghut-profit-debt-ledger-and-repair-sla-experiments-2026-05-05.md`
  - `docs/agents/designs/82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
  - `85-torghut-profit-escrow-repair-auction-and-capital-authority-2026-05-05.md`
  - `docs/agents/designs/81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`
  - `85-torghut-proof-fresh-profitability-governor-and-causal-replay-quarantine-2026-05-05.md`
  - `docs/agents/designs/81-jangar-action-class-proof-fuses-and-quant-health-quarantine-2026-05-05.md`
  - `84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`
  - `docs/agents/designs/80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
  - `83-torghut-profit-runway-consumer-and-hypothesis-capital-auction-2026-05-05.md`
  - `docs/agents/designs/79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
  - `82-torghut-order-admission-warrants-and-replay-capital-auction-2026-05-05.md`
  - `docs/agents/designs/78-jangar-capital-warrant-issuer-and-route-independent-order-admission-2026-05-05.md`
  - `81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
  - `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
  - `80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`
  - `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
  - `79-torghut-capital-holdbacks-and-profit-repair-ledger-2026-05-05.md`
  - `docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`
  - `78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md`
  - `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
  - `77-torghut-profit-admission-cells-and-materialized-evidence-contract-2026-05-05.md`
  - `docs/agents/designs/72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
  - `77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md`
  - `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`
  - `76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`
  - `docs/agents/designs/71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`
  - `75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md`
  - `docs/agents/designs/70-jangar-promotion-authority-ledger-and-rollout-rehearsal-cells-2026-05-05.md`
  - `75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md`
  - `docs/agents/designs/70-jangar-evidence-epoch-admission-and-rollout-quarantine-2026-05-05.md`
  - `72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`
  - `docs/agents/designs/67-jangar-runtime-evidence-epochs-and-artifact-parity-gates-2026-05-05.md`
  - `75-torghut-profit-actuation-cells-and-capital-guardrail-marketplace-2026-05-05.md`
  - `docs/agents/designs/70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md`
  - `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`
  - `docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`
  - `73-torghut-profit-evidence-clock-and-capital-veto-contract-2026-05-05.md`
  - `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
  - `72-torghut-proof-exchange-and-data-firebreak-contract-2026-05-05.md`
  - `docs/agents/designs/67-jangar-runtime-cells-and-rollout-backpressure-contract-2026-05-05.md`
  - `72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md`
  - `docs/agents/designs/67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md`
  - `53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
  - `54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`
  - `64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`
  - `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
  - `63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
  - `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
  - `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
  - `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
  - `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
  - `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
  - `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
  - `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`
  - `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
  - `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
  - `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
  - `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
  - `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
  - `53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
  - `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
  - `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
  - `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
  - `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
  - `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
  - `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
  - `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
  - `44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
- `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `72-torghut-proof-exchange-and-data-firebreak-contract-2026-05-05.md`
- `73-torghut-profit-evidence-clock-and-capital-veto-contract-2026-05-05.md`
- `75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md`
- `75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md`
- `76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`
- `77-torghut-profit-admission-cells-and-materialized-evidence-contract-2026-05-05.md`
- `77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md`
- `78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md`
- `79-torghut-capital-holdbacks-and-profit-repair-ledger-2026-05-05.md`
- `80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`
- `81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
- `82-torghut-order-admission-warrants-and-replay-capital-auction-2026-05-05.md`
- `83-torghut-profit-runway-consumer-and-hypothesis-capital-auction-2026-05-05.md`
- `84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`
- `85-torghut-profit-escrow-repair-auction-and-capital-authority-2026-05-05.md`
- `85-torghut-proof-fresh-profitability-governor-and-causal-replay-quarantine-2026-05-05.md`
- `86-torghut-profit-repair-auction-and-proof-runway-consumer-2026-05-05.md`
- `86-torghut-profit-debt-ledger-and-repair-sla-experiments-2026-05-05.md`
- `87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`
- `87-torghut-capital-lease-consumer-and-profit-repair-marketplace-2026-05-05.md`
- `88-torghut-profit-slo-lanes-and-session-replay-governor-2026-05-05.md`
- `88-torghut-session-proof-liquidity-and-hypothesis-market-maker-2026-05-05.md`
- `88-torghut-session-proof-budget-consumer-and-capital-reentry-contract-2026-05-05.md`
- Cross-system source of truth:
  - `docs/agents/designs/86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`
  - `90-torghut-proof-receipt-router-and-capital-query-firebreak-2026-05-05.md`
  - `docs/agents/designs/85-jangar-proof-debt-exchange-and-rollout-credit-windows-2026-05-05.md`
  - `89-torghut-zero-notional-proof-runway-and-profit-debt-exchange-2026-05-05.md`
  - `docs/agents/designs/84-jangar-material-action-settlement-and-proof-budget-cutover-2026-05-05.md`
  - `88-torghut-session-proof-budget-consumer-and-capital-reentry-contract-2026-05-05.md`
  - `docs/agents/designs/84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md`
  - `88-torghut-profit-slo-lanes-and-session-replay-governor-2026-05-05.md`
  - `docs/agents/designs/84-jangar-evidence-liquidity-router-and-stale-digest-quarantine-2026-05-05.md`
  - `88-torghut-session-proof-liquidity-and-hypothesis-market-maker-2026-05-05.md`
  - `docs/agents/designs/83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
  - `87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`
  - `docs/agents/designs/83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
  - `87-torghut-capital-lease-consumer-and-profit-repair-marketplace-2026-05-05.md`
  - `docs/agents/designs/82-jangar-proof-runway-cutover-and-consumer-authority-2026-05-05.md`
  - `86-torghut-profit-repair-auction-and-proof-runway-consumer-2026-05-05.md`
  - `docs/agents/designs/82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
  - `86-torghut-profit-debt-ledger-and-repair-sla-experiments-2026-05-05.md`
  - `docs/agents/designs/81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`
  - `85-torghut-profit-escrow-repair-auction-and-capital-authority-2026-05-05.md`
  - `docs/agents/designs/81-jangar-action-class-proof-fuses-and-quant-health-quarantine-2026-05-05.md`
  - `85-torghut-proof-fresh-profitability-governor-and-causal-replay-quarantine-2026-05-05.md`
  - `docs/agents/designs/80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
  - `84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`
  - `docs/agents/designs/79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
  - `83-torghut-profit-runway-consumer-and-hypothesis-capital-auction-2026-05-05.md`
  - `docs/agents/designs/78-jangar-capital-warrant-issuer-and-route-independent-order-admission-2026-05-05.md`
  - `82-torghut-order-admission-warrants-and-replay-capital-auction-2026-05-05.md`
  - `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
  - `81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
  - `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
  - `80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`
  - `docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`
  - `79-torghut-capital-holdbacks-and-profit-repair-ledger-2026-05-05.md`
  - `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
  - `78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md`
  - `docs/agents/designs/72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
  - `77-torghut-profit-admission-cells-and-materialized-evidence-contract-2026-05-05.md`
  - `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`
  - `77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md`
  - `docs/agents/designs/71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`
  - `76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`
  - `docs/agents/designs/70-jangar-promotion-authority-ledger-and-rollout-rehearsal-cells-2026-05-05.md`
  - `75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md`
  - `docs/agents/designs/70-jangar-evidence-epoch-admission-and-rollout-quarantine-2026-05-05.md`
  - `75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md`
  - `docs/agents/designs/67-jangar-runtime-evidence-epochs-and-artifact-parity-gates-2026-05-05.md`
  - `72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`
  - `docs/agents/designs/70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md`
  - `75-torghut-profit-actuation-cells-and-capital-guardrail-marketplace-2026-05-05.md`
  - `docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`
  - `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`
  - `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
  - `docs/agents/designs/67-jangar-runtime-cells-and-rollout-backpressure-contract-2026-05-05.md`
  - `docs/agents/designs/67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md`
  - `72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md`
  - `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
  - `64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`
  - `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
  - `63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
  - `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
  - `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
  - `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
  - `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
  - `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
  - `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
  - `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
  - `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
  - `docs/agents/designs/58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`
  - `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
  - `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
  - `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
  - `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
  - `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
  - `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
  - `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
  - `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
  - `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
  - `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- Discover stage merge anchor:
  - `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
  - `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- Evidence sync: `14-legacy-gap-disposition-map-2026-03-03.md` (signed v4/v5 disposition completeness)
- Rollout status: v6 pack controls are represented by merged runtime/control-plane closure phases in `main` (`#3921` through `#3960`).

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Current reading order

For current corpus navigation across active contract docs versus historical closeout records, use:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`

## Historical closeout note (2026-03-09)

The March 3 completion record remains useful as a dated closure milestone, but it should not be read as "nothing important remains."

Current source-state priority is narrower:

- deterministic runtime closure is materially landed;
- freshness discovery and proof persistence are still too brittle;
- recurring empirical prove-and-promote automation remains blocked on those truth surfaces.

## May 5, 2026 Proof Authority Refresh

The current source-of-truth pair for the Jangar control-plane plan lane and Torghut capital handoff is:

- `docs/agents/designs/84-jangar-material-action-settlement-and-proof-budget-cutover-2026-05-05.md`
- `88-torghut-session-proof-budget-consumer-and-capital-reentry-contract-2026-05-05.md`

The supporting SLO-arbiter and session-liquidity pair remains part of the May 5 control-plane evidence chain:

- `docs/agents/designs/84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md`
- `88-torghut-profit-slo-lanes-and-session-replay-governor-2026-05-05.md`
- `docs/agents/designs/84-jangar-evidence-liquidity-router-and-stale-digest-quarantine-2026-05-05.md`
- `88-torghut-session-proof-liquidity-and-hypothesis-market-maker-2026-05-05.md`

The current source-of-truth references for the Torghut quant discover lane are:

- `87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`
- `docs/agents/designs/83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
- `85-torghut-proof-fresh-profitability-governor-and-causal-replay-quarantine-2026-05-05.md`
- `docs/agents/designs/81-jangar-action-class-proof-fuses-and-quant-health-quarantine-2026-05-05.md`

Read these as the active handoff contract before using older May 5 proof-ledger variants. The refreshed evidence is
more precise than the early-day snapshot: Torghut live and sim revisions are serving, schema proof is current, and
runtime liveness is good, but readiness remains degraded, Jangar quant-health still times out, empirical proof jobs are
stale, and runtime profitability has decisions without execution or TCA samples. The design consequence is unchanged
but sharper: repair and replay stay open, paper/live widening requires fresh action-class authority and fresh profit
proof, and blocked market time should be spent through zero-notional session proof budgets rather than ad hoc repair.

## Recent Updates

- `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md` now records the landed hypothesis
  governance tables and the proving-lane schema choices.
- `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md` now records the implemented runtime-window and
  capital-stage contract used by the doc29 proof lane.
- `29-code-investigated-vnext-architecture-reset-2026-03-06.md` now includes the doc29 closeout record, the exact
  smoke and full-session replay ids, and the final `9/9` gate-satisfaction result.
- `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md` now distinguishes the March 6 live-state
  baseline from the March 7 implementation closeout, while keeping live promotion as an operator-controlled decision.
- `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md` now anchors the target-state design in the
  actual proof results and the full-session replay profitability nuance.
- `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md` now records the next
  recommendation iteration, updated on `2026-03-09` to reflect source reality: heartbeat-backed dependency quorum,
  manifest validation, persistence, and status surfacing are already in-tree, so the remaining priority is
  authoritative empirical evidence generation plus recurring prove-and-promote automation.
- `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md` now turns that priority into a standalone
  implementation contract that reuses the existing empirical manifest/persistence/status surfaces and makes scaffold
  parity/Janus outputs non-authoritative by design.
- `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md` now replaces query-derived freshness and aggregate
  zero-heavy readiness with a producer-authored control-plane ledger plus hypothesis-scoped proof bundles, grounded in
  the March 14 live state where Jangar freshness queries were memory-bound and Torghut empirical jobs remained absent.
- `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md` now finalizes the discover-to-plan
  transition with explicit segment-scoped rollout design, profitability mesh decision gates, and explicit engineer/deployer
  rollout and rollback handoff expectations.
- `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md` records the latest discover assessment,
  failure-mode evidence, and merged-PR lineage for a concrete handoff from architect to engineer/deployer.
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md` now binds the v6 Torghut lane to the
  March 19 cross-system source-of-truth architecture, replaces mixed promotion vocabulary with
  `observe/canary/live/scale/quarantine`, and makes scheduler/status parity plus options-bootstrap gating explicit.
- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md` now turns the March 19 mixed-state
  runtime evidence into one submission-council contract, lane-local profit cells, and an options bootstrap escrow that
  keeps import-time DB/image failures from masquerading as general profitability truth.
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md` now turns the March 19
  live contradictions into a stricter capital contract: non-observe capital requires an expiring profit reservation,
  a healthy schema witness, and owned simulation-slot capacity.
- `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md` now makes that capital
  contract hypothesis-local: each sleeve carries segment requirements, evidence expiry, overlap caps, and typed
  alert-driven deallocation.
- `53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md` now turns the March 27
  data-availability reality into one concrete proof program: Kafka retention is the bounded bootstrap source,
  immutable replay bundles are the durable truth surface, and `>= $250/day` remains blocked until archive-backed
  historical and paper gates pass.
- `108-torghut-proof-repair-closure-receipts-and-profit-settlement-2026-05-06.md` now makes repair finality explicit:
  empirical backfills, quant republishes, submission rehearsals, hypothesis requalification, and TCA refreshes only
  retire capital blocks when Torghut emits before/after proof receipts that Jangar can consume.
- `docs/agents/designs/104-jangar-repair-closure-receipts-and-settlement-finality-2026-05-06.md` now adds the companion
  Jangar rule: completed repair jobs move proof gaps to receipt-pending, not settled, until source-qualified closure
  receipts recompute the material-action settlement board.
- `54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md` now turns the retained March 16
  through March 27 ClickHouse surface into one concrete strategy-and-proof contract: separate continuation,
  breakout, and rebound sleeves, a frozen March 23 through March 27 holdout week, and a safe query discipline that
  avoids memory-bound raw ClickHouse aggregates.
- `67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md` now provides one onboarding glossary for the
  current Torghut runtime, replay, decision-persistence, and profitability vocabulary so a new engineer can map terms
  directly to active code paths and diagnostics.
- `69-torghut-harness-v2-strategy-discovery-and-whitepaper-research-factory-2026-04-07.md` now defines the next
  research iteration after the promoted breakout-plus-washout composite: fail discovery closed on stale tape, replace
  scalar replay penalties with a constrained multi-objective frontier, move from sleeve-first sweeps to family
  templates plus veto controllers, and turn whitepaper indexing into relation-aware claim extraction and
  experiment-spec generation.
- `70-torghut-mlx-autoresearch-and-apple-silicon-research-lane-2026-04-10.md` now defines the next local research
  lane: adapt the discipline of `karpathy/autoresearch` to Torghut, keep the mutation surface narrow and
  ledger-backed, use Apple MLX for GPU-accelerated candidate generation on Apple Silicon, and keep scheduler-v3
  parity, approval replay, and shadow validation as the only promotion authority.
- `71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md` now turns the whitepaper,
  strategy-factory, MLX, portfolio-sleeve, and runtime-closure pieces into one implementation contract for a
  production autoresearch epoch targeting a `$500/day` post-cost portfolio candidate.
- `72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md` now binds that profit target to
  current cluster truth: Jangar runtime authority, Torghut service/data health, artifact platform parity, and portfolio
  proof must share one evidence epoch before research or capital stages advance.
- `72-torghut-proof-exchange-and-data-firebreak-contract-2026-05-05.md` now turns the May 5 live assessment into the
  next architecture contract: route-time proof compilation moves behind a bounded proof exchange, lane-local data
  firebreaks block only the affected hypotheses, and non-shadow capital requires unexpired proof tied to Jangar
  runtime-cell receipts.
- `docs/agents/designs/67-jangar-runtime-cells-and-rollout-backpressure-contract-2026-05-05.md` now binds Jangar
  rollout safety to runtime cells, receipt digests, and proof-read backpressure so serving readiness, dispatch,
  deploy verification, and Torghut promotion stop re-deriving authority from broad route-time status.
- `73-torghut-profit-evidence-clock-and-capital-veto-contract-2026-05-05.md` now binds live capital to lane-local
  evidence clocks: Jangar authority, market-context freshness, schema lineage, execution revision state, and
  hypothesis promotion evidence must agree before non-observe capital can move.
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md` now separates Jangar
  serving readiness from promotion authority with evidence clocks and rollout vetoes for dispatch, schedule launch,
  deploy widening, and Torghut capital promotion.
- `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md` now turns the
  evidence-clock and rollout-fuse stack into one action-class settlement authority, including data-proof adapters for
  unprivileged database assessment and route-specific freshness failures.
- `81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md` now makes Torghut reconcile
  live-submission liveness against Jangar settlement, profit clocks, empirical freshness, market context, signal
  continuity, and rollback state before non-shadow capital can be treated as promotable.
- `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md` now makes profitability promotion
  cell-scoped: every non-observe capital request must cite one profit cell and one fresh Jangar evidence escrow, with
  stale options, missing autoresearch evidence, failed simulation revisions, and blocked control-plane escrows recorded
  as explicit vetoes.
- `docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md` now turns the latest
  control-plane assessment into a concrete Jangar contract: compile durable evidence escrows, route degraded facts into
  repair cells, keep serving readiness separate from promotion authority, and enforce read-budgeted database probes.
- `72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md` now turns the May 5 live-state
  evidence into the active profitability safety contract: route-time proof scans move behind query firebreaks,
  lane-local proof receipts become promotion authority, and Jangar consumes those receipts as evidence-epoch proof
  cells before non-observe capital can advance.
- `docs/agents/designs/67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md` now defines the
  companion Jangar control-plane direction: serving, dispatch, deploy verification, and Torghut promotion project the
  same durable evidence epoch rather than recomputing independent route-time truth.
- `75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md` now records the May 5 discover
  evidence and selects cross-plane evidence epochs plus hypothesis-local profit cells as the next architecture move:
  Torghut promotion must prove runtime authority, data freshness, image portability, and post-cost contribution in one
  receipt chain before any non-observe capital can advance.
- `105-torghut-proof-provenance-firewall-and-profit-lease-graduation-2026-05-06.md` now makes proof source identity a
  capital gate: fresh equity TA can support observation, but paper/live promotion needs current empirical jobs, non-empty
  quant/profit proof, measured rejection drag, options data readiness when relevant, and a matching Jangar action lease.
- `docs/agents/designs/101-jangar-evidence-provenance-firewall-and-lease-graduation-contract-2026-05-06.md` now records
  the companion Jangar control-plane rule: failure-domain leases may only hold dispatch, rollout, merge, or Torghut
  capital when the evidence resource is source-qualified, so arbitrary runner pod suffixes cannot masquerade as
  database outage evidence.
- `77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md` now records the latest May 5
  discover evidence where liveness stayed green but Torghut `/readyz`, Torghut `/trading/status`, Jangar control-plane
  status, and Jangar quant health breached route budgets; it makes bounded proof projections and settled profit cells
  the active handoff contract for engineer and deployer stages.
- `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md` now defines the companion
  Jangar layer: serving can stay available for repair while dispatch, deploy widening, review ingest, and Torghut
  promotion fail closed on missing runtime kits, route-budget breaches, stale Torghut projections, or unresolved
  deleted-ref review evidence.
- `docs/agents/designs/70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md` now turns Jangar evidence
  escrow into action-specific dispatch, schedule-launch, deploy-widening, repair-unblock, and Torghut platform promotion
  decisions that work under partial deployer RBAC.
- `75-torghut-profit-actuation-cells-and-capital-guardrail-marketplace-2026-05-05.md` now turns Torghut profit cells
  into capital actuation candidates whose marketplace score consumes Jangar actuation, cell-local freshness, empirical
  proof, simulation parity, post-cost edge, slippage, and rollback readiness.
- `75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md` now turns the latest plan assessment into the
  active Torghut implementation contract: non-observe capital requires one profit authority ledger entry, one Jangar
  authority ledger id, and a successful rehearsal cell for the requested capital state.
- `docs/agents/designs/70-jangar-promotion-authority-ledger-and-rollout-rehearsal-cells-2026-05-05.md` now defines
  the companion Jangar contract: serving, dispatch, rollout, and Torghut promotion authority must project from a
  durable promotion authority ledger with bounded read budgets and repair cells.
- `76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md` now extends the Jangar projection broker
  direction into Torghut: non-observe capital consumes one Jangar `torghut_profit` projection, all trading routes cite
  one profit receipt id, and stale market-context domains block only lanes that declare those dependencies.
- `docs/agents/designs/72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md` now
  closes the runnable-work gap after evidence projection: schedules, generated ConfigMaps, runtime kits, workspace
  PVCs, and Torghut profit-read evidence must be sealed into one materialized proof before dispatch or promotion can
  proceed.
- `77-torghut-profit-admission-cells-and-materialized-evidence-contract-2026-05-05.md` now makes Torghut capital
  authority hypothesis-local: each account/window/lane consumes Jangar materialized proof plus schema, quant,
  market-context, empirical, signal, and TCA evidence before canary or scale decisions are allowed.
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md` now turns the latest
  discover evidence into an expiring Jangar lease model: serving can stay available while stale stages, degraded
  execution trust, and stale Torghut proof hold or block action consumers.
- `78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md` now binds live and simulation capital
  routing to account/window settlements, profit verdict cells, and route-specific receipts so stale empirical jobs,
  degraded quant ingestion, sim schema drift, and TCA breaches cannot be mistaken for trade permission.
- `79-torghut-capital-holdbacks-and-profit-repair-ledger-2026-05-05.md` now consumes Jangar failure-domain leases as
  capital holdbacks and adds a Profit Repair Ledger so expired Jangar/database/route/proof leases block non-shadow
  capital while observe/shadow evidence and high-value repair work continue under explicit guardrails.
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md` now makes the next step
  explicit: non-observe capital depends on one certificate that consumes Jangar witness quorum, Jangar market-context
  and quant evidence, toggle parity, and typed options auth/bootstrap escrow rather than local gate optimism.
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md` now turns that certificate into a
  sleeve-level capital-allocation contract: every non-observe capital move depends on one lease id, every required
  segment is queryable, and falsification events revoke leases deterministically instead of letting stale evidence ride.
- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md` now removes the
  remaining control-plane optimism gap by making `Swarm.status`, `/ready`, and Jangar control-plane status project the
  same admission receipt rather than independently summarizing stale or partial truth.
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md` now turns those lease inputs
  into one durable settlement record per hypothesis and account, removes generic quant-health fallback as valid
  authority, and makes lane-specific capability loss explicit.
- `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md` now defines the next profitability step: Torghut
  must consume typed Jangar capability leases, settle one lane-local profit clock per hypothesis/account window, and
  keep scheduler, `/readyz`, and `/trading/status` on the same lease digest.
- `56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md` records the discover-stage rationale that
  led into the later capability-lease, reserve, and profit-cohort contracts by making route-time capital truth,
  falsification, and replayable profit evidence explicit.
- `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md` now turns those profit clocks
  into a replayable economic control surface: every non-observe capital move must cite one profit cohort and one
  authority session, and degraded-mode upside must be spent from bounded freshness insurance rather than generic
  optimism.
- `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md` now turns the March 20 live-state
  evidence into lane-local balance sheets, dataset seats, and explicit freshness-bond probe capital so Torghut can
  allocate scarce capital by evidence quality instead of one route-time blocked answer.
- `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md` now turns mixed March 20 evidence
  into replayable lane-scoped seats plus a bounded profit-repair exchange, and it makes immutable dataset and signal
  evidence a prerequisite for degraded-mode capital.
- `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md` now adds the next
  profitability layer: Torghut must settle one passport per lane, price capability quality explicitly, and allocate
  only bounded probe capital when degraded-but-usable evidence still exists.
- `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md` now makes the March 20 plan-stage
  failure explicit: Torghut already has typed evidence surfaces, but it still prices them through one global route-time
  gate instead of durable lane-local contracts.
- `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md` now turns the next gap into a concrete
  architecture contract: every lane gets one durable lane book, expensive evidence paths open bounded firebreaks, and
  status/readiness/scheduler must reuse the same ids.
- `63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md` now takes the next step: lane authority is
  bound to explicit windows and funded escrows so stale-but-truthful evidence, schema warnings, and query-cost debt do
  not collapse the whole portfolio into one route-time answer.
- `64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md` now defines the next plan-stage
  move: lane windows stay the authority model, but cutover is phased through typed quant-route parity, session-aware
  escrow semantics, and lane-by-lane enforcement instead of one portfolio-wide switch.
- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md` now turns the remaining
  control-plane gap into a concrete rollout contract: serving, stage dispatch, and deploy verification must agree on
  one active recovery epoch, and queued work bound to retired epochs must be superseded before launch.
- `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md` now
  turns that design into the current implementation plan: shadow compile first, then seal and reseat, then make
  dispatch and rollout fail closed on retired or unsealed backlog truth.
- `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md` now defines the
  next control-plane step: typed capability receipts plus explicit binding sets that force `/ready`, deploy
  verification, and Torghut consumers to share the same receipt digest and freshness contract.
- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md` now separates
  serving readiness from promotion authority, compiles durable capsules, and stops stale promotion state from
  deadlocking fresh control-plane rollouts.
- `docs/agents/designs/57-jangar-authority-capsules-and-route-parity-contract-2026-03-20.md` records the
  discover-stage route-parity decision that fed the later readiness-class, cutover, and authority-session contracts.
- `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md` now turns those
  capsules into one durable authority session and rollout-lease contract so `/ready`, status, deploy verification, and
  downstream consumers stop re-deriving control-plane truth per request.
- `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md` now makes the
  next control-plane step explicit: rollout health no longer counts as execution proof on its own, and stale-stage
  debt plus runtime completeness become durable receipt and recovery-cell contracts.
- `docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md` now closes the next
  remaining gap above sessions and recovery ledgers by making runtime completeness a first-class control-plane subject
  and binding consumers to passport ids that include both authority truth and executable runtime kits.
- `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md` now makes
  runtime completeness and stale-stage debt durable enough to stop pretending rollout health implies stage executability.
- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md` now takes
  the next step: Jangar stops treating one generic route as the authority surface for every consumer and instead
  compiles fast typed projections plus latency-class admissions for serving, Torghut quant, deploy verification, and
  handoff paths.
- `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md` now turns incomplete rollout
  evidence into a first-class veto by requiring fresh witness mirrors for rollout, stage health, and consumer
  acknowledgement before Jangar may emit promotion-friendly authority.
- `53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md` now moves the final live-capital authority
  out of ephemeral gate payloads and into durable capital leases backed by Jangar admission receipts, profit-trial
  evidence bundles, and typed bootstrap firebreaks.
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
  now closes the remaining route/runtime contradiction by making Jangar compile authoritative admission receipts and a
  rollout shadow that every readiness and promotion consumer must reuse.
- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md` now extends the
  March 19 authority-ledger work by requiring consumer acknowledgement of rollout epochs and by turning Huly transport
  failures into explicit segment circuit breakers rather than implicit fatal preconditions.
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
  now turns segment health into durable control-plane truth with freshness, evidence refs, consumer acknowledgement,
  and replayable collaboration outbox semantics.
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md` now replaces permissive local
  live-gate truth with Jangar-issued promotion certificates, segment-local firebreaks, and explicit engineer/deployer
  acceptance gates for options/data failures.
- `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md` now defines segment-local
  control-plane authority and scoped rollout semantics to prevent watch noise from becoming global rollout blockers.
- `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md` now defines multi-horizon profitability
  lanes, capital-budget-aware progression, and demotion guardrails to move from static safety to measurable profit growth.
- `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md` defines the full architecture merge program that
  binds segment-aware control-plane operations with hypothesis profitability lane governance.
- `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md` now records the
  discover-stage merge contract with evidence and explicit engineer/deployer acceptance gates.
- `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md` now records the production design for a
  separate Alpaca options ingest and TA lane, grounded in the current equity-only Torghut runtime and cluster state.
- `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md` now turns that architecture into explicit event,
  storage, identity, and SLO contracts for implementation.
- `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md` now records the remaining production
  hardening work for the deployed options lane: market-open validation, `opra` shadow promotion, ClickHouse schema
  bootstrap, and options-specific guardrails.
- `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md` now defines the lane-aware simulation,
  replay, and profitability-proof system required before any options strategy can request live capital.
- `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md` now defines the eventual trading-runtime
  integration contract for options signals, pricing, risk, lifecycle handling, and broker execution boundaries.

## Purpose

Translate the "Beyond TSMOM" research synthesis into implementation-grade Torghut designs that can be executed by engineers and AgentRuns with explicit contracts, safety gates, and rollout criteria.

This pack is positioned as the next architecture layer above:

- `docs/torghut/design-system/v5/12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md`
- `docs/torghut/design-system/v5/13-fundamentals-news-codex-spark-agent-pipeline-2026-02-26.md`
- `docs/torghut/design-system/v5/14-dspy-jangar-openai-full-rollout-2026-02-27.md`

## Non-Negotiable Invariants

- Deterministic risk and policy controls remain final authority.
- DSPy review runtime uses Jangar OpenAI-compatible endpoints (`/openai/v1/chat/completions`) with spark model for live LLM inference.
- Legacy runtime network LLM call paths are removed from the decision codepath once cutover is complete.
- Contamination-aware, forward-only evaluation is mandatory before promotion.
- Every promotion and rollback action must be evidence-backed and reproducible.

## Document Set

1. `01-beyond-tsmom-system-architecture-and-latency-model.md`
2. `02-regime-adaptive-expert-router-design.md`
3. `03-dspy-llm-decision-layer-over-jangar.md`
4. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
5. `05-evaluation-benchmark-and-contamination-control-standard.md`
6. `06-production-rollout-operations-and-governance.md`
7. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
8. `08-profitability-research-validation-execution-governance-system.md`
9. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
10. `10-timesfm-foundation-model-router-parity.md`
11. `11-deeplob-bdlob-microstructure-intelligence.md`
12. `12-posthog-agent-observability-and-error-tracking-production-design.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
21. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
22. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
23. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
24. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
25. `23-trading-startup-readiness-warmup-2026-03-04.md`
26. `26-database-migration-lineage-and-readiness-contract-2026-03-05.md`
27. `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
28. `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
29. `29-code-investigated-vnext-architecture-reset-2026-03-06.md`
30. `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md`
31. `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
32. `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
33. `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
34. `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
35. `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
36. `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
37. `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md`
38. `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
39. `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
40. `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
41. `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
42. `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
43. `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
44. `44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
45. `46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`
46. `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
47. `48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`
48. `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
49. `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
50. `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
51. `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
52. `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
53. `53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
54. `54-torghut-research-backed-sleeves-and-this-week-holdout-proof-2026-03-27.md`
55. `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
56. `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
57. `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
58. `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
59. `56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md`
60. `57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-contract-2026-03-20.md`
61. `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
62. `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`
63. `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
64. `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
65. `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`
66. `72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md`

## Recommended Build Order

1. `05-evaluation-benchmark-and-contamination-control-standard.md`
2. `08-profitability-research-validation-execution-governance-system.md`
3. `09-external-benchmark-parity-suite-ai-trader-fev-gift.md`
4. `01-beyond-tsmom-system-architecture-and-latency-model.md`
5. `10-timesfm-foundation-model-router-parity.md`
6. `11-deeplob-bdlob-microstructure-intelligence.md`
7. `02-regime-adaptive-expert-router-design.md`
8. `03-dspy-llm-decision-layer-over-jangar.md`
9. `04-alpha-discovery-and-autonomous-improvement-pipeline.md`
10. `06-production-rollout-operations-and-governance.md`
11. `12-posthog-agent-observability-and-error-tracking-production-design.md`
12. `07-hmm-regime-state-and-autonomous-llm-control-plane-2026-02-28.md`
13. `13-production-gap-closure-master-plan-2026-03-03.md`
14. `14-legacy-gap-disposition-map-2026-03-03.md`
15. `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
16. `16-dspy-llm-live-gate-root-cause-and-rollout-2026-03-04.md`
17. `16-emergency-stop-reason-normalization-and-recovery-consistency-2026-03-04.md`
18. `17-emergency-stop-reason-normalization-and-recovery-stability-2026-03-04.md`
19. `18-trading-readiness-and-rollout-stability-2026-03-04.md`
20. `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
21. `20-trading-allocator-config-surface-hardening-2026-03-04.md`
22. `21-schema-fingerprint-and-freshness-for-database-readiness-2026-03-04.md`
23. `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
24. `23-readiness-schema-drift-diagnostics-2026-03-04.md`
25. `23-trading-startup-readiness-warmup-2026-03-04.md`
26. `26-database-migration-lineage-and-readiness-contract-2026-03-05.md`
27. `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
28. `28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
29. `29-code-investigated-vnext-architecture-reset-2026-03-06.md`
30. `30-live-state-disposition-and-implementation-rollout-gates-2026-03-06.md`
31. `31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
32. `32-authoritative-alpha-readiness-and-empirical-promotion-closeout-2026-03-08.md`
33. `38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
34. `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`
35. `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
36. `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
37. `36-options-simulation-replay-and-profitability-proof-lane-2026-03-08.md`
38. `37-options-trading-runtime-execution-and-risk-integration-2026-03-08.md`
39. `39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
40. `40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
41. `41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
42. `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md`
43. `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
44. `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
45. `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
46. `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
47. `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
48. `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
49. `66-torghut-property-based-testing-coverage-and-lint-hardening-2026-03-28.md`
50. `67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`
51. `72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`
52. `74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`
53. `89-torghut-hypothesis-warrant-ledger-and-profit-runway-2026-05-05.md`
54. `97-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`
55. `98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md`
56. `99-torghut-hypothesis-repair-council-and-evidence-credit-ladder-2026-05-05.md`
57. `115-torghut-proof-spend-market-and-negative-evidence-consumer-2026-05-06.md`
58. `117-torghut-contradiction-priced-profit-repair-and-capital-readmission-2026-05-06.md`
59. `121-torghut-evidence-debt-tranches-and-profit-unblock-ladder-2026-05-06.md`
60. `122-torghut-profit-renewal-bids-and-capital-shadow-ledger-2026-05-06.md`
61. `123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md`
62. `124-torghut-data-plane-proof-quarantine-and-profit-renewal-fuse-2026-05-06.md`
63. `125-torghut-profit-priced-evidence-renewal-and-capital-reentry-ledger-2026-05-06.md`
64. `125-torghut-proof-renewal-train-and-capital-reentry-sequencer-2026-05-06.md`

## Why This Sequence

- Evaluation correctness and contamination safety must be locked first to avoid optimizing to invalid signals.
- Profitability must be treated as an operating system with strict stage contracts from research through governance.
- External benchmark parity should be established before broadening model families and execution intelligence.
- System architecture and routing design define data contracts used by the LLM and alpha-evolution layers.
- DSPy decision integration must be implemented on top of stable routing and deterministic gate interfaces.
- Autonomous strategy evolution should only be promoted after evaluation and serving contracts are stable.
- Production rollout and governance closes with explicit SLO, rollback, and incident controls.
- Live profitability must ultimately be governed by a database-backed hypothesis ledger, not only by static artifacts.
- PostHog observability design is sequenced late to instrument stable runtime paths and avoid telemetry contract churn.
- The hypothesis-led alpha readiness and profit circuit closes the remaining gap between runtime health and capital promotion, ensuring profitable scale-up is evidence-backed instead of inferred from process uptime.
- The code-investigated vNext architecture reset is sequenced last because it reframes the pack around the now-visible
  gap between control-plane completion and empirical alpha readiness, and it defines the contract for the next wave of
  implementation work.
- The live-state disposition comes after the reset because it converts the March 6 designs into an execution order for
  the current cluster and source state, separating what must be maintained from what can safely be implemented next.
- The proven autonomous quant system architecture comes last because it consolidates the earlier v6 work into the clean
  end-state topology: deterministic runtime authority, first-class mirrored simulation, generated empirical evidence,
  and time-gated live promotion.
- The authoritative empirical promotion evidence contract follows the closeout rationale because it translates the
  March 8 recommendation into an implementation-ready boundary around existing empirical manifest, persistence, and
  operator surfaces.
- The freshness-ledger and proof-mesh contract follows that boundary because the next operational problem is no longer
  "what counts as truthful empirical evidence?" but "how do control-plane freshness and per-hypothesis proof stay
  truthful under live load without depending on heavy scans and process-local counters?"
- The control-plane resilience contract now follows the freshness proof mesh because rollout failure modes must become scoped
  and observable before safe capital transitions can accelerate.
- The profitability guardrail architecture follows that resilience contract because safe capital growth is impossible if
  rollout scope is still a single global state channel.
- `42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md` introduces explicit mixed-failure decision trees and
  engineer/deployer handoff criteria to complete the joint architecture lane.
- The Alpaca options implementation contract set follows the architecture doc because options ingest is only safe to
  build once the concrete topic, storage, rate-limit, and identity contracts are fixed.
- Options hardening and `opra` promotion follow the implementation contract set because the lane now exists in
  production and must prove real-session behavior before strategy work is resumed.
- The options replay and profitability-proof lane follows hardening because simulation truth depends on a trustworthy
  live data contract and a session-proven production feed.
- The options trading-runtime integration comes last because it is only safe once both the market-data lane and the
  replay/proof lane are authoritative.
- `42-torghut-quant-control-plane-resilience-and-profitability-architecture-merge-contract-2026-03-15.md` is now the discover
  stage transition contract with explicit cluster/source/database assessment and rollout/rollback requirements.
- `46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md` and
  `47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md` convert the historical discovery stack into
  explicit per-hypothesis and per-lane profitability execution contracts for plan-stage implementation.
- `66-torghut-property-based-testing-coverage-and-lint-hardening-2026-03-28.md` adds the missing test-quality layer:
  property-based invariants, state-machine replay/runtime checks, and hard branch-coverage / lint gates for the
  service's trading core.
- `67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md` adds the missing onboarding layer: one current
  terminology and mechanics map for data flow, strategy flow, persistence, replay, and diagnostics.
- `72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md` comes after the research factory
  contracts because the current bottleneck is no longer candidate generation alone. Portfolio proof must be bound to
  the exact Jangar runtime authority, Torghut health, data freshness, and artifact parity that were current when the
  candidate was evaluated.
- `89-torghut-hypothesis-warrant-ledger-and-profit-runway-2026-05-05.md` is the current capital handoff contract. It
  converts blocked paper/live authority into zero-notional replay and hypothesis warrants while keeping all capital
  moves bound to fresh Jangar evidence epochs, empirical jobs, route proof, and measurable profit SLOs.
- `97-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md` follows the proof-feed contract because the
  current gap is producer-vs-consumer evidence disagreement. It makes Torghut emit a deterministic proof sample that
  Jangar can settle into separate serve, repair, swarm, paper-capital, and live-capital decisions.
- `98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md` adds the value layer: repairs must name
  the stale proof they reduce and the capital gate they make more decidable before Jangar should spend scarce launch
  capacity on them.
- `99-torghut-hypothesis-repair-council-and-evidence-credit-ladder-2026-05-05.md` is the discover-stage handoff for the
  current cluster state. It ranks zero-notional repairs by expected information value while keeping paper and live
  capital blocked until Jangar credits, empirical jobs, account-scoped quant health, signal lag, rejection attribution,
  and options proof are fresh.
- `115-torghut-proof-spend-market-and-negative-evidence-consumer-2026-05-06.md` follows the Jangar negative-evidence
  router because the current state has enough status to hold capital, but not enough economic structure to choose the
  next proof repair. It turns stale market context, scoped quant alerts, empirical debt, rollback-required hypotheses,
  and data-plane rollout ambiguity into ranked proof-spend bids before paper or live capital can reenter.
- `117-torghut-contradiction-priced-profit-repair-and-capital-readmission-2026-05-06.md` follows the Jangar
  contradiction-settlement ledger because the current state has recovered control-plane rollout health but still has
  conflicting capital evidence. It prices proof repairs by the Jangar settlement they close and keeps live notional at
  zero until empirical replay, account/window quant proof, market-context freshness, and settlement receipts are current.
- `121-torghut-evidence-debt-tranches-and-profit-unblock-ladder-2026-05-06.md` turns contradictory stale proof
  surfaces into debt tranches that Jangar can rank, repair, and retire before material action.
- `122-torghut-profit-renewal-bids-and-capital-shadow-ledger-2026-05-06.md` follows the Jangar repair admission
  governor because the current system can allow bounded repair while still holding material authority. It makes proof
  repairs compete as zero-notional bids and records their shadow capital impact before any paper or live readmission.
- `123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md` follows the Jangar empirical proof
  renewal clearinghouse because the current blocker has narrowed to stale empirical proof after rollout and watch
  reliability recovered. It turns stale jobs, empty account/window quant health, stale market context, and sim proof
  lane debt into typed claims and closure receipts before capital gates can move.
- `124-torghut-data-plane-proof-quarantine-and-profit-renewal-fuse-2026-05-06.md` follows the profit-renewal bid
  contract because the current cluster has a concrete downstream image/platform failure. Profit repairs now need
  data-plane image, runtime, route, and freshness witnesses before they can unlock paper or live capital.
- `125-torghut-profit-priced-evidence-renewal-and-capital-reentry-ledger-2026-05-06.md` follows the material-action
  repair-clearing lane because stale empirical proof, empty account/window quant health, and market-context drift must
  be priced as capital decisions before repair work can safely compete for scarce launch capacity.
- `125-torghut-proof-renewal-train-and-capital-reentry-sequencer-2026-05-06.md` follows the controller-witness and
  material-action contracts because the image/platform failure recovered, but normal dispatch still depends on a
  missing controller self-report while empirical, quant, and context proof remain stale. It sequences repair work so
  capital reentry is blocked by predecessor receipts instead of by manually interpreted status fragments.
- `129-torghut-bidirectional-quant-proof-receipts-and-profit-reentry-ledger-2026-05-06.md` follows the Jangar quant
  proof replication firebreak because the current cluster has recovered serving and rollout health while paper/live
  capital still lacks durable Torghut consumer evidence. It makes Torghut emit account/window/hypothesis receipts,
  persists hypothesis custody and zero-notional proof windows, and requires Jangar to agree on quant freshness before
  paper or live capital can reenter.
- `144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md` follows the endpoint-parity and
  profit-repair auction contracts because the current live state is no longer a total outage. Torghut can observe and
  repair, but TCA is stale, feature/drift counters are zero, forecast authority is registry-empty, and Jangar watch
  reliability is degraded. The contract ranks repairs by capital-state unlock while keeping paper and live notional at
  zero until Jangar state, TCA, feature/drift, forecast, and hypothesis guardrails are current.
- `145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md` follows the Jangar controller witness escrow
  contract because current repair authority is useful but under-priced. Torghut must rank repair work by measurable
  after-cost capital dividend, consume Jangar repair dividend receipts, and keep paper/live submission closed until TCA,
  quant ingestion, feature/drift, forecast, hypothesis, and submission-quorum gates are current.
- `146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md` follows the Jangar repair dividend
  handoff contract because Torghut can keep observe and zero-notional repair open, but paper/live capital needs one
  explicit quorum that binds Jangar repair dividends, TCA, quant ingestion, feature/drift, forecast, hypothesis, and
  submission-intent evidence before any capital route can graduate.
- `147-torghut-proof-escrow-hypothesis-repair-and-capital-settlement-2026-05-07.md` follows the least-privilege Jangar
  evidence escrow contract because the current cluster is available while capital proof remains repair-only. It ranks
  repairs by hypothesis, metric target, after-cost dividend, and Jangar escrow membership, keeping paper/live at zero
  notional until route-readable evidence can settle the current TCA, signal, feature, drift, market-context, and
  submission blockers.
- `165-torghut-outcome-priced-repair-market-and-capital-shadow-swaps-2026-05-07.md` follows the zero-notional repair
  packet and Jangar brownout-market contracts because the system is serving but still not capital-ready. It makes
  route, quant, market-context, empirical, and alpha repairs compete by measured after-cost unblock value while keeping
  all paper and live notional closed until before/after receipts and Jangar stage-freeze clearing exist.
- `167-torghut-scoped-profit-repair-options-and-freshness-debt-retirement-2026-05-07.md` follows the executable profit
  receipt and Jangar scoped evidence debt contracts because broad rollout health is no longer enough proof. It ranks
  zero-notional repair options by the scoped quant, market-context, empirical, route/TCA, hypothesis, and submission
  debts they retire before paper or live capital can move. The 2026-05-07 21:10Z refresh narrows the current before
  state to route/TCA repair, market-context staleness, degraded empirical jobs, account-scope bypass debt, and Jangar
  scoped-debt agreement, with all paper/live notional still held at zero.
- `180-torghut-dependency-priced-capital-frontier-and-session-reentry-2026-05-08.md` follows the route-yield frontier
  because the refreshed evidence shifted the primary risk from a route-only repair problem to a dependency-priced
  capital problem. Torghut remained readable while Jangar had a zero-pod brownout, scoped quant latest-store evidence
  was empty, market context was degraded, alpha readiness had zero promotion-eligible hypotheses, and proof floor held
  capital at zero. The contract makes Jangar availability, scoped quant health, market context, empirical evidence,
  alpha readiness, route/TCA, and submission toggles contribute explicit capital prices before any session can reenter
  paper or live action.
- `183-torghut-session-open-route-microcanaries-and-profit-evidence-notary-2026-05-08.md` follows the route-proven
  receipt and session-reentry contracts because the 2026-05-08 refresh shows recovered rollout health but still no
  revenue-active capital path. It selects paper-only route microcanaries and a profit evidence notary over slippage
  threshold loosening or a big-bang wait on large profit-escrow work. The first implementation milestone must repair
  scoped quant/TCA/alpha receipts, keep live notional at zero, and rank repairs by the value gates
  `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and
  `capital_gate_safety` before any `post_cost_daily_net_pnl` claim is allowed.
- `184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md` follows the route microcanary contract
  because serving health and route activity are still not enough proof for capital. It makes every paper/live proposal
  cite Jangar execution trust, quant freshness, route/TCA, forecast, alpha, and proof-floor receipts before a repair lot
  can move out of zero notional.
- `185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md` follows the execution-trusted settlement contract
  because the current runtime is serving but still `repair_only`: Torghut revision `00308` is running, database schema
  is current, quant latest metrics exist, but scoped pipeline stages and market-context domains are stale or missing.
  It defines the acceptance ledger that lets zero-notional repair work retire value-gate debt while preventing routeable
  candidate or capital claims until receipts settle and Jangar admission is current.
- `186-torghut-routeability-acceptance-cutover-and-fill-quality-loop-2026-05-08.md` follows the routeability acceptance
  ledger because the `2026-05-08T16:12Z` refresh shows the production cutover has not happened yet. Torghut revision
  `00311` is serving, Argo reports the relevant apps healthy, and the database contract is current at
  `0030_evidence_epochs`, but live status, revenue repair, and consumer evidence still expose
  `routeability_acceptance_ledger=null`, routeable candidates remain `0`, market context is degraded by stale news,
  scoped quant evidence can still lag or disappear by sample, and TCA is historical with no samples for several
  symbols. The contract makes the acceptance ledger a production payload requirement, ties every accepted lot to
  current fill-quality proof, and keeps paper/live capital closed until the cutover packet passes all value gates.
- `188-torghut-profit-repair-clearance-packets-and-market-context-slos-2026-05-12.md` follows the Jangar
  stage-clearance launch governor because the current system can emit current observe receipts while Jangar is frozen
  and Torghut remains zero-notional. It makes each market-context, empirical, route/TCA, promotion-table, and quant
  pipeline repair cite an expected unblock value, freshness SLO, Jangar packet ref, and zero-notional guardrail before
  the repair can spend launch capacity.
- `214-torghut-current-whitepaper-to-profitable-strategy-workflow-2026-05-16.md` is the current operator-facing
  workflow from whitepaper to live-eligible sleeve. It consolidates the active process into Mermaid diagrams and a
  stage-by-stage writeup: claims, hypothesis cards, checked `CandidateSpec`s, MLX ranking-only proposal authority,
  real replay evidence, portfolio optimization, profit oracle gates, runtime closure, paper/shadow proof, and live
  promotion constraints.
