# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-12T17:10:02Z

## Release gate refresh - 2026-05-12T17:10Z

This section supersedes the 2026-05-08 snapshot for the current open Torghut quant release queue.

Governing design and runtime requirement:

- `docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md` keeps
  routeability and profit evidence observe-only until route, TCA, forecast, alpha-readiness, and external admission
  receipts settle.
- `docs/torghut/design-system/v6/185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md` requires unsettled
  routeability lots to keep `paper_notional_limit=0` and `live_notional_limit=0`.
- `docs/torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
  is the new architecture handoff for aligning evidence clocks before routeable profit candidates can carry capital.
- Runtime objective remains: increase routeable post-cost profit evidence and live trading readiness without weakening
  capital safety.

Open PR enumeration and merge decisions:

- #6196, `docs(torghut): define evidence clock dispatch architecture`, is merged at
  `69cab1cd5273074e00a0ead978a14013d712b0b7`. It was the selected low-risk docs/architecture item because it advances
  evidence-clock alignment for `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, and
  `capital_gate_safety` without changing runtime capital.
- #6127, `feat(torghut): add routeability acceptance ledger`, remains no-go. It is clean but stale against current
  main, changes 1,609 lines, and the mandatory Codex review gate still has only usage-limit responses from the Codex
  connector. Its last current-head review blocker is
  https://github.com/proompteng/lab/pull/6127#issuecomment-4408477842.
- #6182, `revert(torghut): rollback failed promotion 2d5e1bed...`, is not selected for merge. Current workload
  rollout evidence is mechanically stable on the promoted image, so the rollback remains a contingency PR rather than
  a release action. Do not merge it unless the live rollout crosses rollback criteria or the owner explicitly requests
  rollback.
- #6135, this audit PR, is the current release-gate evidence PR for the verify branch.

Merge and CI evidence:

- #6196 was merged on 2026-05-12T17:06:04Z at `69cab1cd5273074e00a0ead978a14013d712b0b7` after semantic commit and
  semantic PR title checks passed; deploy enable checks were skipped.
- #6127 visible checks from 2026-05-08 were green, including Torghut Pyright, bytecode/lint/migration guard, pytest
  shards, bytecode+pytest+coverage, quality signals, Jangar typecheck, and agents integration. Those checks are no
  longer sufficient for merge because main advanced to `69cab1cd` and Codex review is missing.
- #6182 checks are green for rollback-manifest validation, including argo-lint and kubeconform, but rollback is not the
  selected action while the current rollout remains workload-stable and capital-safe.

GitOps and rollout evidence after #6196:

- Current `main`: `69cab1cd5273074e00a0ead978a14013d712b0b7`.
- Argo `torghut`, `torghut-options`, and `jangar` are all `Synced` to `69cab1cd`.
- `torghut-options` and `jangar` are `Healthy`; `torghut` remains `Degraded`, so the final release gate is
  rollout-stable but not fully healthy.
- The latest Torghut sync operation succeeded at 2026-05-12T17:06:20Z. The manifest-bearing operation revision was
  `051fc392da8215c36ef01bfc44c6e6dbf1dc72a6`; #6196 advanced main with docs only.
- PreSync `torghut-db-migrations` and PostSync `torghut-empirical-jobs-backfill`,
  `torghut-whitepaper-semantic-backfill`, and `torghut-whitepapers-bootstrap` all completed.
- Live `torghut-00321-deployment` and sim `torghut-sim-00419-deployment` successfully rolled out on
  `registry.ide-newton.ts.net/lab/torghut@sha256:b1cfa68fc63054f030781d861833c669bc1ba00e80a2406730166b6a8e63138c`.
- `torghut-options-catalog`, `torghut-options-enricher`, `torghut-options-ta`, `torghut-ta`, `torghut-ta-sim`,
  `torghut-ws`, and `torghut-ws-options` are rolled out.
- All current Torghut namespace pods are `Running` with zero restarts. There are no non-running pods.
- Recent warning events are limited to startup/readiness probes and stale Knative status updates during revision churn;
  final pods are ready.

Runtime and value-gate evidence:

- `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` return HTTP 503 degraded by capital and evidence gates:
  `simple_submit_disabled`, proof floor `repair_only`, empirical jobs not ready/stale, and `quant_pipeline_degraded`.
- `/trading/status` reports build `v0.568.5-660-g2d5e1bed5`, commit
  `2d5e1bed5362cce967642852701ec9497fd00025`, and active revision `torghut-00321`.
- Live submission remains `allowed=false`; configured live promotion and autonomy live promotion are false.
- Profit signal quorum is `observe_only` with 3 quorums, 3 zero-notional quorums, `paper_candidate_count=0`,
  `routeable_candidate_count=0`, `blocked_or_stale_evidence_count=15`, `max_notional=0`,
  `paper_notional_limit=0`, and `live_notional_limit=0`.
- Quant metrics are current enough to report 180 latest metrics with single-digit pipeline lag at the last check, but
  the quant pipeline is still degraded because ingestion/materialization stages are stale.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`, and blockers
  `hypothesis_not_promotion_eligible`, `degraded`, `market_context_stale`, `simple_submit_disabled`,
  `empirical_jobs_not_ready`, and `quant_pipeline_degraded`.

Business metric and revenue impact:

- #6196 improves operator clarity for the evidence-clock path to `routeable_candidate_count` and
  `zero_notional_or_stale_evidence_rate`; it does not claim live PnL.
- `post_cost_daily_net_pnl`: no live revenue is claimed.
- `routeable_candidate_count`: remains 0.
- `zero_notional_or_stale_evidence_rate`: remains intentionally visible through zero-notional quorums and degraded
  evidence blockers.
- `fill_tca_or_slippage_quality`: still blocked from capital by stale/missing route and TCA evidence.
- `capital_gate_safety`: preserved. Live submit is disabled and max notional is 0.

Rollback path and residual risk:

- For runtime regression on the current image, merge an explicit GitOps rollback PR that restores the last known
  healthy Torghut image digest, then let release automation and Argo CD reconcile. Do not mutate production directly
  from a local shell.
- #6182 is available as a rollback candidate but is not selected while workloads are ready and capital is locked at
  zero notional.
- If #6127 later merges and regresses runtime health, revert its squash merge through a PR and let the normal build,
  release, and post-deploy verification workflows promote the reverted image.
- Residual blockers are: Torghut Argo health remains `Degraded`; #6127 needs Codex review capacity plus current-base
  checks; live revenue remains blocked by stale empirical jobs, quant pipeline degradation, market-context staleness,
  and `simple_submit_disabled`.

Owner update message - 2026-05-12T17:10Z:

#6196 is merged and synced through GitOps, and the Torghut workload rollout is mechanically stable on live
`torghut-00321` and sim `torghut-sim-00419` with zero restarts. The release is not a revenue go: Argo still marks
`torghut` Degraded, `/readyz` and `/trading/health` are 503, `revenue_ready=false`, routeable candidates remain 0, and
capital stays zero-notional with live submit disabled.

#6127 remains the smallest direct runtime PR for richer routeability acceptance evidence, but it cannot be merged until
Codex review capacity returns, a current-head review posts, all threads resolve, and checks are rerun against current
main. #6182 remains rollback-only contingency, not a selected merge.

## Release gate refresh - 2026-05-08T17:36Z

This section supersedes the 17:25 snapshot because #6127 finished its latest current-base hosted checks after main
advanced to the #6136 Torghut promotion.

Merge gate remains no-go for #6127, `feat(torghut): add routeability acceptance ledger`. The PR is still the only
direct open Torghut quant PR, but its 1,609-line diff requires Codex review before merge. The review request still has
only usage-limit responses from the Codex connector, so the release policy blocks squash-merge.

Current merge gate:

- #6127 head: `de979dc1a3caf48dad69ee00a87e1b68242b05d1`, after a teammate merged current main into the PR branch and
  re-requested Codex review.
- Current `main`: `06b3163ace826f9dd7f2f0c13720fd2b0782917c`, `chore(torghut): promote image 3080ec28 (#6136)`.
- GitHub reports #6127 `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`, with zero review threads.
- Current visible non-skipped checks on #6127 are green, including `agents-ci / integration` at 10m24s, `jangar-ci`,
  and all `torghut-ci` jobs.
- #6127 checks are current against base `06b3163ace826f9dd7f2f0c13720fd2b0782917c`; after Codex review capacity is
  restored, rerun checks if main advances again before merge.
- Codex review blocker remains
  https://github.com/proompteng/lab/pull/6127#issuecomment-4408477842: `You have reached your Codex usage limits for
code reviews.`

Current GitOps and rollout evidence:

- No #6127 rollout exists because #6127 is unmerged.
- `torghut`, `torghut-options`, and `jangar` are `Synced` and `Healthy` at
  `06b3163ace826f9dd7f2f0c13720fd2b0782917c`. `torghut` completed sync at `2026-05-08T17:22:07Z`;
  `torghut-options` completed at `2026-05-08T17:18:25Z`.
- The live Torghut image is
  `registry.ide-newton.ts.net/lab/torghut@sha256:ad3da6c3cfe82b6002f193a0a2fa1d2fa86aae6500d7dc8b5ccf679fbb9189e8`.
- Runtime build reports `v0.568.5-617-g3080ec285`, commit
  `3080ec285b255fae66b4ba56efd059e8ebff79f5`, active revision `torghut-00313`, so #6136 promoted the #6133 Torghut
  source fix into the live image.
- `torghut-00313-deployment`, `torghut-sim-00411-deployment`, options catalog/enricher, websocket, and TA workloads
  are ready. New live/sim/options pods are running with zero restarts.
- Events show the #6136 image pull, database migration hook, empirical jobs backfill, semantic backfill, and whitepaper
  bootstrap completed. Warning events were transient startup/readiness probes during rollout plus prior scaled-down
  revision noise; the final application state is healthy.

Current runtime and value-gate evidence:

- `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` return HTTP 503 degraded by expected capital gates.
- `/trading/status` reports build `v0.568.5-617-g3080ec285`, active revision `torghut-00313`, mode `live`,
  `enabled=true`, `running=true`, autonomy disabled, and kill switch false.
- Live submission remains `allowed=false` with reason `simple_submit_disabled`.
- Proof floor remains `repair_only`; route state `repair_only`; capital state `zero_notional`; `max_notional=0`.
- Profit quorum has 3 zero-notional quorums and `routeable_candidate_count=0`.
- Consumer evidence has empirical jobs healthy, quant evidence degraded with reason `quant_metrics_update_missing`, and
  no routeability acceptance ledger because #6127 is unmerged.
- Revenue repair reports `business_state=repair_only`, `revenue_ready=false`, and blockers
  `hypothesis_not_promotion_eligible`, `simple_submit_disabled`, and `quant_metrics_update_missing`.

Owner update message - 2026-05-08T17:36Z:

Merge gate is no-go for #6127. Current-base checks are green at head `de979dc1a3caf48dad69ee00a87e1b68242b05d1`,
but mandatory Codex review is still missing because the connector returned the usage-limit blocker; no selected Torghut
code PR was merged.

Production is healthy at the GitOps layer: `torghut`, `torghut-options`, and `jangar` are Synced/Healthy at
`06b3163a`, with live `torghut-00313` and sim `torghut-sim-00411` ready on digest
`sha256:ad3da6c3cfe82b6002f193a0a2fa1d2fa86aae6500d7dc8b5ccf679fbb9189e8`.

Runtime remains capital-safe and revenue-inactive: `/healthz` is 200, expected capital gates keep `/readyz` and
`/trading/health` degraded, `revenue_ready=false`, proof floor is `repair_only`, capital is `zero_notional`, and
`max_notional=0`.

Next action is restore Codex review capacity, get a current-head #6127 review posted, resolve any threads, rerun checks
if main advances, then repeat the merge and rollout gate.

## Release gate refresh - 2026-05-08T17:05Z

This section supersedes the 16:00 snapshot for current production state.

Merge gate remains no-go for #6127, `feat(torghut): add routeability acceptance ledger`. The governing runtime
requirement is
`docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`, extended by
`docs/torghut/design-system/v6/185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`. That contract keeps
routeability acceptance observe-only and zero-notional until route, TCA, forecast, alpha-readiness, and Jangar
admission receipts settle.

Open PR enumeration:

- Selected #6127 as the only direct open Torghut quant PR. It advances routeability repair acceptance evidence for
  `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and
  `capital_gate_safety`.
- Not selected #5889 because it is the Jangar control-plane lane, even though it references Torghut evidence.
- Not selected #5767 and #5316 because they are older automated release PRs and do not change Torghut quant runtime
  value gates.

Merge gate evidence for #6127:

- PR URL: https://github.com/proompteng/lab/pull/6127.
- Head: `955adea61cc2fc24dd73d1796696a52cae5a4112`; PR base snapshot reported by GitHub:
  `65d307c562ce19501451b0bd43628dcbe295f3ad`.
- Current `main`: `2662201aa48fec171666ecaf37fb0f982b48e619`, `chore(torghut): promote image c9967845 (#6132)`.
- GitHub reports `mergeable=true`, `mergeable_state=clean`, and non-draft state for #6127, with zero review threads.
- Visible hosted checks for #6127 are passing or skipped: semantic commit lint, semantic PR title,
  `CI / check_changed_files`, `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck / run`,
  `torghut-ci / Changed-file plan`, Pyright, bytecode/lint/migration guard, pytest shards 0-3,
  bytecode+pytest+coverage, and quality signals.
- `gh pr checks 6127 -R proompteng/lab --required` reports no configured required checks on the head branch; this
  release gate still treats all visible non-skipped checks and the review policy as mandatory.
- #6127 changes 1,475 additions and 134 deletions, 1,609 changed lines total, so the >1,000-line Codex review gate is
  mandatory.
- Codex review requests were posted at
  https://github.com/proompteng/lab/pull/6127#issuecomment-4407629789 and
  https://github.com/proompteng/lab/pull/6127#issuecomment-4407847355.
- The exact blocker response remains
  https://github.com/proompteng/lab/pull/6127#issuecomment-4407848367: `You have reached your Codex usage limits for
code reviews.`
- Merge decision: do not merge #6127 until Codex review capacity is restored, a current-head Codex review posts, any
  review threads are resolved, and checks are rerun against the then-current main.

Current rollout evidence:

- No #6127 rollout exists because #6127 is unmerged.
- `torghut`, `torghut-options`, and `jangar` are `Synced` and `Healthy` at
  `2662201aa48fec171666ecaf37fb0f982b48e619`. `torghut` finished at `2026-05-08T17:01:34Z`;
  `torghut-options` finished at `2026-05-08T16:58:46Z`; `jangar` reports the same sync revision.
- The current Torghut image digest is
  `registry.ide-newton.ts.net/lab/torghut@sha256:3f41ac1794398003b8af42e5a293c85bbc921b9db1717dcd426718b2b706d23f`.
- `torghut-00312-deployment`, `torghut-sim-00410-deployment`, `torghut-options-catalog`,
  `torghut-options-enricher`, `torghut-ws`, `torghut-ws-options`, `torghut-ta`, and `torghut-ta-sim` all reported
  successful rollout.
- New live/sim pods `torghut-00312-deployment-56985748c4-9pfjt` and
  `torghut-sim-00410-deployment-8f945fd5-2hl7f` are `2/2 Running` with zero restarts. Options catalog/enricher pods
  are `1/1 Running` with zero restarts.
- Events show the database migration job completed, revisions `torghut-00312` and `torghut-sim-00410` became ready,
  old sim revision scaled down, empirical and semantic backfill jobs completed, and whitepaper bootstrap completed.
  Warning events were transient startup/readiness probe failures during rollout plus existing websocket readiness
  noise; the final rollout state is healthy.

Runtime and value-gate evidence:

- `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` return HTTP 503 degraded because live submission is still blocked by
  `simple_submit_disabled`; proof floor remains `repair_only`, route state `repair_only`, capital state
  `zero_notional`, and `max_notional=0`.
- `/trading/status` reports build `v0.568.5-613-gc99678457`, commit
  `c99678457a3b1ee195cddf41525ca6970d24293c`, active revision `torghut-00312`, mode `live`, `enabled=true`,
  `running=true`, autonomy disabled, and kill switch false.
- `profit_signal_quorum` reports schema `torghut.profit-signal-quorum.v1`, 3 quorums, 3 zero-notional quorums, and
  `routeable_candidate_count=0`.
- `/trading/consumer-evidence` reports schema `torghut.consumer-evidence-status.v1`, empirical jobs healthy for
  `chip-paper-microbar-composite@execution-proof`, dataset `torghut-chip-full-day-20260505-4c330ce9-r1`,
  quant evidence degraded with 180 latest metrics, and `routeability_acceptance_ledger_present=false`.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`, and blockers
  `hypothesis_not_promotion_eligible`, `market_context_stale`, `simple_submit_disabled`, and
  `quant_pipeline_degraded`.
- Route reacquisition evidence shows 0 routeable symbols, 1 probing symbol (`AAPL`), 4 blocked symbols, 3 missing
  symbols, and 7 repair candidates. Paper probe notional remains 0 for repair candidates.
- `post_cost_daily_net_pnl`: no live revenue is claimed.
- `routeable_candidate_count`: remains 0; #6127 is the smallest direct blocker to richer routeability acceptance
  evidence.
- `zero_notional_or_stale_evidence_rate`: remains intentionally visible and capital-safe through zero-notional quorums
  and degraded/stale evidence blockers.
- `fill_tca_or_slippage_quality`: current TCA evidence covers 7,334 orders and keeps high-slippage/missing symbols in
  repair before capital.
- `capital_gate_safety`: preserved. Live submission is disabled and max notional is 0.

Rollback path and residual risk:

- Since #6127 is unmerged, no #6127 rollback is required.
- If the current `c99678457` / `sha256:3f41ac1794398003b8af42e5a293c85bbc921b9db1717dcd426718b2b706d23f` rollout
  regresses, open a GitOps rollback PR that restores the previous healthy Torghut digest, then let release automation
  and Argo CD reconcile. Do not mutate production from a local shell.
- If #6127 later merges and regresses runtime health, revert its squash merge through a PR and let the normal build,
  release, and post-deploy verification workflows promote the reverted image.
- Residual release risk is review capacity plus stale-base validation: #6127 cannot be merged until a Codex review
  posts and checks rerun against the then-current main.

Owner update message - 2026-05-08T17:05Z:

Merge gate is no-go for #6127. The PR is clean and its visible checks are green, but it changes 1,609 lines and the
required Codex review still has not posted; the connector returned the Codex usage-limit blocker. Current main also
advanced to `2662201a`, so after review capacity is restored, #6127 needs current-base checks before any squash merge.

Production rollout is healthy at the GitOps layer. `torghut`, `torghut-options`, and `jangar` are Synced/Healthy at
`2662201a`; live `torghut-00312`, sim `torghut-sim-00410`, options catalog/enricher, websocket, and TA deployments are
rolled out.

Runtime remains capital-safe and revenue-inactive. `/healthz` is 200, `/readyz` and `/trading/health` are degraded by
the expected capital gates, `/trading/revenue-repair` reports `business_state=repair_only` and `revenue_ready=false`,
profit quorum routeable candidates remain 0, and max notional remains 0.

Next action is restore Codex review capacity for #6127, get the current-head review posted, resolve any threads, rerun
checks against current main, then repeat the merge and rollout gate.

## Latest release gate refresh - 2026-05-08T16:00Z

This section supersedes the earlier snapshots for the current open Torghut quant PR queue.

Merge gate is no-go for the newly selected Torghut quant PR. The governing runtime requirement is
`docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`, extended by the
scoped handoff `docs/torghut/design-system/v6/185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`. That
contract requires routeability repair evidence to stay observe-only and zero-notional until route, TCA, forecast,
alpha-readiness, and Jangar admission receipts settle.

Open PR enumeration:

- Selected #6127, `feat(torghut): add routeability acceptance ledger`, as the only direct Torghut quant PR advancing
  `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and
  `capital_gate_safety`.
- Not selected #5889, `feat(jangar): add repair warrant exchange`, because it is the Jangar control-plane lane even
  though it references Torghut evidence and remains blocked by the same large-diff Codex review-capacity gate.
- Not selected #5767 and #5316 because they are older automated release PRs for `app` and `docs`, not Torghut quant
  runtime/value-gate changes.

Merge gate evidence for #6127:

- PR URL: https://github.com/proompteng/lab/pull/6127.
- Head: `955adea61cc2fc24dd73d1796696a52cae5a4112`; base: `65d307c562ce19501451b0bd43628dcbe295f3ad`.
- GitHub reports `mergeable=true` and `mergeable_state=clean`; the PR is non-draft.
- Review threads: 0 total, 0 unresolved. Formal reviews: 0.
- Visible checks are complete with no failures or pending checks: semantic commit lint, semantic PR title,
  `CI / check_changed_files`, `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck / run`,
  `torghut-ci / Changed-file plan`, Torghut Pyright, bytecode/lint/migration guard, pytest shards 0-3,
  bytecode+pytest+coverage, and quality signals are passing. Unrelated package/deploy enable jobs are skipped.
- `gh pr checks 6127 --required` reports no configured required checks on the head branch; the release gate still uses
  all visible non-skipped checks plus the review policy.
- Diff size is 1,475 additions and 134 deletions across 13 files, 1,609 changed lines total. This exceeds the
  mandatory >1,000-line Codex review threshold.
- Codex review was requested at
  https://github.com/proompteng/lab/pull/6127#issuecomment-4407629789 and refreshed at
  https://github.com/proompteng/lab/pull/6127#issuecomment-4407847355.
- The connector response at https://github.com/proompteng/lab/pull/6127#issuecomment-4407848367 is the exact blocker:
  `You have reached your Codex usage limits for code reviews.`
- Merge decision: do not merge #6127 until Codex review capacity is restored, a current-head Codex review posts, and
  all resulting threads are resolved.

Runtime and GitOps baseline evidence:

- No #6127 rollout exists because the merge gate is closed.
- Current main, `65d307c562ce19501451b0bd43628dcbe295f3ad`, is synced in Argo: `torghut`, `torghut-options`, and
  `jangar` are `Synced` and `Healthy`. `torghut` finished sync at `2026-05-08T15:07:28Z`; `torghut-options` finished
  at `2026-05-08T15:07:52Z`; `jangar` finished at `2026-05-08T13:34:59Z`.
- Current workloads are ready: `torghut-00311-deployment`, `torghut-sim-00409-deployment`, and
  `torghut-options-catalog` all report successful rollout; live/sim pods are running with zero restarts.
- `/healthz` returns HTTP 200. `/readyz` and `/trading/health` return HTTP 503 degraded because
  `live_submission_gate=simple_submit_disabled` and `profitability_proof_floor=repair_only`, which is capital-safe.
- `/trading/status` reports active revision `torghut-00311`, commit
  `59b57ebf0199f83136742cf71ed9379e073d6874`, mode `live`, running `true`, and live submission
  `allowed=false` with reason `simple_submit_disabled`.
- `/trading/consumer-evidence` reports empirical jobs healthy for candidate
  `chip-paper-microbar-composite@execution-proof`, dataset `torghut-chip-full-day-20260505-4c330ce9-r1`, quant
  evidence degraded, 5 zero-notional capital cohorts, 7 zero-notional repair lots, and `routeable_candidate_count=0`.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`,
  `capital_state=zero_notional`, `max_notional=0`, and blockers
  `hypothesis_not_promotion_eligible`, `market_context_stale`, `simple_submit_disabled`, and
  `quant_metrics_update_missing`.

Value-gate decision:

- `post_cost_daily_net_pnl`: no live revenue is claimed; the system remains repair-only.
- `routeable_candidate_count`: #6127 would improve evidence visibility, but live runtime remains at 0 routeable
  candidates until the blocked PR can merge and evidence repairs settle.
- `zero_notional_or_stale_evidence_rate`: current runtime exposes 5 zero-notional capital cohorts and 7 zero-notional
  repair lots; #6127 adds a routeability acceptance ledger for unsettled lots but is blocked by review capacity.
- `fill_tca_or_slippage_quality`: current runtime records 7 route repair candidates and TCA/slippage repair actions;
  #6127 would make unresolved routeability acceptance lots explicit.
- `capital_gate_safety`: preserved. Current max notional is 0 and live submission remains disabled; #6127 is
  observe-only and also keeps paper/live notional at 0 for unsettled lots.

Rollback path and residual risk:

- Since #6127 is unmerged, no rollback is required for it.
- Current production rollback remains the normal GitOps path: revert the latest Torghut promotion PR or promote the
  prior known-good digest through an automated release PR.
- Capital safety rollback is already active: live submit disabled, zero notional, and repair-only proof floor.
- Residual risk is review-capacity, not runtime health: the release cannot advance routeability acceptance evidence
  until a current-head Codex review posts and review threads are clear.

Owner update message - 2026-05-08T16:00Z:

Merge gate is no-go for #6127. The PR is clean and all visible checks are green or skipped, but it changes 1,609
lines and the required Codex review did not post because the connector returned the usage-limit blocker.

Current production is healthy at the rollout layer: Argo has `torghut`, `torghut-options`, and `jangar` Synced/Healthy
at `65d307c562ce19501451b0bd43628dcbe295f3ad`, and the live Torghut deployments are rolled out on revision
`torghut-00311`. This is not a #6127 rollout; no merge happened.

Runtime remains capital-safe and repair-only: `/healthz` is 200, `/readyz` and `/trading/health` are degraded by
`simple_submit_disabled` and `profitability_proof_floor=repair_only`, `/trading/revenue-repair` reports
`revenue_ready=false`, `capital_state=zero_notional`, `max_notional=0`, and `routeable_candidate_count=0`.

Next action is restore Codex review capacity for #6127, get a current-head review posted, resolve any threads, then
rerun the merge and rollout gate before any squash merge.

## Final release refresh - 2026-05-08T15:12Z

This section supersedes the earlier snapshots below.

Final merge and rollout gate is go for the selected Torghut quant release. The governing runtime requirement was
`docs/torghut/design-system/v6/184-torghut-profit-signal-quorum-and-context-routability-handoff-2026-05-08.md`,
which requires the profit-signal quorum to expose routeability and stale-evidence blockers without widening capital.
The runtime surfaces are the `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and
`GET /trading/consumer-evidence` contracts documented in `services/torghut/README.md`.

Open PR enumeration selected #6123 as the direct Torghut quant value-gate PR and #6124 as its generated GitOps
promotion PR. #5889 was a Jangar control-plane PR, and #5767/#5316 were older automated release PRs; none were the
primary Torghut quant blocker for this release gate.

Merged PRs:

- #6123, `feat(torghut): add profit signal quorum receipt`, squash-merged at
  `59b57ebf0199f83136742cf71ed9379e073d6874`.
- #6124, `chore(torghut): promote image 59b57ebf`, auto-squash-merged at
  `0293bb824f2ee98fa72fe2ad5b07c83336516856`, promoted image digest
  `sha256:cd9629c9e1e4c3a3565fb0d389f9a90d37fbf3b7b0a3a6253556485498079991`.

Merge gate evidence:

- #6123 was conflict-free, non-draft, comment-clean, and `MERGEABLE/CLEAN` before merge.
- #6123 changed exactly 1000 additions and 0 deletions, so it did not exceed the large-diff Codex review threshold.
  The attempted Codex review returned a usage-limit notice and did not create blocking review threads.
- #6123 current checks were green before merge: Torghut Pyright, bytecode/lint/migration guard, pytest shards 0-3,
  bytecode+pytest+coverage, quality signals, changed-file plan, semantic commit lint, and semantic PR title.
- #6124 changed only allowlisted GitOps manifests, 24 additions and 24 deletions, with no migration-approval label.
- #6124 release checks were green before automerge: semantic commit lint, semantic PR title, Argo lint, kubeconform,
  Torghut release-manifest gating, and `torghut-deploy-automerge`.
- Source commit CI after #6123 was green on run `25562499196`, including the aggregate coverage job. Image build
  passed on `torghut-build-push` run `25562499215`, and `torghut-release` run `25562638267` created #6124.

Rollout evidence:

- Post-promotion checks passed on main commit `0293bb824f2ee98fa72fe2ad5b07c83336516856`: `argo-lint` run
  `25562837370`, `torghut-ci` run `25562837401`, `kubeconform` run `25562837442`, and
  `torghut-post-deploy-verify` run `25562837373`.
- Argo CD reports `torghut` and `torghut-options` as `Synced` and `Healthy` at revision
  `0293bb824f2ee98fa72fe2ad5b07c83336516856`. `torghut` finished sync at `2026-05-08T15:07:28Z`;
  `torghut-options` finished at `2026-05-08T15:07:52Z`.
- `torghut-00311-deployment`, `torghut-sim-00409-deployment`, `torghut-options-catalog`, and
  `torghut-options-enricher` are each `1/1` ready, updated, and available on
  `registry.ide-newton.ts.net/lab/torghut@sha256:cd9629c9e1e4c3a3565fb0d389f9a90d37fbf3b7b0a3a6253556485498079991`.
- The live, sim, catalog, and enricher pods created during this rollout are running with zero restarts.
- Events show the migration hook completed, Knative revisions `torghut-00311` and `torghut-sim-00409` became ready,
  old revisions scaled down, and options catalog/enricher rolled to the new digest. The warning events were transient
  startup/readiness probes during rollout plus pre-existing PDB and websocket readiness noise.
- The service account cannot read Knative `services.serving.knative.dev` directly; Knative readiness was therefore
  verified through Argo health, the successful post-deploy verifier, deployments, pods, and in-cluster HTTP checks.

Runtime evidence:

- `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` return HTTP 503 with degraded trading health, which is expected while capital gates
  remain repair-only; post-deploy verify accepted the HTTP response and validated the runtime evidence surfaces.
- `/trading/status` reports build `v0.568.5-607-g59b57ebf0`, commit
  `59b57ebf0199f83136742cf71ed9379e073d6874`, active revision `torghut-00311`, `enabled=true`, `running=true`,
  mode `live`, autonomy disabled, and kill switch false.
- `profit_signal_quorum` exposes schema `torghut.profit-signal-quorum.v1`, 3 quorums, 3 observe-only decisions,
  3 zero-notional quorums, 0 paper candidates, 0 routeable candidates, and 16 blocked or stale evidence cells.
- The live submission gate remains blocked as intended: `allowed=false`, reason `simple_submit_disabled`, capital
  stage `shadow`.
- Quant evidence is non-blocking but not revenue-clear: `ok=true`, reason `quant_metrics_update_missing`,
  latest metrics count `180`, and metrics pipeline lag about `32` seconds at verification time.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`,
  `capital_state=zero_notional`, `max_notional=0`, 7 repair queue items, and blockers
  `hypothesis_not_promotion_eligible`, `market_context_stale`, `simple_submit_disabled`, and
  `quant_pipeline_degraded`.
- `/trading/consumer-evidence` exposes `torghut.consumer-evidence-status.v1` and
  `torghut.profit-repair-settlement-ledger.v1` with aggregate state `repair`.

Value-gate evidence:

- `post_cost_daily_net_pnl`: no live PnL is claimed. Runtime is intentionally revenue-inactive because
  `revenue_ready=false` and live submission remains blocked.
- `routeable_candidate_count`: still 0. The release improves routeability evidence by making quorum membership and
  blocked/stale evidence counts explicit for Jangar handoff.
- `zero_notional_or_stale_evidence_rate`: all 3 quorum receipts remain zero-notional; 16 blocked/stale evidence cells
  are visible instead of silent.
- `fill_tca_or_slippage_quality`: the release surfaces route/TCA quality as a value gate in the quorum summary and
  keeps repair blockers visible for follow-up.
- `capital_gate_safety`: preserved. Max notional remains 0, capital state remains zero-notional, and live submission
  remains blocked by `simple_submit_disabled`.

Rollback path:

- Fast rollback is to revert #6124 or promote the previous known-good Torghut digest
  `sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98` through the normal GitOps release PR
  path.
- If the runtime code regresses independently of the image promotion, revert #6123 and let the standard build,
  release, and post-deploy verification workflows promote the reverted image.
- Capital safety rollback is already active at runtime: max notional is zero, revenue is not ready, and live
  submission is disabled.

The revenue metric advanced is routeable post-cost profit evidence readiness, specifically
`zero_notional_or_stale_evidence_rate` and `routeable_candidate_count` observability. The smallest blocker preventing
revenue impact is not rollout health; it is evidence repair: zero routeable candidates, market-context staleness,
quant pipeline degradation, alpha readiness not promotion-eligible, and simple submit disabled.

## Owner update message - 2026-05-08T15:12Z

Rollout gate is green. #6123 merged at `59b57ebf0199f83136742cf71ed9379e073d6874`, promotion #6124 merged at
`0293bb824f2ee98fa72fe2ad5b07c83336516856`, and Argo reports `torghut` and `torghut-options` `Synced`/`Healthy` at
the #6124 commit.

Live `torghut-00311`, sim `torghut-sim-00409`, `torghut-options-catalog`, and `torghut-options-enricher` are ready on
digest `sha256:cd9629c9e1e4c3a3565fb0d389f9a90d37fbf3b7b0a3a6253556485498079991`, with zero restarts in the new pods.
Post-deploy verify run `25562837373` passed.

Trading remains capital-safe rather than revenue-active: `/trading/status` exposes
`torghut.profit-signal-quorum.v1` with 3 zero-notional quorums, 0 routeable candidates, and 16 blocked/stale evidence
cells; `/trading/revenue-repair` reports `revenue_ready=false`, `capital_state=zero_notional`, `max_notional=0`, and
blockers for alpha readiness, market context, simple submit, and quant pipeline degradation.

Next action is evidence repair, not another deployment: clear market-context staleness, quant pipeline degradation,
alpha-readiness blockers, and simple-submit gating before paper or live notional can open.

## Final release refresh - 2026-05-08T13:42Z

This section supersedes the earlier snapshots below.

Final merge and rollout gate is go for the selected Torghut quant PRs. The governing runtime requirements were
`docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`, which requires
profit-repair settlement evidence to keep live notional at zero until receipts settle, and
`docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`, which requires Torghut verify stages to prove
green PR checks, image promotion, Argo sync, live service health, and trading or evidence status after rollout.

Merged PRs:

- #6115, `fix(torghut): honor optional quant evidence in profit gates`, merged at
  `fa8a59fcffcf4b03777caccded1d3c2a26b1ac3f`.
- #6118, `chore(torghut): promote image fa8a59fc`, merged at
  `da9d831c2fda3afc7ed51f648965400b6fe2ce8e`, promoted Torghut digest
  `sha256:561bd5d42db9b3c03567f59d475b21df1cd9bbb6a7b50e8155c7375b087d3d77`.
- #6117, `feat(torghut): add profit repair settlement ledger`, merged at
  `fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`.
- #6119, `chore(torghut): promote image fa3d104c`, merged at
  `a03d81bfee930dbec160b85078b44ad7bfc840ee`, promoted Torghut digest
  `sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`.
- #6120, `chore(jangar): promote image fa3d104c`, merged at
  `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`, promoted Jangar digest
  `sha256:e4fda889861d807265ca5638218431f8ad841bf08b54f8482bf73e43b8d71bf2`.

Merge gate evidence:

- #6115 had no review threads or review requests, was conflict-free, and all non-skipped checks were green before
  merge, including Torghut Pyright, bytecode/lint/migration guard, pytest shards, coverage, and quality signals.
- #6117 had no review threads, no review requests, `mergeStateStatus=CLEAN`, `mergeable=MERGEABLE`, and changed
  988 additions plus 2 deletions, below the 1000-line Codex review threshold.
- #6117 checks were green before merge: semantic commits, semantic PR title, `CI / check_changed_files`,
  `jangar-ci / lint-and-typecheck / run`, `agents-ci / validate`, `agents-ci / integration`, Torghut Pyright,
  bytecode/lint/migration guard, pytest shards 0-3, coverage, and quality signals.
- #6119 and #6120 release PR checks were green before auto-merge, including semantic checks, Argo lint,
  kubeconform, release-manifest gating, Jangar typecheck for #6120, and Torghut deploy automerge for #6119.
- Post-merge release workflows passed: `torghut-build-push` run `25557901556`, `torghut-release` run
  `25558175648`, `torghut-post-deploy-verify` run `25558264463`, `jangar-build-push` run `25557901570`,
  `jangar-release` run `25558419593`, and `jangar-post-deploy-verify` run `25558467878`.

Rollout evidence:

- Argo CD reports `torghut`, `torghut-options`, and `jangar` as `Synced` and `Healthy` at revision
  `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`.
- `torghut-00310-deployment` and `torghut-sim-00408-deployment` are `1/1` ready, updated, and available on
  `registry.ide-newton.ts.net/lab/torghut@sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`.
- `torghut-options-catalog` and `torghut-options-enricher` are `1/1` ready, updated, and available on the same
  Torghut digest.
- The current pods have zero restarts for the Torghut live, sim, options catalog, and options enricher containers.
- Events show the #6119 migration job completed, new Knative revisions `torghut-00310` and `torghut-sim-00408`
  became ready, and old revisions scaled down. The remaining warnings were transient startup/readiness probes during
  rollout plus pre-existing PDB and old whitepaper workflow noise.

Runtime evidence:

- `/healthz` returns HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/trading/status` reports runtime build `v0.568.5-602-gfa3d104cb`, commit
  `fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`, active revision `torghut-00310`, `enabled=true`, `running=true`,
  mode `live`, and autonomy disabled.
- Live submission remains blocked as intended: `allowed=false`, reason `simple_submit_disabled`, blockers
  `hypothesis_not_promotion_eligible` and `simple_submit_disabled`, capital stage `shadow`, and
  `promotion_eligible_total=0`.
- Quant evidence is non-blocking but degraded: `required=false`, `ok=true`, latest metrics count `144`, latest
  metrics at `2026-05-08T13:39:46.497Z`, and `metrics_pipeline_lag_seconds=67`.
- `/trading/health` returns HTTP 503 with status `degraded`; dependencies `postgres`, `clickhouse`, `alpaca`,
  `universe`, and `empirical_jobs` are ok, while `profitability_proof_floor` is `repair_only` and
  `live_submission_gate` is blocked.
- `/trading/consumer-evidence` now exposes `torghut.profit-repair-settlement-ledger.v1` on `torghut-00310`.
  The ledger is `aggregate_state=repair`, `next_safe_action=zero_notional_repair`, with 7 repair lots, 7
  zero-notional lots, 0 routeable candidates, 10 quality-frontier packets, and rollback target
  `live_submit_enabled=false`.
- The capital reentry ledger reports 5 repair cohorts, 5 zero-notional cohorts, 0 routeable candidates, and expected
  unblock value 19.

Value-gate evidence:

- `post_cost_daily_net_pnl`: no live PnL claimed. Runtime remains revenue-inactive by design because live submission
  is disabled and proof floor is repair-only.
- `routeable_candidate_count`: still 0. The release improves repair visibility by making settlement lots and expected
  unblock value explicit.
- `zero_notional_or_stale_evidence_rate`: improved observability; all 7 profit repair lots remain zero-notional and
  list their stale or missing evidence blockers.
- `fill_tca_or_slippage_quality`: repair lots identify route TCA exclusions for AMD, AVGO, INTC, and NVDA and missing
  TCA probes for AMZN, GOOGL, and ORCL.
- `capital_gate_safety`: preserved. Every profit repair lot has `paper_notional_limit=0` and `live_notional_limit=0`;
  submit enablement explicitly rolls back if proof floor is `repair_only` or max notional is zero.

Rollback path:

- Revert #6119 or promote the previous Torghut digest
  `sha256:561bd5d42db9b3c03567f59d475b21df1cd9bbb6a7b50e8155c7375b087d3d77` through the normal GitOps release PR path.
- If the Jangar evidence-router side regresses, revert #6120 or promote the previous known-good Jangar image through
  the normal Jangar release PR path.
- Capital rollback is already enforced at runtime: zero notional, live submit disabled, and profit-repair settlement
  consumption disabled in rollback targets.

The revenue metric advanced is routeable post-cost profit evidence readiness, specifically
`zero_notional_or_stale_evidence_rate` and `fill_tca_or_slippage_quality` observability. The smallest blocker
preventing revenue impact is not deployment health; it is evidence repair: zero routeable candidates, quant stage
coverage degraded, route TCA gaps, schema/rejection-drag debt, alpha readiness not promotion-eligible, and simple
submit disabled.

## Owner update message - 2026-05-08T13:42Z

Rollout gate is green. #6115 and #6117 are merged, Torghut promotion #6119 and Jangar promotion #6120 are merged, and
Argo shows `torghut`, `torghut-options`, and `jangar` `Synced`/`Healthy` at
`74befb03e6df84d62b53f5732e0bcc6b90ef52d8`.

Live, sim, catalog, and enricher workloads are ready on Torghut digest
`sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`; `/trading/status` reports commit
`fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`, active revision `torghut-00310`, enabled live mode, and running.
Trading remains capital-safe rather than revenue-active: routeable candidates are 0, the profit repair ledger has 7
zero-notional repair lots, and live submission is blocked by `simple_submit_disabled` plus alpha readiness.

Next action is evidence repair, not another deployment: clear quant stage coverage, route TCA gaps, schema/rejection
drag debt, and alpha-readiness blockers before any paper or live notional opens.

## Final release refresh - 2026-05-08T10:18Z

This section supersedes the earlier no-go snapshots below.

Final merge and rollout gate is go. PR #5412, `feat(torghut): add profit escrow runtime projections`, was
squash-merged after terminal-green checks at merge commit `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f`. The
large-diff Codex review connector was usage-limited, but the maintainer waiver was recorded on the PR before merge.

The generated deploy PR #6091 was reviewed and manually approved for additive migration
`0030_evidence_epochs.py`, then closed as superseded. Main had already merged newer descendant promotion PR #6093,
`chore(torghut): promote image 8a01e3d2`, at `8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`. Because #6093 includes
#5412 and promotes source commit `8a01e3d20e26be623a3fa2dd234d161a5c78218d`, conflict-resolving #6091 would have
risked rolling Torghut back to the older #5412-only image digest.

The active rollout is #6093:

- Source commit: `8a01e3d20e26be623a3fa2dd234d161a5c78218d`
- Merge commit: `8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`
- Image digest: `sha256:dbd4b1b267f2387aeecf7e3f3f242b8630b7fdddb7f2a69f4c827a7069ae6afa`
- Post-deploy verify: `torghut-post-deploy-verify` run `25549826301`, success at 2026-05-08T10:16:55Z

Argo CD reports `torghut` and `torghut-options` as `Synced` and `Healthy` at revision
`8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`. Live/sim/options workloads are ready on the promoted digest:
`torghut-00306-deployment`, `torghut-sim-00404-deployment`, `torghut-options-catalog`, and
`torghut-options-enricher` all report `1/1` ready. The service account cannot read Knative `ksvc` objects, so the
rollout was verified through Argo Application state, deployments, pods, events, post-deploy CI, and in-cluster HTTP
checks.

Runtime evidence is healthy for service rollout but still capital-safe and revenue-inactive. `/healthz`,
`/trading/status`, and `/trading/revenue-repair` return HTTP 200; `/readyz` returns HTTP 503 because readiness/capital
conditions remain blocked. `/trading/status` reports active revision `torghut-00306`, mode `live`, enabled `true`,
running `true`, kill switch `false`, proof floor `repair_only`, route state `repair_only`, capital state
`zero_notional`, `max_notional=0`, and `simple_lane_orders_submitted_total=0`.

Value-gate evidence after rollout:

- `post_cost_daily_net_pnl`: no live revenue impact claimed; runtime is intentionally `repair_only` with
  `revenue_ready=false`.
- `routeable_candidate_count`: execution TCA shows one routeable symbol; route board has `probing=1`, `blocked=4`,
  `missing=3`, and `capital_eligible_symbol_count=0`.
- `zero_notional_or_stale_evidence_rate`: route board row count `8`, zero-notional row count `8`, and max notional
  remains `0`.
- `fill_tca_or_slippage_quality`: TCA is fresh enough to pass as evidence, but route-universe exclusions remain
  enforced; aggregate average absolute slippage is about `13.82` bps versus the 8 bps guardrail.
- `capital_gate_safety`: live submission is not allowed, capital remains zero-notional, and blockers include
  `hypothesis_not_promotion_eligible`, `simple_submit_disabled`, and quant/forecast evidence gaps.

Profit-evidence surfaces are live on `torghut-00306`: profit lease projection has three repair-only leases,
route-proven profit receipt decision is `repair`, renewal bond profit escrow verdict is `repair_only`, and the
consumer evidence receipt is present with empirical jobs `healthy`, forecast registry `degraded`, and TCA `pass`.
The revenue metric advanced is routeable post-cost profit evidence observability and repair prioritization, not live
PnL. The smallest blocker preventing revenue impact is evidence repair: alpha readiness, quant pipeline stage
coverage, route universe/TCA slippage quality, market-context freshness, and simple submit enablement.

Rollback path: revert #6093 or promote the prior known-good Torghut digest
`sha256:fbe830e2803933df61deb7d13bfd26f9a1c640f90b24b20f5fb40909d4256110` through the normal GitOps release PR path.
The additive evidence epoch tables from #5412 can remain unused if the image is rolled back, and capital is already
held at the rollback target of zero notional with live submit disabled.

## Owner update message - 2026-05-08T10:18Z

#5412 is merged and rolled out through the newer descendant Torghut promotion #6093, not the stale #6091 promotion
branch. Argo reports `torghut` and `torghut-options` `Synced`/`Healthy` at
`8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`, post-deploy verify run `25549826301` passed, and live/sim/options
workloads are ready on digest `sha256:dbd4b1b267f2387aeecf7e3f3f242b8630b7fdddb7f2a69f4c827a7069ae6afa`.

Runtime evidence is safe but still repair-only: revenue_ready=false, capital_state=zero_notional, max_notional=0,
TCA routeable symbol count=1, route board zero-notional rows=8/8, expected unblock value=14. Next action is evidence
repair before revenue activation, not another rollout.

## Historical release refresh - 2026-05-08T08:43Z

This section supersedes earlier rollout snapshots in this document.

Final merge gate is no-go for #5412. The PR is open, non-draft, conflict-free, and green on hosted checks at head
`489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, but it is 8,074 additions and 617 deletions. No Codex review is posted,
no review thread exists, and no maintainer waiver is recorded. The latest `@codex review` request for this head
returned the Codex usage-limit blocker at 2026-05-08T08:11:33Z.

Audit PRs #6066 and #6071 were squash-merged. Torghut promotion PR #6073 was also merged with green checks, and the
repository has advanced through current main `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` after Bilig-only automated
release PRs #6076 and #6077. Argo CD reports Torghut apps as `Synced` and `Healthy` on the promoted Torghut image;
`root` and `symphony-torghut` are also `Synced` and `Healthy` at their latest relevant revisions.

Torghut live and sim workloads are ready on image digest
`sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`, runtime build commit
`171fa3f14ae53adf17f3426d13e7fe3a27cb2438`, active revision `torghut-00304`. `/healthz`, `/trading/status`, and
`/trading/consumer-evidence` return HTTP 200. Runtime remains capital-safe: proof floor `repair_only`, route state
`repair_only`, capital state `zero_notional`, `max_notional=0`, and live submission blocked by
`simple_submit_disabled`.

Revenue impact remains blocked rather than realized. The smallest blocker preventing revenue impact is the missing
large-diff Codex review or explicit maintainer waiver for #5412; after that, alpha readiness and live submission gates
must still clear before non-zero notional.

## Owner update message

Merge gate is no-go for #5412. The PR is open, non-draft, conflict-free, and green on hosted checks at
head `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, but it is still above the large-diff review threshold
at 8,074 additions and 617 deletions. There is no posted Codex review and no review thread; the latest
`@codex review` request for this head returned the Codex usage-limit blocker at 2026-05-08T08:11:33Z.

The audit PRs for this pass, #6066 and #6071, merged at `f45234fc501469f947ad8c055e50ebfb95e6565f` and
`6a8dcc517167507c391af3ddc3442d38994f6eb5`. Current main then advanced to
`61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` through #6073, #6076, and #6077. The Torghut rollout remains healthy:
Argo CD reports Torghut apps as `Synced` and `Healthy`. Live and sim Torghut workloads are ready on image digest
`sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`, runtime build commit
`171fa3f14ae53adf17f3426d13e7fe3a27cb2438`, active revision `torghut-00304`.

Trading remains intentionally capital-safe: `/trading/status` reports `floor_state=repair_only`,
`route_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and live submission blocked by
`simple_submit_disabled`. The smallest blocker preventing revenue impact is the missing large-diff Codex
review or explicit maintainer waiver for #5412; after that, the runtime still needs alpha-readiness and
live-submission gates to clear before non-zero notional.

## Governing requirements

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` keeps deployed
  runtime source of truth in `argocd/applications/torghut/**`, `services/torghut/README.md`, and
  `services/torghut/app/config.py`.
- `docs/torghut/design-system/v6/182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
  requires route-proven profit evidence, explicit route repair packets, and paper/live notional held at zero when the
  receipt boundary is not promotion-authoritative.
- `docs/torghut/design-system/v1/architecture-and-context.md` defines GitOps manifests under
  `argocd/applications/torghut/**` as the production deployment source of truth and requires explicit namespace
  checks for workload health.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR in this inventory.
  - Merge gate: no-go. Checks are green and merge state is clean, but the large-diff Codex review has not posted.
- #6060, `docs(jangar): refresh control plane release gate`
  - Not selected: Jangar verifier documentation scope, not Torghut runtime scope.
- #5889, `feat(jangar): add repair warrant exchange`
  - Not selected: Jangar control-plane scope, not Torghut runtime scope.
- #5767, `chore(release/c3ba60b): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.
- #5316, `chore(release/735ddbc): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.

## PRs touched

- #5412
  - Rechecked mergeability, hosted checks, review state, comments, review threads, and changed-line count.
  - Latest reviewed head: `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`.
  - Latest Codex review request:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404817379
  - Latest connector blocker:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404818477
  - Kept open and unmerged.
- Current main rollout
  - Verified current main `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` in Argo CD and live Torghut workloads.
  - No direct production mutation was made from the local shell.

## Comments and conflicts resolved

- #5412 reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has zero review threads and no posted GitHub reviews.
- #5412 is comment-clean except for the unresolved policy blocker: every latest Codex review request returns the
  usage-limit response instead of a review.
- No merge conflict required local resolution in this pass.
- No service code was changed in this pass.

## Merge outcomes

- #5412: not merged. Merge is blocked by the mandatory large-diff Codex review gate.
- No selected Torghut code PR was squash-merged during this pass.
- Current main rollout was verified only; it was not mutated from this workspace.

## Validation

- PASS: memory retrieval completed with prior Torghut release-gate context.
- PASS: NATS context soak with `/usr/local/bin/codex-nats-soak` wrote `.codex-nats-context.json`; it fetched 25
  general-channel messages and filtered 0 relevant messages.
- PASS: open PR inventory from
  `gh pr list -R proompteng/lab --state open --limit 100 --json number,title,headRefName,baseRefName,...`.
- PASS: `gh pr view 5412 -R proompteng/lab --json ...` reports head
  `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, `CLEAN`, `MERGEABLE`, 8,074 additions, and 617 deletions.
- PASS: `gh pr checks 5412 -R proompteng/lab --watch --interval 20` reports all non-skipped checks passing,
  including `Bytecode + pytest + coverage`, `Pyright`, `Quality signals (complexity + security)`,
  `agents-ci / integration` after 14m46s, `agents-ci / validate`, `jangar-ci / lint-and-typecheck / run`,
  `check_changed_files`, semantic commits, and semantic PR title.
- PASS: `gh api repos/proompteng/lab/pulls/5412/reviews --paginate` returned no reviews.
- PASS: `gh api graphql ... reviewThreads(first:100)` returned `totalCount=0`.
- BLOCKED: the latest `@codex review` request returned the Codex usage-limit response instead of posting a review.
- PASS: `kubectl get applications.argoproj.io -n argocd torghut torghut-options symphony-torghut ...` reports all
  three apps `Synced` and `Healthy`; final revision evidence is recorded in this run's handoff artifact because main
  continued advancing while this audit branch was rebased.
- PASS: `kubectl get deploy -n torghut ...` reports live, sim, options, websocket, and TA deployments ready and
  available.
- PASS: `kubectl get events -n torghut --sort-by=.lastTimestamp` showed only expected rollout events and transient
  readiness warnings on old scaled-down revisions; new revisions became ready and backfill jobs completed.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq ...` reports the runtime build,
  proof floor, live-submission gate, TCA route evidence, and capital state.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq ...` returns HTTP 200
  with schema `torghut.consumer-evidence-status.v1`, fresh empirical jobs, and candidate
  `chip-paper-microbar-composite@execution-proof`.
- LIMITATION: this service account cannot read Knative `services.serving.knative.dev` or `revisions.serving.knative.dev`;
  rollout verification used Argo CD Application state, Deployments, Pods, events, and in-cluster HTTP service access.

## Deployment evidence

- No new rollout was triggered from #5412 because no merge occurred.
- Audit PR #6066 merge revision: `f45234fc501469f947ad8c055e50ebfb95e6565f`.
- Current main revision: `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace`.
- Current main subject: `chore(release/4afde74): automated release PR (#6077)`.
- Current main changes after #6066 include #6071, `docs(torghut): refresh quant release hold`; #6073,
  `chore(torghut): promote image 171fa3f1`; #6076, `chore(release/b467628): automated release PR`; and #6077,
  `chore(release/4afde74): automated release PR`. PR #6073 checks are green and the promoted image is live in
  cluster; #6076 and #6077 are Bilig-only release changes.
- Torghut GitOps image digest in current manifests:
  `sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`.
- Runtime build: `v0.568.5-556-g171fa3f14`.
- Runtime build commit: `171fa3f14ae53adf17f3426d13e7fe3a27cb2438`.
- Active revision from `/trading/status`: `torghut-00304`.
- Argo state:
  - `torghut`: `Synced` / `Healthy`
  - `torghut-options`: `Synced` / `Healthy`
  - `symphony-torghut`: `Synced` / `Healthy`
- Workload readiness:
  - `torghut-00304-deployment`: `1/1` ready, available, and updated
  - `torghut-sim-00402-deployment`: `1/1` ready, available, and updated
  - `torghut-options-catalog`: `1/1` ready, available, and updated
  - `torghut-options-enricher`: `1/1` ready, available, and updated
  - `torghut-ws`, `torghut-ws-options`, `torghut-ta`, and `torghut-ta-sim`: `1/1` ready and available

## Runtime and value-gate evidence

- `post_cost_daily_net_pnl`: no positive live revenue impact can be claimed from this pass. Current runtime remains
  zero-notional; #5412 is the smallest unmerged blocker for additional profit-evidence projection.
- `routeable_candidate_count`: current proof-floor execution TCA dimension reports one routeable symbol candidate and
  the consumer-evidence route reports candidate `chip-paper-microbar-composite@execution-proof`.
- `zero_notional_or_stale_evidence_rate`: capital is held at `zero_notional`, `max_notional=0`, empirical evidence is
  healthy, and quant evidence is informational/degraded with ingestion lag.
- `fill_tca_or_slippage_quality`: execution TCA reports 7,334 orders, 7,245 filled executions, average absolute
  slippage `13.8203637593029676` bps versus the 8 bps guardrail, and route-universe exclusions enforced.
- `capital_gate_safety`: live submission is not allowed; blockers are `simple_submit_disabled` and
  `hypothesis_not_promotion_eligible`.

## Risk

- #5412 remains the main Torghut runtime blocker. Its checks are green, but the required large-diff Codex review is
  not posted.
- The Codex review blocker is outside the local release engineer's control: the connector reports usage limits.
- Runtime trading remains safe but revenue-inactive: proof floor `repair_only`, capital state `zero_notional`, and
  live submission disabled.
- Quant ingestion remains degraded, and alpha readiness is not promotion-eligible.

## Rollback path

- If the current `171fa3f14` rollout becomes unhealthy, open a rollback PR against current `main` that restores the
  previous healthy Torghut digest, then let release automation and Argo CD reconcile. Do not mutate production
  directly from a local shell.
- If #5412 is later merged and regresses runtime health, revert the squash merge through a PR and allow release
  automation plus GitOps reconciliation to promote the reverted image.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`, live submission blocked, and `capital_state=zero_notional` until proof
  floor, alpha readiness, quant evidence, and review gates are all clear.

Rollback triggers:

- Any of `torghut`, `torghut-options`, or `symphony-torghut` becomes Degraded or stuck OutOfSync.
- Live/sim/options/websocket/TA workloads lose readiness after the startup window.
- `/healthz`, `/trading/status`, or `/trading/consumer-evidence` regresses from HTTP 200.
- Proof floor advances capital away from zero before the documented gates clear.

## Next action

Restore Codex review capacity or record an explicit maintainer waiver for #5412. Then rerun #5412 hosted checks,
resolve any review findings, squash-merge only if all checks are green, and verify the resulting release PR plus Argo
CD rollout before declaring the Torghut quant PR production-ready.
