# 207. Torghut Quant Plan Closeout And Alpha Repair Reentry Handoff (2026-05-14)

Status: Accepted for plan-lane closeout and engineer/deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant plan closeout, Jangar control-plane resilience linkage, revenue-repair evidence, database
freshness, alpha-readiness reentry, validation gates, rollout, rollback, and cross-stage handoff.

Current governing contracts:

- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`

Merged PR evidence:

- PR `#5854`: `docs(torghut): define capital evidence return lane`, merged as
  `b05380736319cd68b17549615d9602adbc1abc46`.
- PR `#6418`: `docs(torghut): add quant plan closeout handoff`, merged on 2026-05-13.
- PR `#6592`: `docs(torghut): define alpha readiness settlement conveyor`, merged on 2026-05-14.
- PR `#6618`: `docs(jangar): define verify trust foreclosure`, merged as
  `4190b42ea61504130458da8fc49f3dfa1820ff76`.

## Decision

I am closing this plan-lane pass on the **no-delta alpha repair reentry direction**, and I am handing the next bounded
milestone to engineer and deployer stages as an alpha-readiness reentry auction under zero notional.

The May 7 architecture goal was to move Jangar from generic serving health toward explicit capital evidence returns,
and to move Torghut from static proof blockers toward scheduled, measurable profit repair. That direction is now
implemented as design truth. Jangar has accepted contracts for verify-trust foreclosure, revenue-repair settlement
custody, material action verdicts, and Torghut evidence admission. Torghut has accepted contracts for no-delta repair
reentry, alpha-readiness settlement, alpha repair dividend custody, executable alpha receipts, repair-bid settlement,
route evidence clearinghouse, and consumer evidence.

The current live evidence does not justify a new architecture fork. It does justify a stricter handoff. At
2026-05-14T12:28Z, `/trading/revenue-repair` was still `business_state=repair_only`, `revenue_ready=false`, and
`accepted_routeable_candidate_count=0`. The top queue item was still `repair_alpha_readiness`, mapped to
`routeable_candidate_count`, with required output `torghut.executable-alpha-receipts.v1`, `max_notional=0`, and
capital rule `zero_notional_repair_only`. Torghut `/readyz` returned HTTP 503 for the right reasons:
`simple_submit_disabled` and `profitability_proof_floor=repair_only`. `/db-check` returned HTTP 200 with
`schema_current=true`, current and expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, no
missing heads, no unexpected heads, and lineage ready.

The selected next milestone is therefore not "make Torghut trade." It is: build and deploy the no-delta reentry
auction so one zero-notional repair ticket can only launch when the alpha-readiness release condition has changed, and
so every repeated no-delta result is captured as debt instead of silently consuming more runner capacity.

The tradeoff is deliberate. This keeps paper and live blocked while the system has zero routeable candidates and stale
or incomplete empirical evidence. I accept that because the business metric is routeable post-cost profit evidence
without weakening capital safety, not raw repair activity.

## Governing Inputs

Business metric:

- Increase routeable post-cost profit evidence and live trading readiness without weakening capital safety.

Validation contract:

- Every run must cite the governing Torghut design or runtime requirement before changing code.
- Implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety.
- Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout.
- Final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: primary gate. The next implementation must increase accepted routeable candidates or
  record a new no-delta debt under a changed release condition.
- `zero_notional_or_stale_evidence_rate`: unchanged no-delta evidence remains a denial signal.
- `fill_tca_or_slippage_quality`: TCA work is admitted only as a named prerequisite to alpha-readiness reentry.
- `post_cost_daily_net_pnl`: no capital promotion can happen until post-cost evidence is positive and current.
- `capital_gate_safety`: live submission stays disabled, paper/live classes stay held or blocked, and every repair
  ticket carries `max_notional=0`.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
broker state, market data, trading flags, AgentRuns, GitOps resources, or empirical artifacts.

### Cluster And Rollout

- Identity was `system:serviceaccount:agents:agents-sa`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Torghut live and sim serving revisions were available: `torghut-00389-deployment=1/1` and
  `torghut-sim-00487-deployment=1/1`.
- Torghut active image digest was `sha256:f451b35a66392e9d769ebab8b6c7708f617b5449d6473aed8b349ea34f60187b`.
- Torghut DB, ClickHouse shards, Keeper, options catalog, options enricher, TA, TA sim, options TA, websocket lanes,
  guardrail exporters, Alloy, and Symphony pods were running.
- Recent Torghut events showed normal revision replacement, successful migration/bootstrap jobs, a ClickHouse liveness
  timeout, Flink status conflict warnings, duplicate ClickHouse PodDisruptionBudget matches, and a Keeper PDB `NoPods`
  warning.
- Recent Agents events showed current scheduled plan/verify jobs completing and transient readiness probe timeouts on
  controller pods during rollout turnover.

### Jangar Control Plane

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, `business_state=repair_only`, and
  `revenue_ready=false`.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-14T12:29:32.582Z`.
- Controllers were healthy with heartbeat authority for agents, supporting, and orchestration controllers.
- Watch reliability was healthy over a 15 minute window with `199` events, `0` errors, and `0` restarts.
- Jangar database was healthy with `latency_ms=12`; Kysely migrations were consistent at `29` registered and `29`
  applied, latest migration `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Execution trust was healthy on this read.
- Material action verdicts allowed `serve_readonly` and `torghut_observe` with `max_notional=0`. `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` were held. `live_micro_canary` and
  `live_scale` were blocked.
- Jangar still reported Torghut forecast `registry_empty` and empirical jobs degraded because the current empirical
  receipts were stale.

### Torghut Business Evidence

- `/readyz` returned HTTP 503 with dependency failures `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`.
- `/readyz` also reported Postgres, ClickHouse, Alpaca, database schema, static universe, DSPy runtime, and optional
  quant evidence as acceptable for observation.
- `/db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, no duplicate revisions,
  no orphan parents, and `schema_graph_lineage_ready=true`.
- `/trading/revenue-repair` generated at `2026-05-14T12:28:56.470315+00:00`.
- Revenue state was `repair_only`, `revenue_ready=false`, `capital_stage=shadow`, `capital_state=zero_notional`,
  `live_submission_allowed=false`, and `max_notional=0`.
- Top queue item was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, priority `70`, action
  `clear_hypothesis_blockers_before_capital`, value gate `routeable_candidate_count`, and required output
  `torghut.executable-alpha-receipts.v1`.
- Routeability acceptance was blocked with `accepted_routeable_candidate_count=0` and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Route evidence clearinghouse had `3` route claims, `0` accepted routeable candidates, `3` held route claims, and
  `41` repair bids across all required value gates.
- Repair-bid settlement had `41` raw bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots, and
  `routeable_candidate_count=0`.
- Alpha readiness had `3` shadow hypotheses, `0` promotion eligible, `3` rollback required, and blocked hypotheses
  `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`.
- `/trading/consumer-evidence` reported alpha-readiness settlement `status=no_delta`, selected `H-MICRO-01`,
  `routeable_candidate_count` `0 -> 0`, active no-delta lease, `repeat_launch_decision=deny`, and `max_notional=0`.
- The same consumer evidence reported alpha repair dividend `status=no_delta`, active no-delta release key,
  `launch_decision=deny`, enforcement mode `observe`, and `max_notional=0`.
- Empirical jobs were truthful but stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` on dataset snapshot `torghut-chip-full-day-20260505-4c330ce9-r1`.

### Database And Data

- Direct CNPG inspection was blocked by RBAC: `system:serviceaccount:agents:agents-sa` cannot create `pods/exec` in
  namespace `torghut`.
- Direct ClickHouse HTTP inspection without credentials returned `REQUIRED_PASSWORD`.
- The portable data-quality authority is therefore the application-owned DB and evidence routes, not privileged SQL.
- The important data-quality finding is consistent across routes: schema is current, but revenue evidence is not
  capital-grade because accepted routeable candidates are zero, empirical jobs are stale, and alpha readiness is
  no-delta.

### Source And Test Surface

- `services/torghut/app/main.py` is `6990` lines and assembles readiness, database checks, revenue repair, and
  consumer evidence.
- `services/torghut/app/trading/revenue_repair.py` is `1161` lines and owns the revenue-repair digest.
- `services/torghut/app/trading/alpha_readiness_settlement_conveyor.py` is `848` lines and owns no-delta lease logic.
- `services/torghut/app/trading/alpha_repair_dividend_ledger.py` is `637` lines and owns Jangar-facing no-delta
  custody.
- `services/jangar/src/server/control-plane-status-types.ts` is `2974` lines and remains the high-risk control-plane
  integration boundary.
- `services/jangar/src/server/control-plane-status.ts` and
  `services/jangar/src/server/control-plane-material-action-verdict.ts` own the Jangar status and material-action
  verdict surfaces.
- Focused regression suites already exist for revenue repair, alpha readiness settlement, alpha repair dividend,
  executable alpha receipts, consumer evidence, routeability repair acceptance, route evidence clearinghouse, Jangar
  Torghut consumer evidence, material action verdicts, material reentry, ready truth, and control-plane status.
- The next missing implementation test family is the no-delta repair reentry auction itself: unchanged release key
  deny, changed evidence-window allow, changed blocker-set allow, changed receipt-set allow, zero-notional
  enforcement, and consumer-evidence export.

## Problem

The system has enough architecture and enough runtime evidence to name the next work precisely. It does not yet have
the auction that decides when another alpha-readiness repair is worth launching after a no-delta result.

The current failure modes are:

1. `routeable_candidate_count` remains `0` even after alpha-readiness settlement.
2. The active no-delta release key correctly denies duplicate reentry, but there is not yet a compact auction result
   that names the release condition or prerequisite ticket.
3. Empirical jobs are truthful but stale, so paper promotion would convert stale proof into execution noise.
4. Jangar can observe Torghut, but material action remains held because controller and evidence witnesses are not
   settled enough for broader dispatch.
5. Database schema currentness can be confused with capital readiness unless the handoff keeps data freshness and
   routeability as separate gates.
6. Direct database shells are unavailable to the worker identity, so verification must rely on typed witnesses and
   route payloads.

## Options Considered

### Option A: Continue Planning More Architecture

Advantages:

- Low production risk.
- More vocabulary for future repair lanes.
- Easy to review as documentation.

Disadvantages:

- The current governing contracts are already long-form, merged, and indexed.
- More design language does not change `routeable_candidate_count`.
- It delays the first implementation that can retire the top revenue-repair queue item.

Decision: reject as the primary next step.

### Option B: Rerun Alpha Repair After Cooldown

Advantages:

- Uses the current top queue item directly.
- Requires little new code.
- Might catch a transient stale-evidence issue.

Disadvantages:

- It repeats a known `0 -> 0` result unless a release condition changed.
- It spends runner capacity without producing new economic evidence.
- It can increase failed AgentRun pressure while leaving routeability unchanged.

Decision: reject.

### Option C: Implement No-Delta Repair Reentry Auction

Advantages:

- Targets `repair_alpha_readiness`, the live top queue item.
- Converts duplicate no-delta repairs into explicit denied reentry.
- Allows prerequisite work only when it names the alpha-readiness blocker it can release.
- Preserves `max_notional=0` and live submit disabled.
- Gives Jangar and deployer stages one compact receipt to validate.

Disadvantages:

- Adds one more Torghut scheduling/custody surface.
- Can hold useful empirical or TCA work until it is tied to the alpha-readiness blocker.
- Requires careful fixture coverage to avoid turning a timer into implicit reentry permission.

Decision: select Option C.

## Implementation Scope

Engineer stage should implement the auction in Torghut, not in Jangar. Jangar should consume the result once Torghut
emits it.

Required Torghut behavior:

1. Add `no_delta_repair_reentry_auction` keyed by account, window, trading mode, source revenue-repair ref, active
   no-delta release key, and top queue item.
2. Deny reentry when source ref, evidence window, blocker set, required receipt set, and Jangar verify-carry inputs are
   unchanged.
3. Allow one zero-notional ticket when a release condition changed and the ticket targets `repair_alpha_readiness` or a
   named prerequisite to it.
4. Export compact auction refs on `/trading/revenue-repair` and `/trading/consumer-evidence`.
5. Keep paper, live micro, and live scale denied until routeable candidates and post-cost proof are current.

Required Jangar behavior after Torghut ships the route:

1. Read the auction ref from consumer evidence.
2. Keep `torghut_observe` allowed when the auction is current and capital is zero.
3. Keep `dispatch_repair`, `paper_canary`, `live_micro_canary`, and `live_scale` held or blocked unless the auction
   carries an allowed zero-notional repair ticket and the normal material-action witnesses are current.
4. Include auction id, release key, selected ticket, validation command, and rollback target in material-action custody.

## Validation Gates

Local engineer checks:

- `uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py`
- `uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime/deployer checks after rollout:

- `kubectl get deploy -n torghut` shows current live and sim deployments available.
- Argo reports Torghut synced and healthy.
- `/db-check` returns HTTP 200 and `schema_current=true`.
- `/readyz` may remain HTTP 503, but only for capital-safety holds.
- `/trading/revenue-repair` includes `no_delta_repair_reentry_auction`, top queue `repair_alpha_readiness`,
  `accepted_routeable_candidate_count`, selected ticket or deny reason, and `max_notional=0`.
- `/trading/consumer-evidence` includes the compact auction ref and the alpha-readiness settlement ref.
- Jangar control-plane status keeps `serve_readonly` and `torghut_observe` allowed while paper/live remain held or
  blocked until routeable candidates are nonzero and capital proof is current.

## Rollout

Phase 1 emits the auction in observe mode only. No scheduler decisions change and `max_notional=0` remains enforced.

Phase 2 feeds the auction result into revenue-repair queue ordering while preserving the current proof floor and live
submission gate.

Phase 3 lets Jangar material-action custody cite the auction ref for zero-notional repair admission.

Phase 4 lets deployer verification treat either a positive `routeable_candidate_count` delta or a new no-delta debt
under a changed release condition as the accepted revenue-repair result.

## Rollback

Rollback is straightforward:

- Stop emitting `no_delta_repair_reentry_auction`.
- Keep `/trading/revenue-repair`, `/trading/consumer-evidence`, alpha-readiness settlement, and alpha repair dividend
  ledgers intact.
- Keep `simple_submit_disabled=true`, `capital_state=zero_notional`, and `max_notional=0`.
- Jangar falls back to existing material-action verdicts and keeps paper/live held or blocked.

## Risks

- Auction mispricing can deny useful prerequisite work. Mitigation: require explicit reason-code and receipt-set
  evidence for every denial.
- Auction over-admission can relaunch unchanged no-delta repairs. Mitigation: fixture coverage for unchanged release
  keys and repeated evidence windows.
- Runtime payloads can grow. Mitigation: export compact refs on hot routes and put detail behind existing evidence
  surfaces.
- Deployer evidence can confuse `readyz` 503 with outage. Mitigation: require the readyz dependency names and capital
  state in rollout notes.

## Handoff

Engineer next action: implement `no_delta_repair_reentry_auction` in Torghut with tests, export compact refs on
`/trading/revenue-repair` and `/trading/consumer-evidence`, and keep all auction tickets zero-notional.

Deployer next action: after rollout, prove the image digest changed, Argo is synced, live and sim deployments are
available, `/db-check` is current, `/readyz` is only capital-safety degraded, and `/trading/revenue-repair` reports the
auction decision.

Smallest blocker preventing revenue impact: `repair_alpha_readiness` still owns the top revenue-repair queue,
`routeable_candidate_count` is still `0`, and the current no-delta release key denies duplicate launch. Revenue impact
starts when a changed release condition either creates at least one accepted routeable candidate or records a new
no-delta debt that moves the next repair ticket.
