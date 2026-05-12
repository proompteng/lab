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
