# 197. Jangar Compact Alpha Closure Ingestion And Stage-Credit Repair Gate (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane Torghut evidence ingestion, stage-credit repair gating, no-delta launch denial, rollout
validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md`

Extends:

- `docs/agents/designs/196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md`
- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`

## Decision

I am selecting **compact alpha closure ingestion with a stage-credit repair gate** as the next Jangar control-plane
architecture increment.

The reason is precise: Torghut now emits the high-value alpha closure board, but Jangar does not yet ingest the compact
board reference that should govern repair admission. On 2026-05-14, Argo reported `agents`, `jangar`, and `torghut`
`Synced/Healthy` at main `29f0d1c9fd417fc65666896b6b5433be668c78a5`. The `agents` deployment was `1/1`,
`agents-controllers` was `2/2`, `jangar` was `1/1`, and `GET http://agents.agents.svc.cluster.local/ready` returned
`status=ok` with execution trust healthy.

That serving state is not material launch authority. `GET /api/agents/control-plane/status?namespace=agents` still
reported `ready_action_exchange.status=block`. It allowed only `serve_readonly` and `torghut_observe`; it held
`dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; it blocked
`live_micro_canary` and `live_scale`. Stage credit held normal dispatch, deploy, and merge on source rollout truth,
route stability, controller witness split, and insufficient credit. The repair packet was only `repair_only`, not an
open dispatch grant.

The live Torghut business surface is more actionable than the Jangar projection currently shows.
`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned `business_state=repair_only`,
`revenue_ready=false`, top queue item `repair_alpha_readiness`, value gate `routeable_candidate_count`, required output
`torghut.executable-alpha-receipts.v1`, and max notional `0`. The same payload now included
`alpha_repair_closure_board.status=selected`, board id `alpha-repair-closure-board:ae9a8b5d68641483f4d9b541`,
settlement market `alpha-closure-settlement-market:2b8cebb98cc14f7b9a7dd031`, selected hypothesis `H-MICRO-01`,
selected repair class `feature_replay_closure`, required output `torghut.alpha-closure-settlement-receipt.v1`, and a
no-delta budget in `consumed` state. That is exactly the object Jangar needs to prevent another stale repair launch.

The gap is the projection boundary. Jangar's Torghut consumer evidence listed contracts for route warrants,
repair-bid settlement, repair outcome dividend, source-serving repair receipt, freshness carry, routeability
acceptance, profit repair settlement, routeable profit candidate exchange, alpha readiness strike ledger, and
executable alpha repair receipts. It did **not** include `alpha_repair_closure_board_ref` or
`alpha_evidence_foundry_ref`. Jangar therefore sees current Torghut evidence, but cannot bind stage credit to the
settlement market or the consumed no-delta budget.

The selected design fixes that boundary. Torghut exports a compact, stable, non-ordering alpha closure passport through
consumer evidence. Jangar ingests it, validates freshness and zero-notional safety, and feeds it into stage credit and
material reentry. If the no-delta budget is consumed, Jangar holds the repair slot and names the release condition. If
the budget is available and every source, rollout, and capital safety witness agrees, Jangar can admit exactly one
zero-notional repair slot.

The tradeoff is lower dispatch throughput. A useful repair may wait while the compact passport is missing or no-delta
debt is active. I accept that. The business metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps
rollout time. Repeating a consumed no-delta closure is worse than holding until source revision, blocker set, evidence
window, or required receipt set changes.

## Governing Runtime Requirements

This contract implements the active swarm validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: stale or consumed no-delta alpha closure passports deny launch before a pod is created.
- `pr_to_rollout_latency`: deployer handoff can cite one compact board ref, one market id, one source revision, one
  Argo revision, and one service-health result instead of recomputing the full Torghut payload by hand.
- `ready_status_truth`: `/ready=ok` remains serving truth; material repair admission requires a current compact
  closure passport plus stage-credit agreement.
- `manual_intervention_count`: the next action is no longer a broad reason-code triage. It is "export and ingest the
  compact alpha closure passport, then honor the no-delta lease."
- `handoff_evidence_quality`: engineer and deployer stages must cite the board id, market id, selected hypothesis,
  no-delta budget state, validation command, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, AgentRuns, or market data.

### Cluster, Rollout, And AgentRuns

- Work branch: `codex/swarm-jangar-control-plane-discover`, based on `main` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- GitHub state: the same head branch has prior merged architecture PRs; the local branch started equal to `origin/main`
  and the remote head ref was absent because prior PRs from that branch were merged and cleaned up.
- Kubernetes identity: `system:serviceaccount:agents:agents-sa`.
- Argo applications `agents`, `jangar`, and `torghut` were `Synced/Healthy/Succeeded` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- Workloads: `agents=1/1`, `agents-controllers=2/2`, `agents-alloy=1/1`, `jangar=1/1`, and `jangar-alloy=1/1`.
- Recent events showed normal rollout and schedule churn: transient readiness probe timeouts on agents controllers,
  Jangar startup readiness while the new pod came up, Torghut Knative startup/readiness probe failures before
  `torghut-00376` and `torghut-sim-00474` became ready, and completed Torghut backfill jobs.
- Retained AgentRuns in `agents`: `791` total, with `644` Succeeded, `121` Failed, `11` Pending, `3` Running, and
  `12` Template.
- Jangar control-plane AgentRuns in the retained set: `322` Succeeded, `53` Failed, and `1` Running.
- Torghut quant AgentRuns in the retained set: `302` Succeeded, `46` Failed, and `2` Running.
- Recent failed runs included Jangar verify `WorkflowStepTimedOut`, Torghut quant verify `WorkflowStepTimedOut`,
  Torghut market-context fundamentals `BackoffLimitExceeded`, and Torghut quant implement `BackoffLimitExceeded`.
- Current pod debt in `agents` included `93` Error pods, `6` OOMKilled pods, and `1` ContainerStatusUnknown pod in the
  retained set. That retained history is not a serving outage, but it is the launch-quality pressure this gate is meant
  to reduce.

### Runtime And Source Truth

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, execution trust healthy, and runtime proof
  cells healthy.
- Jangar control-plane status reported database `healthy`, latency `3 ms`, and migration consistency healthy with
  `29` registered and `29` applied migrations through
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Controllers `agents-controller`, `supporting-controller`, and `orchestration-controller` were enabled, started, CRD
  ready, and had fresh heartbeat authority.
- Rollout health was healthy for `agents` and `agents-controllers`.
- Watch reliability was healthy with one AgentRun stream, `953` events, `0` errors, and `0` restarts in the 15 minute
  window.
- Ready action exchange was `block`: allowed `serve_readonly` and `torghut_observe`; held `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; blocked `live_micro_canary` and `live_scale`.
- Stage credit ledger `stage-credit-ledger:agents:333cd83121fa0e4b` allowed `serve_readonly` but held normal
  discover, plan, implement, verify, deploy, and merge work. The recurring hold reasons were
  `controller_heartbeat_not_current`, `controller_process_heartbeat_authoritative`, `controller_witness_allow_with_split`,
  `route_stability_hold`, `source_rollout_truth_hold`, and `stage_credit_insufficient`.
- The repair stage clearance packet was `repair_only`, not broad dispatch. It carried the Torghut repair reasons
  `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, `expected_shortfall_coverage_low`,
  `market_context_freshness_missing`, `route_warrant_repair_only`, and `ta_signal_lag_exceeded`.
- Source-serving contract verdict was `block`: source SHA `1a37a432e7c2d06e0cfc2d90ffd9a09a6551ffc3`, serving build
  commit `9292518f9a313af097a24f7fd50f912676740a9e`, and reasons `source_ci_retention_receipt_missing`,
  `source_serving_build_mismatch`, and `manifest_image_digest_missing`.
- High-risk Jangar modules remain broad: `supporting-primitives-controller.ts` is `3312` lines,
  `torghut-market-context-agents.ts` is `1980` lines, `control-plane-torghut-consumer-evidence.ts` is `784` lines,
  `control-plane-status.ts` is `757` lines, and `control-plane-stage-credit-ledger.ts` is `594` lines.
- Existing tests cover ready truth, stage credit, material reentry, source-serving contracts, Torghut consumer evidence,
  and status. The missing Jangar test family is compact alpha closure ingestion: current passport, missing passport,
  stale passport, consumed no-delta budget, nonzero notional, and source-serving mismatch.

### Database, Data Quality, And Freshness

- Direct CNPG introspection was not available to this service account. `kubectl cnpg psql -n agents agents-db` could
  not access the cluster; `kubectl cnpg psql -n torghut torghut-db` failed because pod exec is forbidden; listing CNPG
  clusters in both namespaces was forbidden. This is acceptable for this architecture lane because the application
  database witnesses are the intended read-only surface.
- Jangar database status through the control-plane route was healthy with no unapplied or unexpected Kysely
  migrations.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, schema graph lineage
  ready, one branch, and account scope ready.
- Torghut still reports known historical parent forks under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; those are tracked lineage warnings, not current head drift.
- Torghut `/readyz` returned HTTP 503 with `status=degraded`, which is correct for capital safety. The live submission
  gate was closed by `simple_submit_disabled`; promotion eligible total was `0`; the `ta-core` segment was blocked by
  `feature_rows_missing` and `required_feature_set_unavailable`.
- The live business queue stayed `repair_only`; `routeable_candidate_count` was `0`.

### Torghut Closure Evidence

- `/trading/revenue-repair` top queue item was `repair_alpha_readiness`, reason
  `hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`, expected unblock value `4`,
  required output receipt `torghut.executable-alpha-receipts.v1`, max notional `0`, and capital rule
  `zero_notional_repair_only`.
- Torghut emitted `alpha_repair_closure_board.status=selected` with board id
  `alpha-repair-closure-board:ae9a8b5d68641483f4d9b541`.
- The nested settlement market was `alpha-closure-settlement-market:2b8cebb98cc14f7b9a7dd031`, selected hypothesis
  `H-MICRO-01`, repair class `feature_replay_closure`, lot class `feature_lineage`, and required output
  `torghut.alpha-closure-settlement-receipt.v1`.
- The market had `no_delta_budget.state=consumed`, `used_attempts=1`, `remaining_attempts=0`, and release conditions
  `evidence_window_changes`, `blocker_set_changes`, `source_ref_changes`, and `required_receipt_changes`.
- The pending settlement receipt preserved `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, and `closed_session_signal_hold`; routeable candidate count remained `0`.
- Jangar's current Torghut projection did not expose `alpha_repair_closure_board_ref` or `alpha_evidence_foundry_ref`.
  It did expose executable alpha repair receipts, which is now too coarse for admission because it misses the consumed
  no-delta budget.

## Problem

Jangar now has the wrong granularity at the Torghut boundary.

The broad consumer evidence projection says Torghut is current and repair-only. It includes executable alpha repair
receipts. It does not include the compact alpha closure board or no-delta lease that Torghut now emits. That creates
six concrete failure modes.

First, a worker can see `/ready=ok` and current Torghut evidence, but miss that material readiness is still held and
that the alpha closure no-delta budget is already consumed.

Second, stage credit continues to hold repair for broad reasons, while the actionable reason is smaller: the closure
passport is missing from Jangar's projection, and the live Torghut market says no retry until evidence changes.

Third, Jangar may admit or hand off an executable alpha repair receipt that targets `H-CONT-01` while Torghut's
settlement market says the current closure product is `H-MICRO-01`.

Fourth, deployers must fetch `/trading/revenue-repair` separately to prove the closure board exists. The status route
that they use for Jangar rollout truth cannot show it.

Fifth, no-delta debt is visible in Torghut but not in Jangar stage credit. That leaves repeated AgentRuns as the
failure mode instead of an explicit launch denial.

Sixth, source-serving mismatch remains a deploy and merge blocker. The compact closure gate must not hide that; it
must feed only `dispatch_repair` while `deploy_widen` and `merge_ready` remain held until source-serving proof is
settled.

## Alternatives Considered

### Option A: Have Jangar Poll Torghut `/trading/revenue-repair` Directly For Stage Credit

Jangar could make stage credit depend on the full revenue-repair payload and parse the full alpha closure board there.

Advantages:

- Fastest way to see the board.
- Avoids waiting for a consumer-evidence schema addition.
- Keeps all Torghut details available to Jangar reducers.

Disadvantages:

- Couples Jangar admission to a large Torghut payload that includes strategy details and volatile diagnostics.
- Makes status generation more expensive and harder to cache.
- Increases the chance that a payload shape change breaks launch admission.
- Duplicates the consumer-evidence boundary that already exists for this exact purpose.

Decision: reject. Jangar should consume a compact admission passport, not the full business ledger.

### Option B: Continue To Use Only Executable Alpha Repair Receipts

Jangar could keep using `executable_alpha_repair_receipts.selected_receipt` and ignore the closure board until a later
implementation.

Advantages:

- No new Jangar parser work.
- The selected receipt already has validation commands, max notional, and a rollback target.
- Material reentry code already consumes it.

Disadvantages:

- It misses `alpha_closure_settlement_market`.
- It misses consumed no-delta state.
- It can select the wrong hypothesis relative to the Torghut board.
- It does not reduce duplicate failed AgentRuns once a closure has no delta.

Decision: reject. This was sufficient before the closure board existed. It is no longer sufficient.

### Option C: Compact Alpha Closure Passport And Stage-Credit Repair Gate

Torghut exports a compact alpha closure passport on consumer evidence. Jangar ingests it and binds it to
`dispatch_repair` stage credit.

Advantages:

- Preserves the Torghut/Jangar boundary.
- Gives Jangar one stable object for board id, market id, selected hypothesis, required receipt, source revision,
  no-delta budget state, and rollback target.
- Lets Jangar deny a consumed no-delta closure before launching a pod.
- Keeps serving readiness and material readiness separate.
- Keeps deploy and merge held by source-serving proof while allowing future zero-notional repair only under the
  compact passport.

Disadvantages:

- Adds a new compact schema and tests on both sides.
- Requires a shadow period before enforcement.
- Holds repair while the compact export is missing, even though the full Torghut payload has the board.

Decision: select Option C.

## Architecture

Torghut owns alpha closure market construction. Jangar owns launch custody. The boundary is a compact, additive
passport.

```text
torghut.alpha-closure-passport.v1
  passport_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  source_consumer_evidence_ref
  serving_revision
  serving_image_digest
  source_commit
  board_id
  market_id
  market_status
  selected_hypothesis_id
  selected_repair_class
  selected_lot_class
  selected_value_gate = routeable_candidate_count
  required_output_receipt = torghut.alpha-closure-settlement-receipt.v1
  active_dedupe_key
  no_delta_budget_state
  no_delta_remaining_attempts
  release_conditions[]
  max_notional = 0
  capital_rule = zero_notional_repair_only
  validation_commands[]
  rollback_target
```

Jangar projects it as:

```text
jangar.alpha-closure-repair-gate.v1
  gate_id
  generated_at
  fresh_until
  mode = observe | shadow | enforce
  torghut_alpha_closure_passport_ref
  stage_credit_ledger_ref
  ready_action_exchange_ref
  source_serving_contract_verdict_ref
  material_reentry_receipt_ref
  action_class = dispatch_repair
  decision = allow_one | hold | deny
  selected_hypothesis_id
  selected_value_gate
  no_delta_budget_state
  denied_reason_codes[]
  launch_limits
  deployer_evidence
  rollback_target
```

`decision=allow_one` requires all conditions:

1. Passport schema is valid and fresh.
2. Torghut consumer evidence is current.
3. Board status is `selected`.
4. Market selected value gate is `routeable_candidate_count`.
5. Selected market and passport have `max_notional=0`.
6. Capital rule is `zero_notional_repair_only`.
7. No-delta budget is not consumed for the active dedupe key.
8. Source-serving contract verdict is not blocking the repair source ref.
9. Ready action exchange still holds paper and live action classes.
10. Stage credit decision for `dispatch_repair` is `repair_only` or better, never broad normal dispatch.

`decision=hold` is used when the passport is missing, stale, or not yet mirrored, or when source-serving proof is still
missing. `decision=deny` is used for consumed no-delta budget, nonzero notional, live submission enabled, wrong value
gate, schema mismatch, or paper/live action request.

The current live evidence maps to `hold` in observe mode and to `deny` in enforce mode for this exact reason:
Torghut's no-delta budget is consumed and Jangar does not yet receive the compact passport.

## Failure-Mode Reduction

- **Duplicate repair launches:** consumed no-delta budget denies another alpha closure AgentRun until evidence changes.
- **Hypothesis drift:** Jangar admits only the hypothesis selected by the Torghut market, not whichever executable
  receipt appears first.
- **Ready false positives:** `/ready=ok` does not open `dispatch_repair`; the repair gate must also pass.
- **Rollout false positives:** deploy and merge stay held by source-serving proof while the repair gate handles only
  zero-notional repair.
- **Manual evidence collection:** deployers cite the compact passport instead of recomputing the Torghut board from a
  full payload.
- **Capital safety:** paper and live action classes remain held or blocked until independent capital gates pass.

## Implementation Scope

M1: Torghut exports the compact passport.

- Add `alpha_closure_passport` to `/trading/consumer-evidence`.
- Keep the full board on `/trading/revenue-repair`.
- Include board id, market id, selected hypothesis, value gate, required output receipt, no-delta state, source commit,
  serving image digest, max notional, validation commands, and rollback target.
- Do not change `/readyz`, live submit, or notional.

M2: Jangar parses the compact passport.

- Extend `control-plane-torghut-consumer-evidence.ts` with an optional `alpha_closure_passport`.
- Accept missing fields in observe mode.
- Validate freshness, schema, selected value gate, notional, capital rule, no-delta budget, and required receipt.
- Add tests for current, missing, stale, consumed no-delta, nonzero notional, and wrong value gate.

M3: Jangar adds the pure repair gate reducer.

- Inputs: compact passport, stage credit ledger, ready action exchange, source-serving contract verdict, material
  reentry, execution trust, and current time.
- Output: `jangar.alpha-closure-repair-gate.v1`.
- Add tests for allow one, hold missing passport, deny consumed no-delta, deny paper/live action, deny source-serving
  mismatch, and deny nonzero notional.

M4: Surface the gate in control-plane status.

- Include gate id, mode, decision, selected hypothesis, market id, no-delta budget state, and denied reasons.
- Keep `/ready=ok` serving behavior unchanged.

M5: Dispatch enforcement.

- Start observe, then shadow, then enforce.
- Enforce only for `dispatch_repair` and only for the compact alpha closure gate.
- Do not change `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, or `live_scale`
  in the first implementation PR.

## Validation Gates

Architecture PR validation:

- `bunx oxfmt --check docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md docs/torghut/design-system/v6/202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md docs/agents/release-handoffs/jangar-alpha-closure-ingestion-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer validation:

- `bun run --filter jangar test -- src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-material-reentry-clearinghouse.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-stage-credit-ledger.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-status.test.ts -t alpha`
- `cd services/torghut && uv run --frozen pytest tests/test_alpha_repair_closure_board.py tests/test_trading_api.py -k 'alpha_repair_closure or consumer_evidence'`

Deployer validation:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- `kubectl rollout status -n agents deployment/agents` passes.
- `kubectl rollout status -n agents deployment/agents-controllers` passes.
- `GET http://agents.agents.svc.cluster.local/ready` returns `status=ok`.
- Jangar control-plane status includes `alpha_closure_repair_gate` in observe or shadow before enforcement.
- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` includes the full alpha closure board.
- `GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` includes the compact passport.
- Torghut remains `max_notional=0`; `/readyz` may remain HTTP 503 for `simple_submit_disabled` and repair-only proof
  floor.
- If no-delta budget is consumed, no deployer may claim a repair slot is launchable until a release condition changes.

## Rollout

Phase 0 merges this design and the companion Torghut export contract.

Phase 1 adds the Torghut compact passport to consumer evidence while keeping all existing payloads.

Phase 2 adds Jangar parser support and status output in observe mode.

Phase 3 adds the pure repair gate reducer in shadow mode.

Phase 4 turns on dispatch admission for one zero-notional alpha closure only after shadow output proves it matches the
full Torghut board.

Phase 5 enables enforcement for `dispatch_repair`. Enforcement denies consumed no-delta keys until source revision,
evidence window, blocker set, or required receipt set changes.

## Rollback

Rollback is configuration-first:

- stop emitting the compact passport or mark it `observe_only`;
- set Jangar `alpha_closure_repair_gate` mode to `observe`;
- continue using existing ready truth, stage credit, material reentry, repair-bid admission, and executable alpha
  receipt projections;
- keep Torghut full revenue repair board available for manual diagnostics;
- preserve emitted no-delta receipts for audit;
- do not delete AgentRuns, jobs, database rows, receipts, or trading evidence.

## Risks

- The compact passport can drift from the full board. Mitigation: include source refs and require shadow comparison
  before enforcement.
- A no-delta denial can block a legitimate retry. Mitigation: release the denial when source revision, evidence
  window, blocker set, or required receipt set changes.
- Jangar could accidentally treat the repair gate as paper/live authority. Mitigation: gate only `dispatch_repair` and
  explicitly keep paper/live classes held or blocked.
- Source-serving mismatch can be hidden by a repair success. Mitigation: deploy and merge gates continue to depend on
  source-serving contract verdicts.
- Payload growth can make consumer evidence unstable. Mitigation: export a compact passport, not the full closure
  board.

## Handoff

Engineer: implement the compact passport export first, then the Jangar parser and pure repair gate. Do not wire
enforcement until shadow output proves the compact passport matches the full Torghut closure board. The current live
state should hold or deny the repair because the no-delta budget is consumed.

Deployer: prove Argo, workload readiness, `/ready`, Jangar status, Torghut revenue repair, Torghut consumer evidence,
and capital safety after rollout. A green service is not sufficient; the status payload must show whether the alpha
closure repair gate is holding, denying, or allowing one zero-notional slot.

Control-plane metric improved: `failed_agentrun_rate` should fall because repeated alpha closure attempts are denied
before launch. If it does not move, the smallest blocker is missing compact closure passport visibility in Jangar
status or stale no-delta release-condition handling.
