# 193. Jangar Cross-Plane Closure Board And Revenue Repair Admission (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane closure board, AgentRun launch admission, source-to-serving rollout truth, Torghut
revenue-repair dispatch, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`

Extends:

- `docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`
- `docs/agents/designs/192-jangar-source-to-serving-promotion-closure-and-repair-value-accounting-2026-05-13.md`
- `docs/agents/designs/192-jangar-alpha-readiness-repair-escrow-and-runner-admission-2026-05-13.md`
- `docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`

## Decision

I am selecting a **cross-plane closure board** as the next Jangar control-plane architecture increment.

The current live system is serving, but it is still not allowed to spend material launch capacity broadly. On
2026-05-14, `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election was active, and
execution trust was healthy. The richer control-plane status route reported all three controllers enabled and started,
database health green, `29/29` Kysely migrations applied, rollout health green for `agents` and `agents-controllers`,
and watch reliability healthy with `943` events and zero watch errors in the 15 minute window. Argo also settled after
rollout churn: `agents`, `jangar`, and `torghut` were `Synced/Healthy`.

That is good serving evidence, but it is not material-readiness evidence. Ready truth still held `dispatch_repair`,
`dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; it blocked `live_micro_canary` and `live_scale`.
The reason list is too broad for a worker to act on safely: source CI retention missing, manifest SHA missing,
source-serving build mismatch, manifest image digest missing, source rollout truth missing, desired live image mismatch,
controller heartbeat not current for material authority, Torghut repair lots unsettled, evidence-clock split, alpha
readiness not promotion eligible, stale execution TCA, missing market-context evidence, missing feature rows, and zero
notional capital state.

The selected board turns that wide reason surface into one ranked, expiring closure object per action class. It does
not replace ready truth, stage credit, source-serving verdicts, or Torghut revenue repair. It reads them, ranks the
next receipt, and produces the smallest allowed work item for engineer and deployer stages. A held `merge_ready` should
say "repair source rollout truth and attach source CI plus manifest digest receipt" instead of emitting a long list. A
held Torghut repair should say "spend one zero-notional runner on the live revenue-repair top item and require
`torghut.executable-alpha-receipts.v1`" instead of letting dispatch priority drift away from the business queue.

The tradeoff is that some useful work remains held until it can name a closure receipt. I accept that tradeoff.
Jangar's business metric is not launch volume. It is fewer failed AgentRuns and shorter green PR-to-healthy GitOps
rollout time. A specific missing receipt is cheaper than a failed verify timeout or another manual debate over whether
`/ready=ok` is sufficient.

## Governing Runtime Requirements

This contract implements the active validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

The value-gate mapping is explicit:

- `failed_agentrun_rate`: deny launches whose closure board has no current receipt target or has active duplicate debt.
- `pr_to_rollout_latency`: require merge and deploy closures to carry source CI, manifest digest, Argo, workload, and
  service readiness receipts before calling the rollout healthy.
- `ready_status_truth`: keep serving readiness separate from material readiness and expose the reason a green `/ready`
  still holds action classes.
- `manual_intervention_count`: rank one next receipt and one smallest repair action so operators do not triage broad
  reason-code lists by hand.
- `handoff_evidence_quality`: require every engineer and deployer handoff to cite the board id, selected closure lot,
  expected receipt, validation command, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, AgentRuns, or market data.

### Cluster, Rollout, And Events

- Working branch: `codex/swarm-jangar-control-plane-discover`, initially identical to `origin/main`
  `16d4cac22ddd6c29f219f42273597143ad36156e`.
- The same head branch has many merged prior architecture PRs. The latest retrieved memory was PR #6485, which merged
  promotion closure accounting at `03919d52173be2e899590decdd63dbb7893ac726`.
- Kubernetes identity: `system:serviceaccount:agents:agents-sa` from the current AgentRun pod.
- `kubectl config current-context` was initially unset; an in-cluster local context was bootstrapped from the service
  account token for read-only checks.
- Argo at the first check had `agents=Synced/Progressing` while the `202dcaf1` rollout was replacing pods. A follow-up
  check after rollout showed `agents`, `jangar`, and `torghut` all `Synced/Healthy`.
- `agents` deployments settled to `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent events included transient readiness probe timeouts on terminating `agents` and `agents-controllers` pods
  during rollout, then successful image pulls, pod starts, and deployment scale-down of old replicas.
- Recent AgentRuns since `2026-05-13T00:00:00Z` summarized to `90` Succeeded, `9` Failed, and `5` Running across the
  retained set.
- Jangar control-plane AgentRuns in the same window summarized to `43` Succeeded, `3` Failed, and `3` Running.
- The failed Jangar runs were one `BackoffLimitExceeded` implement run and two verify `WorkflowStepTimedOut` runs.
- Torghut quant AgentRuns in the same window summarized to `41` Succeeded, `2` Failed, and `2` Running; both failures
  were verify timeouts.
- Torghut market-context fundamentals had four `BackoffLimitExceeded` failures, reinforcing that repair dispatch needs
  dedupe, bounded receipts, and value ordering.

### Runtime And Source

- `GET /ready` on the agents service returned `status=ok`, leader election enabled, execution trust healthy, Torghut
  consumer evidence current, and serving runtime proof cells healthy.
- The `/ready` payload's serving-process controller fields were disabled, while `GET /api/agents/control-plane/status`
  reported `agents-controller`, `supporting-controller`, and `orchestration-controller` all enabled, started, and CRD
  ready. The board treats that as a reason to prefer the richer status route for material authority.
- Control-plane status reported database `healthy`, `latency_ms=3`, and migration consistency `healthy`.
- Rollout health reported `2` configured deployments healthy and `0` degraded deployments.
- Watch reliability reported `943` events, `0` errors, and `0` restarts across five streams.
- Ready truth stayed in `shadow` mode with `serving_readiness=ok` and `material_readiness=hold`.
- Ready truth allowed `serve_readonly` and `torghut_observe`, held `dispatch_repair`, `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked `live_micro_canary` and `live_scale`.
- Source-serving verdict status was `block`. It had `source_sha=202dcaf121682eb87e1e7744b3ed14817a3e3f0e`,
  `serving_build_commit=645366cfdf00598b15f5a7b4caa220e223af2251`, no manifest image digest, and reason codes
  `source_ci_retention_receipt_missing`, `manifest_sha_missing`, `source_serving_build_mismatch`, and
  `manifest_image_digest_missing`.
- Projection foreclosure still held material authority with claim totals `authoritative=17`, `grace=5`,
  `stale_foreclosed=62`, `contradictory=1`, and `missing_receipt=1`.
- Stage credit for deploy and merge was held by missing source rollout truth, desired live image mismatch, controller
  heartbeat not current, source rollout truth hold, and insufficient stage credit.
- High-risk source modules remain broad: `supporting-primitives-controller.ts` is `3347` lines,
  `torghut-market-context-agents.ts` is `1980` lines, `torghut-simulation-control-plane.ts` is `1740` lines,
  `control-plane-status.ts` is `744` lines, `control-plane-torghut-consumer-evidence.ts` is `758` lines,
  `control-plane-projection-foreclosure-notary.ts` is `691` lines, and `control-plane-ready-truth-arbiter.ts` is
  `478` lines.
- The test surface is broad for individual reducers, including ready truth, stage credit, projection foreclosure,
  source-serving verdicts, repair-bid admission, rollout proof passports, and Torghut consumer evidence. The missing
  test family is cross-plane closure ranking: given all current holds, one reducer should pick the next receipt for
  each action class and prove no-delta repairs do not keep consuming runner slots.

### Database, Data Quality, And Freshness

- Direct CNPG cluster reads were forbidden for this service account in both `agents` and `torghut`, and pod exec was
  forbidden. That is an intentional least-privilege constraint for this lane.
- Jangar database status through the application route was healthy: connected, `29` registered migrations, `29`
  applied migrations, no unapplied migrations, and no unexpected migrations.
- Latest Jangar migration was `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- `GET http://torghut.torghut.svc.cluster.local/db-check` returned `ok=true`, `schema_current=true`, current and
  expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads,
  lineage ready, and account scope ready.
- Torghut schema quality still carries known parent-fork warnings for historical migration branches under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `GET http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `status=degraded`, while Postgres,
  ClickHouse, Alpaca, database schema, universe, readiness cache, DSPy runtime, empirical jobs, and quant evidence as
  optional were healthy.
- Torghut live submission stayed blocked by `simple_submit_disabled`; profitability proof floor was `repair_only`;
  capital stayed `zero_notional`; active capital stage was `shadow`.
- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned `revenue_ready=false`,
  `business_state=repair_only`, and top queue item `repair_alpha_readiness` with reason
  `hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`, expected unblock value `4`, and
  required output receipt `torghut.executable-alpha-receipts.v1`.
- Jangar `/ready` saw Torghut consumer evidence current with decision `repair`, `route_repair_value=14`,
  `routeability_aggregate_state=blocked`, selected compacted lots, three dispatchable lots, and blockers including
  `quant_health_not_configured`, stale execution TCA, non-positive post-cost expectancy, feature rows missing,
  required feature set unavailable, and alpha readiness not promotion eligible.

## Problem

The system now has useful truth surfaces, but no one object turns them into a ranked action closure. That gap creates
five concrete failure modes.

First, serving readiness can be green while material readiness is held. Engineers see `/ready=ok`, while the
action-class truth still says merge, deploy, dispatch, and paper canary are held.

Second, rollout health can settle after Argo reports Progressing, but deployer handoff still has to gather Argo
health, workload readiness, status route, source-serving verdict, stage credit, and service health manually.

Third, source-to-serving proof can be split. The current source SHA is `202dcaf1`, while the Torghut serving build
commit seen by Jangar is `645366cfd`; manifest SHA and image digest are missing from the status proof.

Fourth, Torghut revenue repair can name a top queue item, but Jangar still sees many other reason codes and selected
repair lots. Without a board, runner capacity can chase static repair order instead of the current revenue blocker.

Fifth, failure debt is retained but not ranked into launch denial. The last 24 hours show the system is mostly
successful, yet the failure tail is exactly the class that should stop automatic retries without a new receipt.

The control-plane needs a closure board that converts "held" into one next receipt, one allowed repair, one validation
command, and one rollback target.

## Alternatives Considered

### Option A: Keep Existing Ledgers And Improve The Handoff

This option leaves ready truth, stage credit, source-serving verdicts, projection foreclosure, and Torghut revenue
repair separate. Engineers and deployers would use handoff text to decide which field matters.

Advantages:

- Lowest implementation cost.
- Preserves current reducer boundaries.
- Useful while the system is already visible through status routes.

Disadvantages:

- Keeps manual interpretation in the hot path.
- Does not reduce failed AgentRuns before launch.
- Makes green PR-to-healthy evidence depend on human synthesis.
- Does not force no-delta repair accounting.

Decision: reject. Better handoff text helps audits, but it does not change admission behavior.

### Option B: Hard Freeze Material Work Until Every Proof Is Green

This option blocks dispatch, deploy widening, merge-ready, and paper canary whenever any source, projection, stage
credit, Torghut, or failure debt input is not green.

Advantages:

- Strong safety posture.
- Simple incident rule.
- Prevents launches against known source-serving mismatch.

Disadvantages:

- Freezes zero-notional repair work that is required to clear Torghut's revenue blockers.
- Increases manual intervention because every held surface becomes a human escalation.
- Does not rank the first proof to produce.
- Slows PR-to-rollout feedback when serving and observe-only work is healthy.

Decision: reject as the steady-state architecture. Keep it as an emergency brake.

### Option C: Cross-Plane Closure Board

The selected option builds a pure reducer that consumes existing ledgers and emits ranked closure lots for each action
class.

Advantages:

- Preserves serving availability while preventing material launch ambiguity.
- Converts broad reason-code lists into one next receipt per action class.
- Lets zero-notional Torghut repair proceed only when the live revenue-repair queue names it as the top blocker.
- Makes no-delta repairs burn credit and require a changed receipt before another launch.
- Gives deployers one board id to cite for green PR-to-healthy claims.

Disadvantages:

- Adds one more status object and test family.
- Requires stable receipt naming across Jangar and Torghut.
- May initially hold work that used to run opportunistically.

Decision: select Option C.

## Architecture

The board is a read-model reducer first. It has no side effects in its first implementation.

```text
cross_plane_closure_board
  schema_version = jangar.cross-plane-closure-board.v1
  board_id
  generated_at
  fresh_until
  namespace
  mode = observe | shadow | hold | enforce
  governing_design_refs[]
  source_serving_verdict_ref
  ready_truth_verdict_ref
  stage_credit_ledger_ref
  projection_foreclosure_notary_ref
  torghut_revenue_repair_ref
  rollout_health_ref
  database_witness_ref
  agentrun_failure_window_ref
  action_closures[]
  selected_next_closure
  rollback_target
```

Each `action_closure` is stable enough for tests and handoff:

```text
action_closure
  closure_id
  action_class = serve_readonly | dispatch_repair | dispatch_normal | deploy_widen |
                 merge_ready | torghut_observe | paper_canary | live_micro_canary | live_scale
  decision = allow | repair_only | hold | block
  selected_reason_code
  required_receipt
  expected_delta
  value_gates[]
  evidence_refs[]
  validation_commands[]
  max_notional
  dedupe_key
  no_delta_policy
  rollback_target
```

Ranking rules:

1. `serve_readonly` can remain `allow` if database, rollout, and serving passports are healthy.
2. `torghut_observe` can remain `allow` when Torghut evidence is current even if capital is closed.
3. `merge_ready` and `deploy_widen` must prefer source-to-serving closure over Torghut repair when source SHA,
   manifest SHA, manifest digest, serving build, or Argo revision disagree.
4. `dispatch_repair` can be `repair_only` only when the selected lot has max notional `0`, a fresh business evidence
   ref, a required output receipt, and no active duplicate failure debt.
5. `dispatch_normal`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked while Torghut
   capital state is zero-notional or profitability proof floor is repair-only.
6. A no-delta terminal repair burns credit until a new receipt changes the blocker set, source ref, or evidence time
   window.

## Implementation Scope

M1: Add a pure `buildCrossPlaneClosureBoard` reducer under `services/jangar/src/server`.

- Inputs: ready truth, stage credit, source-serving verdict, projection foreclosure, rollout health, database status,
  AgentRun failure window, and Torghut consumer/revenue repair evidence.
- Output: board schema above.
- Tests: source-serving closure first, revenue-repair dispatch when safe, failure debt duplicate hold, no-delta burn,
  deploy/merge closure receipts.
- Value gates: `ready_status_truth`, `failed_agentrun_rate`, `handoff_evidence_quality`.

M2: Publish the board in control-plane status in observe mode.

- Do not change `/ready` liveness.
- Add compact refs, selected closure id, and action-class decisions.
- Tests: status payload includes board, old consumers continue to parse.
- Value gates: `ready_status_truth`, `manual_intervention_count`, `handoff_evidence_quality`.

M3: Wire schedule-runner admission in shadow mode.

- Compare predicted holds against launches for one full schedule window.
- Do not deny launches yet.
- Tests: schedule runner records board id and governing design ref in planned AgentRun parameters.
- Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

M4: Enforce duplicate failure-debt denial and no-delta repair burn.

- Deny only duplicate active debt and no-delta repeats.
- Allow one zero-notional revenue-repair lot when the board names it as selected.
- Tests: one active dedupe key prevents another launch, changed receipt reopens the lane.
- Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

M5: Make deployer and verify stages require board evidence for green PR-to-healthy claims.

- PR handoff must cite board id, merge/deploy closure ids, Argo sync, workload readiness, service readiness, source
  serving parity, and rollback target.
- Tests: handoff/progress helper fixtures reject missing board refs.
- Value gates: `pr_to_rollout_latency`, `ready_status_truth`, `handoff_evidence_quality`.

## Validation Gates

Local validation for the architecture PR:

- `bunx oxfmt --check docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md docs/torghut/design-system/v6/198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md docs/agents/release-handoffs/jangar-control-plane-cross-plane-closure-board-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`

Engineer implementation validation:

- `bun test services/jangar/src/server/__tests__/control-plane-cross-plane-closure-board.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun test services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts -t closure`
- `bunx oxfmt --check services/jangar/src/server/control-plane-cross-plane-closure-board.ts services/jangar/src/server/__tests__/control-plane-cross-plane-closure-board.test.ts services/jangar/src/server/control-plane-status-types.ts`

Deployer validation after rollout:

- Argo `agents`, `jangar`, and `torghut` `Synced/Healthy`.
- `kubectl rollout status -n agents deployment/agents`.
- `kubectl rollout status -n agents deployment/agents-controllers`.
- `curl -fsS http://agents.agents.svc.cluster.local/ready`.
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status`.
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair`.
- `curl -sS http://torghut.torghut.svc.cluster.local/readyz` and expect degraded until capital gates actually clear.

## Rollout

Phase 0 is this design and handoff only.

Phase 1 publishes the board in observe mode. It must not change launch behavior, `/ready`, or capital state.

Phase 2 records board decisions on scheduled runs without enforcement. The goal is to prove predicted holds match
actual failed or stale launches.

Phase 3 enforces only duplicate active failure debt and no-delta repeat denial. It still allows one zero-notional
repair when Torghut's revenue surface names the selected queue item.

Phase 4 lets verify and deployer stages require board receipts for green PR-to-healthy claims.

## Rollback

Rollback stays configuration-first:

- set `JANGAR_CROSS_PLANE_CLOSURE_BOARD_MODE=observe`;
- if publishing causes status issues, set `JANGAR_CROSS_PLANE_CLOSURE_BOARD_ENABLED=false`;
- keep ready truth, stage credit, source-serving verdicts, and repair-bid admission active;
- do not delete AgentRuns, jobs, receipts, or database rows;
- keep Torghut max notional `0` and live submission disabled until Torghut capital gates independently pass.

## Risks

- Payload growth: status is already large. Mitigation: publish compact refs in status and keep detailed lots behind a
  focused endpoint if needed.
- Over-ranking source-serving proof: Torghut repair could starve if source-serving proof is never current. Mitigation:
  allow observe-only and one zero-notional revenue-repair lot when source-serving mismatch does not change capital
  authority.
- Receipt naming drift: Jangar and Torghut must share receipt names. Mitigation: define constants and tests for
  `torghut.executable-alpha-receipts.v1`, source CI retention, manifest digest, and no-delta receipts.
- Enforcement too early: denial can hide useful repairs. Mitigation: require observe and shadow windows before hold or
  enforce modes.
- Least-privilege blind spots: CNPG and exec are forbidden. Mitigation: the board relies on application database
  witnesses and typed business endpoints, not privileged shell inspection.

## Handoff

Engineer: implement M1 only first. Build the pure reducer and tests. Do not change scheduler enforcement in the first
PR.

Deployer: after M2, treat board evidence as required for green PR-to-healthy claims. Argo health alone is not enough
when `merge_ready` or `deploy_widen` closures are held.

Smallest current implementation milestone: add `buildCrossPlaneClosureBoard` and a test fixture based on the
2026-05-14 evidence in this document. The first acceptance gate is that `merge_ready` selects source-serving closure
while `dispatch_repair` selects the zero-notional `repair_alpha_readiness` path only when Torghut's live
`/trading/revenue-repair` keeps it as the top queue item.
