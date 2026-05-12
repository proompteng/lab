# Torghut Quant Verify Report - 2026-05-12

## Scope

- Mission branch: `codex/swarm-torghut-quant-verify`
- Repository: `proompteng/lab`
- Base branch: `main`
- Release engineer: Julian Hart
- Objective: make Torghut PRs production-ready, merge only green PRs, and verify GitOps rollout health.
- Governing runtime requirement: increase routeable post-cost profit evidence and live trading readiness without
  weakening capital safety.
- Value gates: `post_cost_daily_net_pnl`, `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

## 2026-05-12T22:05Z Release Gate Update

Governing Torghut requirements:

- `docs/torghut/design-system/v6/188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`
  requires observe-mode route evidence clearinghouse packets, zero-notional repair bids, and no widening of live
  submission defaults while source freshness, TCA, image proof, routeability, or capital evidence is unsettled.
- `docs/torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
  requires evidence-clock arbitration and routeable candidate exchange evidence at the Jangar action boundary.
- `docs/torghut/design-system/v6/189-torghut-clock-settled-repair-execution-and-routeability-reentry-2026-05-12.md`
  requires clock-settlement receipts to keep `max_notional=0` while ClickHouse, TCA, empirical, promotion, rollout,
  custody, or capital clocks are stale, missing, split, or blocked.

Selected PR:

- `#6235` `feat(torghut): settle route evidence clocks`
  - URL: `https://github.com/proompteng/lab/pull/6235`
  - Current head: `e329cfe618b4af3d91f8467dbff2c45a45a163cb`
  - Diff: 3,384 additions and 234 deletions across 18 files.
  - Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
    `fill_tca_or_slippage_quality`, `capital_gate_safety`, and later `post_cost_daily_net_pnl` once accepted route
    claims settle into paper or live receipts.

Merge decision:

- No-go at this checkpoint.
- The PR is conflict-free and all visible Codex review threads are resolved.
- Current-head CI is nearly green: Torghut changed-file plan, bytecode/lint/migration guard, Pyright, all pytest
  shards, aggregate bytecode/pytest/coverage, quality signals, Jangar lint/typecheck, semantic title, semantic commit
  lint, changed-files, and agents validate are passing.
- Remaining CI gate: `agents-ci / integration` is still running.
- Large-diff review gate remains blocked. The latest posted Codex review covered `f05f2a4922`; latest-head review
  requests for the current `e329cfe` head returned the Codex usage-limit response. Because the PR exceeds 1,000 changed
  lines, do not squash merge until a latest-head Codex review posts or repo ownership explicitly waives that gate.

Current cluster evidence before any #6235 rollout:

- Argo CD at revision `516d3f5dc93e92f90fdc169cd335b5dde8a8a944`:
  - `agents`: `Synced` / `Healthy`
  - `agents-ci`: `Synced` / `Healthy`
  - `jangar`: `Synced` / `Healthy`
  - `torghut`: `Synced` / `Degraded`
  - `torghut-options`: `Synced` / `Healthy`
- Workloads:
  - Current live Knative deployment `torghut-00325-deployment`: `1/1` deployment available, pod `2/2 Running`,
    zero restarts.
  - Current sim Knative deployment `torghut-sim-00423-deployment`: `1/1` deployment available, pod `2/2 Running`,
    zero restarts.
  - Options catalog, options enricher, options TA, TA, TA sim, websocket, and websocket-options deployments are
    available with zero restarts on the observed pods.
  - The service account can list deployments and pods, but cannot list Knative `services`, `revisions`, or `routes`, so
    those app-health internals remain an RBAC evidence gap.
- Runtime endpoints:
  - `GET /readyz`: HTTP 503 with `status=degraded`, scheduler/database/ClickHouse/Alpaca ok, but live submission and
    profitability proof floor fail closed.
  - `GET /trading/status`: HTTP 200, `running=true`, `mode=live`, `live_submission_gate.allowed=false`,
    `reason=simple_submit_disabled`, blockers
    `alpha_readiness_not_promotion_eligible`, `empirical_jobs_not_ready`, and `simple_submit_disabled`.
  - `GET /trading/status` routeable exchange summary: `routeable_candidate_count=0`,
    `zero_notional_repair_lot_count=9`, `rejected_candidate_count=3`.
  - `GET /trading/consumer-evidence`: HTTP 200, schema `torghut.consumer-evidence-status.v1`, max notional `0`.
    The #6235 fields `evidence_clock_arbiter`, `routeable_profit_candidate_exchange`, and
    `clock_settlement_receipt` are not present before merge.
  - Jangar quant health for `account=paper&window=1d`: `status=degraded`, `latestMetricsCount=0`,
    `emptyLatestStoreAlarm=true`.
  - `/metrics`: `torghut_trading_execution_clean_ratio 1.0`, `torghut_trading_execution_reject_ratio 0.0`,
    `torghut_trading_signal_continuity_actionable 0`, `torghut_trading_signal_continuity_alert_active 0`, and
    `torghut_trading_universe_symbols_count 8`.

Runtime and business-value judgment:

- No #6235 production rollout has occurred because the merge gate is closed.
- Capital safety is intact: live submission remains disabled and max notional remains `0`.
- Revenue impact is blocked. The smallest blockers are the pending `agents-ci / integration` check, the latest-head
  Codex review usage-limit failure for the large diff, and live runtime evidence showing
  `routeable_candidate_count=0` with degraded quant latest-store evidence.

Rollback and next action:

- If #6235 later merges and rollout degrades, revert the squash commit through PR flow or disable downstream
  consumption of `route_evidence_clearinghouse_packet`, `routeable_profit_candidate_exchange`, and
  `clock_settlement_receipt`.
- Do not loosen proof-floor, live-submission, source freshness, TCA/slippage, image proof, custody, clock, notional, or
  capital gates as rollback.
- Wait for `agents-ci / integration`; if it fails, fix the smallest failing surface and rerun.
- If CI goes green, continue holding the merge until a latest-head Codex review posts or repo ownership explicitly
  waives the large-diff gate.

## 2026-05-12T20:15Z Release Gate Update

Governing Torghut requirement:
`docs/torghut/design-system/v6/188-torghut-profit-freshness-frontier-and-zero-notional-repair-market-2026-05-12.md`
keeps profit-freshness repair candidates zero-notional until routeability, freshness, settlement, and capital gates
close. `services/torghut/README.md` also requires the live submission gate to fail closed when proof or capital
evidence is not ready.

Selected PRs and outcomes:

- `#6228` `feat(torghut): rank repairs by daily pnl unlock`
  - Squash-merged at 2026-05-12T19:03:11Z as `7be1d778fd0b9212cf6b78dcf215636943a16ee3`.
  - Value gate: improves `post_cost_daily_net_pnl` repair ranking evidence without widening notional authority.
- `#6230` `chore(torghut): promote image 7be1d778`
  - Squash-merged at 2026-05-12T19:09:26Z as `3872ae7678c5df28ff0e2ea47345c51d12c9245a`.
  - Promoted digest `sha256:ef3bf5c4ddec89906139a16ff9c4119652307ea9d57e6dbf11d286ee10d34302`.
  - Post-deploy run `25756326344` failed because the verifier required `torghut` Argo health `Healthy`; the live
    runtime was in the intended repair-only zero-notional posture rather than crashing.
- `#6234` `revert(torghut): rollback failed promotion 3872ae7678c5df28ff0e2ea47345c51d12c9245a`
  - Squash-merged at 2026-05-12T19:29:12Z as `8dc6088a1e2c8effaab41ed75fb7ab23a63e38ec`.
  - Rollback was a false rollback path. It restored digest `5f7e43b4...`, caused options catalog/enricher crash
    restarts during PostgreSQL connection refusal, and left the `torghut` Argo operation stuck on the old
    `torghut-db-migrations` hook.
- `#6225` `revert(torghut): rollback failed promotion 29f7cf8cbd0872812f2dcdd5d0a5d8a12eccec7e`
  - Closed unmerged at 2026-05-12T19:43Z. It was stale after `#6234` and would have restored an even older image.
- `#6236` `fix(torghut): restore quant promotion gate`
  - Squash-merged at 2026-05-12T19:53:04Z as `6f9a79a7604f49aa5fa16af88c2b2ce77251c59d`.
  - Restored the `#6230` promoted digest and added a tested post-deploy validator that accepts only the documented
    repair-only zero-notional 503 posture. Database outages and unexpected dependency failures still fail the gate.
  - All non-skipped PR checks were green: semantic commits/title, `argo-lint`, `kubeconform`,
    `packages-scripts`, `symphony`, torghut-ci `Pyright`, bytecode/lint/migration guard, all pytest shards,
    quality signals, and bytecode/pytest/coverage aggregate.
- `#6239` `chore(torghut): promote image 6f9a79a7`
  - Squash-merged at 2026-05-12T19:59:33Z as `17aac423b975dfd1876f96ba579f58c6aef4020d`.
  - Promoted digest `sha256:20aa3787c6157d79d1d37658c5e71d7f80cdbfdbf8749f1e53a0d73dc416ab9c`.
  - Superseded by `#6242` before `torghut` could complete sync; `torghut` remained blocked by the stale `#6234` Argo
    operation.
- `#6237` `fix(torghut): stop options status table probes`
  - Squash-merged at 2026-05-12T20:02:47Z as `767917346dbc3a76451b3b02fc83c9ca05127bc9`.
  - Value gate: improves data freshness and execution quality by keeping options status heartbeats from issuing
    expensive exact hot-table counts.
  - All non-skipped PR checks were green, including torghut-ci Pyright, bytecode/lint/migration guard, all pytest
    shards, quality signals, bytecode/pytest/coverage, agents-ci, and Jangar typecheck.
- `#6242` `chore(torghut): promote image 76791734`
  - Squash-merged at 2026-05-12T20:09:08Z as `5283faf6db212e738a695020114e1277de040059`.
  - Promoted digest `sha256:1068d291e94e78f12b149533021eff27f9ebb7ff81b8e7e5f540350405bec161`.
  - `torghut-options` synced to `5283faf6db212e738a695020114e1277de040059`; `torghut` did not complete sync
    because the stale `#6234` Argo operation remained Running.
  - Post-deploy run `25759337606` was canceled at 2026-05-12T20:14:33Z while the verify step was still waiting on the
    stale Argo operation. Rollback steps were skipped, avoiding a second false rollback PR.

Post-merge evidence at 2026-05-12T20:15Z:

- GitOps:
  - `torghut`: `OutOfSync` and `Degraded`, target revision
    `5283faf6db212e738a695020114e1277de040059`.
  - `torghut` stale operation: phase `Running`, message
    `waiting for completion of hook batch/Job/torghut-db-migrations`, operation revision
    `8dc6088a1e2c8effaab41ed75fb7ab23a63e38ec`, sync result revision
    `8dc6088a1e2c8effaab41ed75fb7ab23a63e38ec`.
  - The `torghut-db-migrations` job no longer exists in namespace `torghut`.
  - `torghut-options`: `Synced` and `Degraded` at
    `5283faf6db212e738a695020114e1277de040059`; deployment rollouts are complete.
  - Local service account cannot hard-refresh the Argo app:
    `applications.argoproj.io "torghut" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot patch`.
- Workloads:
  - `torghut-00324-deployment-5748777694-2kzpc`: `2/2 Running`, zero restarts.
  - `torghut-sim-00422-deployment-758579575d-hf9kw`: `2/2 Running`, zero restarts.
  - `torghut-db-1`: `1/1 Running`.
  - `torghut-options-catalog-7d8799f6b4-c6pzs`: `1/1 Running`, zero restarts, serving digest
    `sha256:1068d291e94e78f12b149533021eff27f9ebb7ff81b8e7e5f540350405bec161`.
  - `torghut-options-enricher-84bfb8ccf7-g5czm`: `1/1 Running`, zero restarts, serving digest
    `sha256:1068d291e94e78f12b149533021eff27f9ebb7ff81b8e7e5f540350405bec161`.
  - `torghut-ws-856cffd8d4-829dt`: `1/1 Running`, zero restarts.
- Runtime endpoints:
  - `GET /readyz`: HTTP 503 accepted by the new validator as `repair_only_zero_notional`.
  - `GET /trading/status`: HTTP 200, version `v0.569.1-14-g7be1d778f`, commit
    `7be1d778fd0b9212cf6b78dcf215636943a16ee3`, active revision `torghut-00324`. The main Torghut service has not
    yet rolled to `#6242`.
  - `GET /trading/revenue-repair`: HTTP 200, `business_state=repair_only`, `revenue_ready=false`,
    `capital_state=zero_notional`, `max_notional=0`.
  - `GET torghut-ws /readyz`: HTTP 200.
  - `GET torghut-options-catalog /healthz`: HTTP 200 with `ready=true`.
  - `GET torghut-options-enricher /readyz`: HTTP 200 with `ready=true`.
- Value gates:
  - `routeable_candidate_count` remains effectively zero; the route board has `row_count=8`,
    `zero_notional_row_count=8`, `capital_eligible_symbol_count=0`, and `expected_unblock_value=14`.
  - `zero_notional_or_stale_evidence_rate` remains blocking because capital is clamped to zero-notional repair.
  - `capital_gate_safety` held: live submission is disabled by `simple_submit_disabled` and max notional is `0`.
  - `fill_tca_or_slippage_quality` remains a repair gate: execution TCA excludes 7 symbols, with one probing symbol
    (`AAPL`), 4 blocked symbols, and 3 missing symbols.
  - `post_cost_daily_net_pnl` has better repair ranking evidence from `#6228`, but revenue remains unrealized while
    capital and routeability stay blocked.

Gate judgment:

- Merge gate for `#6236`: complete and green.
- Merge gate for `#6237`: complete and green.
- Image promotion gate for `#6242`: partially applied. `torghut-options` is synced and serving the promoted digest;
  `torghut` is blocked before completing sync.
- Production rollout gate: no-go. The smallest blocker is stale Argo operation state on `torghut`, left over from the
  false rollback `#6234`, not a current runtime database outage.
- Revenue impact: no realized revenue impact can be claimed while `routeable_candidate_count=0` and capital remains
  zero-notional.

Rollback and unblock path:

- Do not merge stale rollback PRs or manually mutate production manifests from a local shell.
- Keep `#6236` in place; it prevents repair-only zero-notional from opening a false rollback while still failing real
  database outages.
- Smallest operational unblocker: an Argo operator with `argocd` application permissions should terminate or clear the
  stale `torghut` operation for revision `8dc6088a1e2c8effaab41ed75fb7ab23a63e38ec`, then let Argo sync
  `5283faf6db212e738a695020114e1277de040059` and rerun `torghut-post-deploy-verify`.
- Rollback trigger after the stale operation is cleared: if the `#6242` image syncs and the new validator reports a
  non-repair-only dependency failure, revert `#6242`, then the underlying runtime changes, through PR flow.

## PR Inventory

Open PRs reviewed on May 12, 2026:

- `#6127` `feat(torghut): add routeability and profit freshness ledgers`
  - No merge. Torghut and Jangar owned checks were passing and a Codex review was posted at current head, but
    `agents-ci / integration` was still pending, so the merge gate was no-go.
- `#5889` `feat(jangar): add repair and action custody receipts`
  - No merge. A Codex review was posted, but hosted checks were still pending (`lint-and-typecheck / run`,
    `agents-ci / validate`, and `agents-ci / integration` during this run), so the merge gate was no-go.
- `#6204` `revert(torghut): rollback failed promotion 078913a5ab4b50537b9da68076d8d8c8010a4dde`
  - Selected and merged. This was an immediate production-safety rollback for a failed Torghut post-deploy
    verification.
- `#6182` `revert(torghut): rollback failed promotion 2d5e1bed5362cce967642852701ec9497fd00025`
  - Selected and merged after `#6204`. This removed the stale whitepaper autoresearch worker parameter so the
    restored image and workflow contract match.
- `#6200` `chore(release/5df7f45): automated release PR`
  - Not selected. It did not map to the Torghut quant release gate or a blocked value gate in this run.

## Merge Decisions

- `#6204` was mergeable/CLEAN, not draft, with all non-skipped checks passing. Diff size was 48 changed lines, so the
  large-diff Codex review gate did not apply. Squash-merged at `4dc0931d7dbe64586e370a44bd01938552397fa6`.
- `#6182` was rechecked after `#6204` landed and recalculated mergeable/CLEAN with all non-skipped checks passing.
  Diff size was 4 deleted lines, so the large-diff Codex review gate did not apply. Squash-merged at
  `35b587bb960293569baf16777d16656d2d60af57`.
- The final desired GitOps state restores Torghut and Torghut options workloads to
  `registry.ide-newton.ts.net/lab/torghut@sha256:8df63effdac2da1874d3c4187638d4f647b08a8d20c295f7ac631b57618e1712`
  and runtime commit `2d9cb139af126c4089728b0c7e70c3611d5eeb49`.

## Rollout Evidence

- Argo CD:
  - `torghut`: `Synced` to `35b587bb960293569baf16777d16656d2d60af57`, operation `Succeeded`, app health
    `Degraded`.
  - `torghut-options`: `Synced` to `35b587bb960293569baf16777d16656d2d60af57`, health `Healthy`.
- Workloads on rollback digest with zero restarts:
  - `torghut-00322-deployment-7d7dc55dbb-x2fch`: `2/2 Running`, `user-container` and `queue-proxy` ready,
    `restarts=0`.
  - `torghut-sim-00420-deployment-64c9b768b-tzksh`: `2/2 Running`, `user-container` and `queue-proxy` ready,
    `restarts=0`.
  - `torghut-options-catalog-85f6ddb7d5-dzfsd`: `1/1 Running`, `restarts=0`.
  - `torghut-options-enricher-67fc56cb6b-pj99d`: `1/1 Running`, `restarts=0`.
- GitOps jobs and events:
  - `torghut-db-migrations` completed successfully on the rollback digest.
  - Argo sync result reported both Knative Services `torghut` and `torghut-sim` healthy during sync.
  - Namespace events showed transient startup/readiness 503s during revision replacement, followed by
    `RevisionReady` for `torghut-00322` and `torghut-sim-00420`.
- Health endpoints:
  - Live `GET /healthz`: 200.
  - Live `GET /readyz`: 503.
  - Sim `GET /healthz`: 200.
  - Sim `GET /readyz`: 200.
  - Options catalog `GET /readyz`: 200.
  - Options enricher `GET /readyz`: 200.
  - Live `GET /trading/consumer-evidence`: 200 with canary state `current`.

## Runtime And Business Evidence

- Live readiness is still no-go:
  - `live_submission_gate.allowed=false`
  - `live_submission_gate.reason=simple_submit_disabled`
  - blockers: `alpha_readiness_not_promotion_eligible`, `empirical_jobs_not_ready`, and `simple_submit_disabled`
  - `profitability_proof_floor.detail=repair_only`
  - `capital_state=zero_notional`
- Quant evidence is partially fresh but degraded:
  - live latest metrics count: `180`
  - live latest metrics updated at: `2026-05-12T17:44:10.689Z`
  - live metrics pipeline lag seconds: `8`
  - max stage lag seconds: `354012`
  - reason: `quant_pipeline_degraded`
- Routeability and capital gates:
  - live `routeable_candidate_count=0`
  - live `zero_notional_quorum_count=3`
  - live `blocked_or_stale_evidence_count=14`
  - live route reacquisition has 8 scoped symbols, 1 probing candidate (`AAPL`), 7 repair candidates, and expected
    unblock value `14`.
- Consumer evidence:
  - `source_commit=2d9cb139af126c4089728b0c7e70c3611d5eeb49`
  - `serving_revision=torghut-00322`
  - `proof_floor_state=repair_only`
  - `route_state=repair_only`
  - `capital_state=zero_notional`
  - `route_repair_value=14`
  - `paper_readiness_state=blocked`
  - `live_readiness_state=blocked`
- Revenue repair digest:
  - `business_state=repair_only`
  - `revenue_ready=false`
  - `max_notional=0`
  - repair queue begins with route universe repair, signal freshness repair, alpha readiness repair, quant ingestion
    repair, and market-context repair.

## CI And Post-Deploy Gate

- PR checks for `#6204` and `#6182` passed before merge.
- `torghut-ci` on the final merge commit `35b587bb960293569baf16777d16656d2d60af57` completed successfully.
- `torghut-post-deploy-verify` for `35b587bb960293569baf16777d16656d2d60af57` failed in run `25751186364`.
  The failed step was `Verify Argo applications, workloads, and health endpoints`.
- Failure evidence: after 90 attempts, the verifier reported
  `Argo application torghut did not become Synced/Healthy with expected revision`. The app stayed `Synced` but
  `Degraded`; during the run, `main` also advanced through `fd173f5528299837fda378297d457e11188cb763`.
- No additional rollback PR was opened by the workflow because the final commit subject was already
  `revert(torghut): ...`.

## Risk

- The rollback restored the previous image and removed the stale workflow parameter, so the failed promotion is no
  longer serving.
- The production rollout cannot be called fully healthy because the live readiness gate still fails closed with
  zero-notional capital state.
- The app-level Argo health remains `Degraded` even though the selected rollout resources are synced and serving the
  rollback digest. This is the explicit post-deploy verifier blocker.
- No capital safety was weakened: live submission remains disabled, live promotion is not eligible, and max notional
  remains `0`.

## Rollback Path

- If the rollback digest regresses, revert `#6182` and `#6204` in reverse order through PR flow and let Argo CD
  reconcile.
- If the current no-go state is caused by stale evidence rather than the rollback, keep the rollback in place and repair
  the evidence lanes: route/TCA, signal freshness, alpha readiness, quant ingestion, market context, and empirical job
  receipts.
- Do not manually mutate production manifests from a local shell; keep promotion and rollback through PR merge and
  GitOps reconciliation.

## Next Action

- Treat Torghut release health as no-go until live `/readyz` returns 2xx and `torghut-post-deploy-verify` is green.
- The smallest blocker preventing revenue impact is stale/blocked evidence with `routeable_candidate_count=0` and
  zero-notional capital state, not the rollback image deployment.
