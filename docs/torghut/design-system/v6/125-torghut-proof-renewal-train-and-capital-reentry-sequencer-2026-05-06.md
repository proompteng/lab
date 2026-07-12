# 125. Torghut Proof Renewal Train And Capital Reentry Sequencer (2026-05-06)

Status: Accepted for engineer and deployer handoff

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


## Decision

Torghut will move from independent proof repairs to a **proof renewal train** with a **capital reentry sequencer**.

The first gate in that train is not a trading metric. It is Jangar controller-witness closure. At
`2026-05-06T15:12Z`, the controller deployment and watch stream were current, but Jangar still returned
`controller_witness_split` because the controller process did not publish a current AgentRun-ingestion self-report.
That kept normal dispatch at `repair_only`. Torghut should not try to spend repair capacity or reenter paper capital
as if this is merely a stale empirical-job problem.

After Jangar emits a fresh controller closure receipt, Torghut renews proof in a fixed order: empirical jobs, typed
quant latest metrics, market context, paper settlement, and only then live micro-canary. Each step records the
hypotheses, account, window, candidate, dataset, and capital action class it affects. The sequencer may record shadow
capital upside for blocked hypotheses, but it keeps submitted notional at `0` until Jangar's material action receipt
allows the same action class.

The current data supports that sequence. Torghut live is alive but not capital-ready: `/healthz` returned HTTP `200`,
while live `/readyz` returned HTTP `503` because live submission is blocked by `simple_submit_disabled` in
`capital_stage=shadow`. `/trading/status` reported `3` hypotheses, `0` promotion eligible, and `3` rollback required.
The stale empirical jobs are all March 21 artifacts for `intraday_tsmom_v1@prod`. Jangar typed quant health for
`paper/1d` has an empty latest store. `NVDA` market context has fresh technical/regime data but stale fundamentals and
news, and the aggregate health bundle is degraded.

The tradeoff is slower paper reentry. I accept that. The profitable system is the one that knows which proof is missing
and renews it in the order that can actually unlock capital, not the one that launches the most repairs while the
control plane is still in repair-only mode.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker state, Argo CD,
or GitHub records.

### Runtime And Rollout Evidence

- Torghut live revision `torghut-00238` was `2/2 Running` on image digest
  `af92e76b6844ec5614a0d00b3651713d8102f2ff25eaa6ceadf0be63c089483e`.
- Torghut sim revision `torghut-sim-00331` was `2/2 Running` on the same digest.
- Live TA, sim TA, options TA, options catalog, options enricher, websockets, ClickHouse, Keeper, Postgres, Alloy, and
  Symphony were running.
- Argo CD reported `torghut` as `OutOfSync` and `Healthy`; `torghut-options` and `symphony-torghut` were `Synced` and
  `Healthy`.
- Recent Torghut events showed the previous sim TA image/platform failure had recovered, but also showed rollout churn,
  one sim scheduling failure before assignment, duplicate ClickHouse PodDisruptionBudget warnings, and a Flink
  status-modified warning for `torghut-options-ta`.
- Jangar material action receipts allowed `torghut_observe`, held `paper_canary`, blocked `live_micro_canary`, and
  blocked `live_scale`.
- Direct CNPG `psql` was blocked by service-account RBAC in both `jangar` and `torghut`, so runtime-owned HTTP
  projections remain the authoritative read-only evidence for this lane.

### Schema And Data Evidence

- Live `/healthz` returned HTTP `200`.
- Live `/readyz` returned HTTP `503` with scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe
  healthy; live submission was blocked by `simple_submit_disabled` in `capital_stage=shadow`.
- The Torghut schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096` with lineage ready and the
  known historical parent-fork warnings.
- `/trading/status` reported `enabled=true`, `running=true`, `mode=live`, `pipeline_mode=simple`,
  `kill_switch_enabled=false`, `orders_submitted_total=0`, and current revision `torghut-00238`.
- Hypothesis summary reported `hypotheses_total=3`, `state_totals={"blocked":1,"shadow":2}`,
  `capital_stage_totals={"shadow":3}`, `promotion_eligible_total=0`, and `rollback_required_total=3`.
- `H-CONT-01` and `H-REV-01` were in shadow; `H-MICRO-01` was blocked. All three had `capital_multiplier=0` and
  `rollback_required=true`.
- `H-CONT-01` was blocked by Jangar dependency state and signal lag. `H-MICRO-01` was blocked by missing drift checks,
  missing feature rows, missing feature set availability, Jangar dependency state, and signal lag. `H-REV-01` was
  blocked by Jangar dependency state, market-context staleness, and signal lag.
- Torghut empirical jobs were truthful but stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward`, all tied to candidate `intraday_tsmom_v1@prod`, dataset
  `torghut-full-day-20260318-884bec35`, and March 21 artifact refs.
- Jangar typed quant health for `account=paper&window=1d` was degraded with `latestMetricsUpdatedAt=null`,
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no stages.
- Sim `/trading/health` returned HTTP `200`, but its quant evidence was degraded for `TORGHUT_SIM/15m` with an empty
  latest store.
- `NVDA` market context returned fresh technicals and regime at `2026-05-06T15:12:49Z`, but fundamentals were stale
  from `2026-03-12T13:43:18Z` and news was stale from `2026-05-06T13:43:23Z`.
- The aggregate market-context health bundle was degraded before the symbol-specific refresh, with bundle freshness
  `154408s`, quality score `0.4575`, and stale technicals, fundamentals, news, and regime domains.
- Latest `NVDA` TA bars/signals were current at `2026-05-06T15:12:49Z`, proving the problem is not a total market data
  outage; it is proof freshness and capital authority.

### Source Evidence

- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and already tracks truthful empirical artifacts,
  persisted authority, staleness, candidate ids, dataset refs, and promotion eligibility.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already composes live submission gates from
  Jangar dependency state, empirical readiness, typed quant health, critical toggles, and capital stage.
- `services/torghut/app/trading/hypotheses.py` is `732` lines and already represents hypothesis state, blocker
  reasons, capital stage, promotion eligibility, rollback requirement, required feature sets, and dependency
  capabilities.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns signal continuity, market-context
  observations, rejection accounting, decision context, and order preparation.
- Existing tests cover empirical jobs, hypotheses, submission council, trading API/health, quant readiness,
  market-context behavior, simulation parity, and promotion truthfulness. The missing regression is the full renewal
  train: repairs must run in controller, empirical, quant, context, and paper-settlement order before capital action
  can graduate.

## Problem

Torghut has enough local evidence to know it should not trade, but not enough structure to decide the next profitable
repair without Jangar closure.

The current blocked hypotheses are not equally repairable:

- `H-CONT-01` has a positive old post-cost expectancy proxy but is blocked by Jangar dependency state and signal lag.
- `H-MICRO-01` needs feature coverage and drift governance before it deserves paper measurement.
- `H-REV-01` needs market-context freshness before event-driven reversion claims can be evaluated.

Running all repairs in parallel wastes scarce controller capacity and can produce proof that cannot clear the next
gate. Fresh market context does not unlock capital if empirical proof is still March 21. Fresh empirical jobs do not
unlock paper if Jangar normal dispatch is still repair-only from controller witness split. Fresh quant metrics do not
unlock live scale without paper settlement.

The architecture needs a sequencer that ties each repair to the predecessor proof it requires and the capital gate it
could unlock.

## Alternatives Considered

### Option A: Prioritize The Highest Expected Profit Hypothesis First

Use the current shadow ledger to choose the hypothesis with the best expected post-cost value, then repair its missing
inputs before other lanes.

Pros:

- Directly optimizes for profitability.
- Keeps repair work close to hypothesis economics.
- Likely favors `H-CONT-01`, which has the least structural debt.

Cons:

- Ignores Jangar controller closure and material action authority.
- Can refresh one hypothesis while shared empirical or quant proof remains stale.
- Does not create deployer-safe evidence for paper or live gates.

Decision: reject as the first ordering principle. Use expected value inside each sequenced repair stage, not ahead of
control-plane closure.

### Option B: Refresh Every Stale Data Surface In Parallel

Launch empirical job refresh, quant latest-store repair, market-context provider refresh, and hypothesis-specific
feature repair at the same time.

Pros:

- Fast when capacity is abundant.
- Reduces wall-clock time if all repairs succeed.
- Simple to explain as "make everything fresh."

Cons:

- Burns capacity while `dispatch_normal` is still repair-only.
- Produces closure receipts out of order and forces humans to decide which ones matter.
- Can hide failure attribution when several repairs race.
- Does not protect capital gates from partial freshness.

Decision: reject for the default lane. Allow parallelism only when the train proves two repairs have independent
predecessor receipts.

### Option C: Proof Renewal Train And Capital Reentry Sequencer

Run repairs in dependency order: Jangar controller closure, empirical jobs, typed quant latest metrics, market context,
paper settlement, then live micro-canary. Each stage emits a closure receipt tied to hypotheses and capital action
classes.

Pros:

- Aligns Torghut profitability work with Jangar material action authority.
- Gives deployers one ordered set of receipts instead of a pile of stale/fresh booleans.
- Keeps capital at zero until proof freshness and paper settlement are current.
- Lets expected value rank work inside the empirical/context stages without bypassing predecessor gates.
- Turns the current stalled state into an implementation sequence engineers can test.

Cons:

- Slower than opportunistic parallel refresh.
- Requires one more local projection and API surface.
- Needs careful expiry semantics so old closure receipts cannot keep capital eligible.

Decision: select Option C.

## Architecture

Torghut adds a local `proof_renewal_train_state` projection. Jangar owns the controller closure receipt and material
action receipt; Torghut owns hypothesis economics and local proof closure.

```text
proof_renewal_train_state
  train_id
  generated_at
  expires_at
  jangar_controller_closure_ref
  jangar_material_action_receipt_ref
  train_phase                # controller, empirical, quant, context, paper, live_micro
  hypothesis_scope
  account
  window
  candidate_id
  dataset_snapshot_ref
  required_repairs
  blocked_reasons
  shadow_capital_delta
  final_capital_decision     # observe, shadow_only, paper_allowed, live_allowed, blocked
```

Each stage emits a closure receipt:

```text
proof_renewal_stage_receipt
  receipt_id
  train_id
  stage
  generated_at
  expires_at
  predecessor_receipt_refs
  evidence_refs
  hypothesis_ids
  account
  window
  decision                  # allow_next, repair_only, hold, block
  reason_codes
  rollback_target
```

Default stage order:

1. `controller`: require Jangar `controller_witness_closure_receipt=allow`.
2. `empirical`: refresh stale jobs for `intraday_tsmom_v1@prod` and current dataset lineage.
3. `quant`: refill typed latest metrics for `paper/1d` and `TORGHUT_SIM/15m`.
4. `context`: refresh stale fundamentals/news and aggregate context health for the traded symbol set.
5. `paper`: admit one paper settlement for the highest expected value hypothesis that has all predecessor receipts.
6. `live_micro`: require paper settlement, no live submission blockers, and Jangar `live_micro_canary=allow`.

Expected value ranks work inside stages, not across predecessor gates. That means `H-CONT-01` can be first in the
paper candidate order after shared proof is fresh, while `H-MICRO-01` remains blocked until feature and drift receipts
exist.

## Implementation Scope

Engineer stage:

- Add the train-state reducer near the submission council rather than inside request-time route glue.
- Consume Jangar controller closure and material action receipts from the control-plane status payload.
- Emit stage receipts for controller, empirical, quant, context, paper, and live micro phases.
- Attach train refs to empirical job refresh requests and market-context refresh requests.
- Keep live submission blocked unless the train phase and Jangar receipt both allow the matching action class.
- Add tests for stage ordering, stale receipt expiry, hypothesis ranking inside a stage, and capital fail-closed
  behavior.

Deployer stage:

- Verify Torghut status shows `controller` phase until Jangar controller closure is current.
- Verify empirical jobs refresh before paper canary changes from hold.
- Verify typed quant latest stores are non-empty for the configured account/window before paper settlement.
- Verify stale fundamentals/news do not block zero-notional observation but do block event-reversion paper settlement.
- Verify disabling Jangar closure or expiring a predecessor receipt returns the train to a safe earlier phase.

## Validation Gates

- Unit: train reducer rejects missing or expired Jangar controller closure.
- Unit: empirical stage cannot emit `allow_next` while any required job is stale.
- Unit: quant stage cannot emit `allow_next` when latest metrics are empty.
- Unit: context stage distinguishes fresh technical/regime data from stale fundamentals/news.
- Unit: paper stage ranks hypotheses by expected value only after predecessor receipts are current.
- Unit: live stage requires paper settlement and Jangar `live_micro_canary=allow`.
- Integration: `/trading/status` exposes train phase, receipt refs, and capital decision without enabling orders.
- Rollout: live `/readyz` can remain `503` for `simple_submit_disabled` while train proof refresh proceeds.
- Rollback: stale or missing train receipts keep submitted notional at `0`.

## Rollout Plan

1. Add the train projection in shadow mode and expose it in `/trading/status`.
2. Consume Jangar controller closure in observe mode and compare against current dependency-quorum blockers.
3. Attach train ids to empirical refresh jobs without changing capital decisions.
4. Attach train ids to quant and context refreshes.
5. Enable paper-stage settlement only after closure receipts are current and Jangar paper canary is at least `allow`.
6. Keep live micro-canary blocked until paper settlement exists and Jangar live material action allows.

## Rollback

- Disable train enforcement and keep current shadow-only capital behavior.
- Preserve emitted train receipts for audit but stop using them in submission council decisions.
- Keep live submission blocked by `simple_submit_disabled` and critical toggles.
- Do not delete empirical artifacts or market-context snapshots; mark them ignored if they were produced after a
  rolled-back train phase.

## Risks

- Over-serialization can delay useful context refreshes. Mitigation: allow independent read-only context refreshes, but
  do not let their receipts advance paper ahead of empirical and quant stages.
- Jangar receipt schema may evolve while Torghut consumes it. Mitigation: version the receipt contract and fail closed
  on unknown required fields.
- Stale but positive old TCA/profit proxies may bias paper ranking. Mitigation: require fresh empirical and quant
  receipts before expected value can rank paper candidates.
- Market context can be symbol-fresh while aggregate health is stale. Mitigation: record both symbol-specific and
  aggregate refs and require the stricter one for event-reversion paper admission.

## Handoff Contract

Engineer acceptance:

- Torghut exposes `proof_renewal_train_state` and stage receipts in status.
- Submission council consumes Jangar closure/material action receipts and fails closed on stale or missing refs.
- Empirical, quant, context, paper, and live stages are ordered and tested.
- Hypothesis ranking happens inside the paper stage only after predecessor receipts are current.

Deployer acceptance:

- Read-only status shows the train blocked at controller phase until Jangar closure exists.
- After controller closure, empirical repair is the next admitted stage while paper and live remain held/blocked.
- Paper reentry requires fresh empirical, quant, context, and Jangar paper action receipts.
- Live micro-canary requires paper settlement plus Jangar live action allow.
- Any expired predecessor receipt returns capital decision to `shadow_only` or `blocked` with submitted notional `0`.
