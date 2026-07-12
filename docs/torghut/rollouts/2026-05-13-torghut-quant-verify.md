# Torghut quant release gate - 2026-05-13

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-13T12:58:41Z

## Owner update message

The Torghut quant release gate is green for deployment and still no-go for revenue-live capital. Main has advanced
through #6419, which promoted source `61111bd109d131e4bda0823e927c7b1bb3500d17` from #6415. The active runtime image is
`sha256:df7ed530147a827acfdf06902e47f535e5322ff1fff022f9f0c65b27acc1f9e1`; Argo reports `torghut` and
`torghut-options` `Synced` / `Healthy` at revision `07da331d95ca0ef2779108a00a877c5e718b2656`, and
`torghut-post-deploy-verify` run `25800295052` passed.

Runtime evidence is capital-safe but still repair-only. Source-serving proof converged, the repair receipt frontier now
has five dispatchable repair lots, and the repair-bid settlement ledger selected five lots with three dispatchable.
Revenue impact remains blocked by `hypothesis_not_promotion_eligible` and `simple_submit_disabled`;
`routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=1.0`, and `max_notional=0`.

## Governing requirement

- `docs/torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
  requires bounded zero-notional repair packets, routeability proof compaction, and `max_notional=0` while route warrants
  remain repair-only.
- `docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md` requires
  source commit, manifest digest, Argo revision, serving revision, and runtime contract receipts to converge before
  promoted capital can widen.
- `docs/torghut/design-system/v6/193-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md` requires repair
  receipt frontier evidence to keep post-cost profit, routeability, stale-evidence, execution-quality, and capital-safety
  gates explicit before any profit cutover.
- Runtime objective: increase routeable post-cost profit evidence and live trading readiness without weakening capital
  safety.

## PR selection

- #5412 `feat(torghut): add profit escrow runtime projections`
  - Already merged on 2026-05-08 as `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f`; it is no longer an open blocker.
- #6404 `docs(torghut): record quant release gate`
  - Selected as the only current open Torghut PR. It records the current production release gate and operator evidence.
  - Rebased onto current `main` after the #6419 promotion so the audit does not merge stale rollout claims.
- Current open PRs after Torghut runtime/promotions:
  - #6404 is this Torghut quant audit PR.
  - #6399 is a Jangar control-plane audit PR and is out of scope for the Torghut quant gate.
  - #6200, #6206, #6210, #6214, #6215, and #6219 are older automated release PRs and were not selected.

No open Torghut implementation or promotion PR remains after #6419. The release value now comes from preserving an
accurate audit record and naming the exact revenue blocker.

## PRs touched

- #6404 `docs(torghut): record quant release gate`
  - Rebased `codex/swarm-torghut-quant-verify` onto `origin/main` at
    `07da331d95ca0ef2779108a00a877c5e718b2656`.
  - Refreshed this audit file with current #6419 rollout and runtime evidence.
  - No runtime, manifest, or service code was changed.

## Comments and conflicts resolved

- #6404 has no review threads, no requested changes, is non-draft, and is mergeable after the rebase.
- No `@codex review` or `codex:review-request` comment was posted.
- No direct production workload mutation was made from the local shell. Runtime promotion went through PR merge and Argo
  CD reconciliation.

## Validation

- PASS: #6415 `feat(torghut): publish repair receipt frontier` checks included Torghut CI, Pyright,
  bytecode/lint/migration guard, pytest shards, coverage, quality signals, changed-file checks, semantic commits, and
  semantic PR title.
- PASS: #6419 `chore(torghut): promote image 61111bd1` checks included release manifest changes, Argo lint,
  kubeconform, deploy automerge enable, semantic commits, and semantic PR title.
- PASS: #6419 main `torghut-post-deploy-verify` run `25800295052` completed successfully for
  `9d8c288f9bb44233ed22c62bb2d155b6b204dbe5`.
- PASS: artifact `torghut-revenue-repair-25800295052-1` was downloaded and inspected.
- PASS: `kubectl -n argocd get application torghut torghut-options ...` reported both apps `Synced` / `Healthy` at
  `07da331d95ca0ef2779108a00a877c5e718b2656`.
- PASS: `kubectl -n torghut get pods -o wide` showed active Torghut, sim, options, TA, websocket, ClickHouse, and guardrail
  pods running, with expected completed jobs and stale autoresearch error pods recorded as residual evidence risk.

## Deployment evidence

- Argo CD:
  - `torghut`: `Synced`, `Healthy`, revision `07da331d95ca0ef2779108a00a877c5e718b2656`, operation `Succeeded` at
    `2026-05-13T12:56:43Z`.
  - `torghut-options`: `Synced`, `Healthy`, revision `07da331d95ca0ef2779108a00a877c5e718b2656`, operation `Succeeded`
    at `2026-05-13T12:53:17Z`.
- Image promotion:
  - Source commit: `61111bd109d131e4bda0823e927c7b1bb3500d17`.
  - Promotion commit: `9d8c288f9bb44233ed22c62bb2d155b6b204dbe5`.
  - Active digest: `sha256:df7ed530147a827acfdf06902e47f535e5322ff1fff022f9f0c65b27acc1f9e1`.
- Workload readiness:
  - `torghut-00350-deployment`: `2/2 Running`, zero restarts, serving the active digest.
  - `torghut-sim-00448-deployment`: `2/2 Running`, zero restarts, serving the active digest.
  - `torghut-options-catalog`: `1/1 Running`, zero restarts, serving the active digest.
  - `torghut-options-enricher`: `1/1 Running`, zero restarts, serving the active digest.
  - `torghut-ws`, `torghut-ws-options`, `torghut-ta`, `torghut-ta-sim`, and ClickHouse pods were running.
- Event review:
  - Startup/readiness probe warnings occurred during rollout warm-up.
  - Final revision events included `RevisionReady` and `LatestReadyUpdate` for `torghut-00350` and
    `torghut-sim-00448`.
  - Previous serving revisions scaled down after the latest revisions became ready.
  - No final CrashLoopBackOff, ImagePullBackOff, or restart churn was observed on active serving/options pods.

## Runtime and value-gate evidence

- Source-serving proof:
  - `source_serving_state=converged`.
  - `required_contract_count=6`, `observed_contract_count=6`, `missing_contract_count=0`,
    `schema_mismatch_count=0`.
- Repair receipt frontier:
  - `lot_count=8`, `dispatchable_lot_count=5`, `held_lot_count=3`.
  - `paper_requirement_pass_count=1`, `live_requirement_pass_count=0`.
  - Value gates covered: `post_cost_daily_net_pnl`, `routeable_candidate_count`,
    `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and `capital_gate_safety`.
- Repair-bid settlement:
  - `raw_repair_bid_count=38`, `compacted_lot_count=6`, `selected_lot_count=5`, `dispatchable_lot_count=3`.
  - `capital_decision=repair_only`, `routeable_candidate_count=0`.
- Routeability:
  - `accepted_routeable_candidate_count=0`.
  - `zero_notional_or_stale_evidence_rate=1.0`.
  - `route_reacquisition.state=repair_only`, with one probing symbol (`AAPL`), four blocked symbols, and three missing
    symbols.
- Profit and execution quality:
  - `business_state=repair_only`, `revenue_ready=false`.
  - `/readyz` is `degraded` because live submissions and the profitability proof floor remain blocked.
  - `profit_signal_quorum` has three `observe_only` quorums, `paper_candidate_count=0`,
    `routeable_candidate_count=0`, and `blocked_or_stale_evidence_count=13`.
  - TCA evidence has `order_count=7334`, `filled_execution_count=7245`, and
    `avg_abs_slippage_bps=13.8203637593029676` against `slippage_guardrail_bps=8`.
  - `fill_tca_or_slippage_quality` remains on hold for `active_session_execution_samples_stale` and
    `execution_tca_expected_shortfall_samples_missing_non_promoting`.
- Capital gate:
  - `live_submission_allowed=false`.
  - `live_submission_reason=simple_submit_disabled`.
  - `configured_live_promotion=false`.
  - `capital_stage=shadow`, `capital_state=zero_notional`, `max_notional=0`.

## Risks

- Runtime is not revenue-live. The smallest blocker preventing revenue impact is `simple_submit_disabled` with
  `hypothesis_not_promotion_eligible`; routeable candidates remain `0`.
- `/readyz` is degraded by design while Torghut is in repair-only zero-notional mode.
- Whitepaper autoresearch error pods remain visible, with one current autoresearch pod running; this is runtime evidence
  risk, not a GitOps promotion failure.
- TCA and routeability evidence are still insufficient for capital widening: execution TCA has stale active-session
  samples, missing expected-shortfall samples, and average absolute slippage above the configured guardrail.

## Rollback path

- Immediate GitOps rollback from the current promotion: revert #6419 or open a PR restoring the previous promoted digest
  `sha256:bc52f7830b8415fb24d92ce7babcfee8a91f872776472f2cf21cb809a0249c2a`, then let Argo CD reconcile.
- Source rollback: revert #6415 through a PR, allow `torghut-build-push` and `torghut-release` to publish a revert
  image, and verify `torghut-post-deploy-verify`.
- Runtime safety rollback: keep `max_notional=0`, keep live submissions disabled, and keep route-warrant consumption in
  repair-only mode until routeability, TCA, freshness, and alpha-readiness gates pass.

## Next action

The next revenue-impact gate is increasing `routeable_candidate_count` above `0` while preserving
`capital_gate_safety`. The smallest current blocker is `simple_submit_disabled` with
`hypothesis_not_promotion_eligible`; clear hypothesis blockers, repair route universe/TCA evidence, restore forecast
and promotion custody evidence, and keep submit disabled until acceptance lots clear.
