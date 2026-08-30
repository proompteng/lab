# 166. Torghut Executable Profit Receipts And Repair Convoy Settlement (2026-05-07)

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

I am selecting **executable profit receipts and repair convoy settlement** as Torghut's next profitability architecture
step.

The system is safe. It is not yet profit-seeking in a measurable way. The latest Torghut live and simulation revisions
are running on image
`registry.ide-newton.ts.net/lab/torghut@sha256:0927f669a37ccc4130ab7693a5ea91b446f4bc0cfb7709613fa49e00b8b95a4b`,
Postgres and ClickHouse checks pass, the schema is current at `0029_whitepaper_embedding_dimension_4096`, and the
control plane can observe the trading stack. Capital remains correctly closed: live proof floor is `repair_only`, live
capital state is `zero_notional`, live submit is disabled, live routeability is zero of eight symbols, market context is
stale, empirical jobs are degraded, alpha readiness has zero promotion-eligible hypotheses, and the dependency quorum
is blocked by `empirical_jobs_degraded`.

Simulation is useful but not promotable. It reports operational `status=ok`, but its proof floor is still
`repair_only`. It has one `NVDA` probing route with acceptable slippage, seven missing symbols, stale TCA, one
unsettled execution, empty quant latest metrics for `TORGHUT_SIM/15m`, and no quant stages. That is a repair seed, not
paper authority.

Torghut should now turn proof and repair work into **ExecutableProfitReceipts**. A receipt says what profit hypothesis
was tested or repaired, which account/window it applies to, which route and quant proof it consumed, what before state
it invalidated, what after state it produced, and which capital surface remains forbidden. Repairs should settle as
**RepairConvoys**, not isolated jobs: a convoy groups one bounded zero-notional repair objective with before refs,
required after refs, route budgets, falsification checks, and a Jangar admission receipt.

The tradeoff is that this design may slow paper rehearsal. I accept that. The current blocker is not a lack of ideas;
it is a lack of executable receipts that connect repair work to after-cost profit evidence without granting notional.

## Runtime Objective And Success Metrics

Success means:

- `/trading/status`, `/trading/health`, and `/trading/autonomy` expose `executable_profit_receipts` and
  `repair_convoy_settlement` in shadow/status-only mode.
- Every receipt carries `receipt_id`, `account_label`, `window`, `torghut_revision`, `profit_hypothesis_id`,
  `capital_surface`, `max_notional`, `before_refs`, `after_refs`, `profit_measure`, `risk_measure`,
  `falsification_result`, and `jangar_capital_receipt_epoch_id`.
- Every repair convoy has one target receipt gap, finite runtime, finite parallelism, finite route budget, max notional
  zero, and a required after receipt.
- Live paper rehearsal remains blocked until live routeability is at least two symbols, live quant ingestion and
  materialization are fresh, empirical jobs are current, market context is fresh, alpha readiness has at least one
  promotion-eligible hypothesis, and Jangar capital receipt epoch allows paper rehearsal.
- Simulation paper rehearsal remains blocked until sim quant latest metrics are nonempty, sim quant stages are present,
  TCA is within freshness budget, unsettled executions are zero, market context is fresh, and alpha readiness clears.
- Live micro remains blocked until live submit is enabled, routeability is nonzero, paper rehearsal receipts close, and
  Jangar live action receipts are fresh.
- Deployer can explain the next allowed action using one receipt id and one convoy id.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 around 20:08Z-20:12Z. I did not mutate Kubernetes resources, database
records, ClickHouse tables, broker state, GitOps resources, AgentRun objects, or trading flags.

### Cluster And Runtime Evidence

- Branch: `codex/swarm-torghut-quant-discover`; base was `origin/main` at
  `5549fe9bb4f34cac56f5db3619b0cb53405b7783`.
- `kubectl auth whoami` succeeded as `system:serviceaccount:agents:agents-sa`.
- Namespaces `agents`, `jangar`, and `torghut` were active.
- Argo CD reported `jangar`, `torghut`, and `torghut-options` as `Synced/Healthy` at revision
  `5549fe9bb4f34cac56f5db3619b0cb53405b7783`.
- Torghut live `torghut-00280-deployment`, sim `torghut-sim-00380-deployment`, options catalog, options enricher, TA
  jobmanagers, TA taskmanagers, ClickHouse, Keeper, WebSocket, and guardrail exporter pods were running.
- Recent events showed a successful DB migration and completed Torghut empirical-jobs backfill, whitepaper semantic
  backfill, and whitepaper bootstrap jobs on the latest image.
- Recent events also showed startup/readiness probe failures during revision handoff, options readiness failures during
  rollout, and a retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod in `Error`.
- CNPG direct `psql` was blocked by RBAC because the worker cannot create `pods/exec` in `torghut`. The database
  witness for this pass is `/db-check` plus typed service routes.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, one current head, one expected head, no missing or unexpected heads,
  lineage-ready graph, one branch, and documented parent-fork warnings.
- Account-scope checks were ready, with a warning that checks are bypassed while multi-account trading is disabled.
- `/trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and four stale completed
  jobs created at `2026-05-06T16:27:32.941330+00:00`.
- Jangar unscoped quant health had 4284 latest metrics and no missing update alarm, but no stage receipts.
- Jangar live account/window quant health for `PA3SX7FYNUTF/15m` had 144 latest metrics, compute OK, ingestion not OK
  with `538528` seconds of lag, and materialization not OK.
- Jangar sim quant health for `TORGHUT_SIM/15m` had zero latest metrics, empty latest store alarm, and no stages.
- Options catalog `/readyz` returned `ready=true`, but `last_success_ts=null`.

### Live Trading Evidence

- Live `/healthz` returned `status=ok`.
- Live `/trading/health` returned `status=degraded`.
- Live dependencies were healthy enough for observation: Postgres OK, ClickHouse OK, Alpaca live account active,
  Jangar universe fresh with eight symbols, readiness cache fresh, and quant evidence informational.
- Live submission gate was closed by `simple_submit_disabled`; capital stage was `shadow`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live alpha readiness had three shadow hypotheses, zero promotion eligible, and three rollback required.
- Live routeability had zero routeable symbols, five blocked symbols, and three missing symbols.
- Blocked live symbols were `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`. Missing live symbols were `AMZN`, `GOOGL`, and
  `ORCL`.
- Live average absolute slippage was `13.8203637593029676` bps against an 8 bps guardrail. Symbol-level examples:
  `AAPL=9.2512`, `NVDA=13.4759`, `AMD=14.9333`, `INTC=20.5711`, and `AVGO=21.8583` bps.
- Live TCA had 7334 orders and 7245 filled executions, with latest execution created at
  `2026-04-02T19:00:29.586040Z`.
- `/trading/profitability/runtime` reported a 72-hour window with 17 decisions, zero executions, and 13571 TCA
  samples.

### Simulation Evidence

- Simulation `/trading/health` returned operational `status=ok`.
- Simulation proof floor still reported `repair_only`, `capital_state=zero_notional`, and max notional `0`.
- Simulation alpha readiness had three shadow hypotheses, zero promotion eligible, and three rollback required.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, and `market_context_stale`.
- Simulation routeability had one probing symbol, `NVDA`, seven missing symbols, and zero routeable symbols.
- Simulation TCA was stale at about 94266 seconds versus an 86400 second threshold, and there was one unsettled
  execution.
- Simulation quant evidence was degraded because latest metrics were empty and stages were missing.

### Source Assessment

- `services/torghut/app/trading/proof_floor.py` is the strongest current capital receipt producer. It already separates
  live submission, alpha readiness, empirical, quant ingestion, market context, execution TCA, repair ladder, and route
  reacquisition.
- `services/torghut/app/trading/route_reacquisition.py` already emits symbol-level route states and repair candidates.
- `services/torghut/app/trading/submission_council.py` fetches typed Jangar quant health and classifies quant evidence
  as blocking or informational.
- `services/torghut/app/trading/revenue_repair.py` maps blockers into repair actions but does not yet settle after
  receipts.
- `services/torghut/app/main.py` is 4188 lines and should not grow into another policy engine.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4401 lines and should consume compact convoy decisions
  rather than add more proof assembly.
- Source search found the latest accepted design objects only in docs, not implementation:
  `quant_stage_cohort`, `evidence_repair_settlement`, `zero_notional_route_repair_packets`,
  `quant_freshness_debt_ledger`, and `outcome_priced_repair_market`.
- The next source change should add pure reducers and route fields with focused tests, not embed another trading gate in
  `main.py` or the scheduler pipeline.

## Problem

Torghut has enough receipts to keep capital closed, but not enough executable receipt settlement to improve
profitability with discipline.

The system currently says:

- live is serving but degraded;
- sim is operationally OK but still repair-only;
- route repair candidates exist, but none are capital-ready;
- quant is fresh in aggregate but broken in the account/window surfaces that matter;
- empirical jobs are present but stale;
- options can be ready while still lacking a useful success timestamp;
- accepted design objects name richer ledgers than current source exposes.

This creates a practical problem for engineer and deployer stages. They can run repairs, but cannot yet prove whether a
repair bought edge, closed a proof gap, or simply generated more artifacts. Profitability improves when repairs produce
receipts that can be compared before and after, not when the system accumulates more unpriced status fields.

## Alternatives Considered

### Option A: Implement Every Recently Accepted Ledger In Order

Build quant stage cohorts, route repair packets, freshness debt ledgers, outcome-priced repair markets, and capital
shadow swaps as separate reducers.

Pros:

- Preserves every recent design artifact.
- Gives detailed vocabulary for future capital surfaces.
- Avoids collapsing concepts too early.

Cons:

- Many reducers before the first deployer-usable settlement object.
- Repeats evidence assembly across fields.
- Increases the chance that status schemas diverge from the source surfaces that are live now.

Decision: reject as the immediate path. Keep those objects as specialized views fed by executable profit receipts.

### Option B: Spend The Next Window On Targeted Repairs Only

Refresh empirical jobs, repair live quant ingestion, refill sim quant metrics, rerun market context, and update route
TCA without adding a new settlement contract.

Pros:

- Directly attacks known blockers.
- Produces operational improvement quickly.
- Minimal schema change.

Cons:

- Does not record before/after repair value.
- Does not bind repair work to Jangar admission receipts.
- Does not make paper/live deployer gates auditable from one compact object.

Decision: use these repairs as convoy cargo, not as the architecture.

### Option C: Executable Profit Receipts And Repair Convoy Settlement

Torghut emits compact executable profit receipts and settles zero-notional repairs as convoys with before refs,
required after refs, Jangar admission, and capital hold decisions.

Pros:

- Converts repair work into measurable before/after evidence.
- Reuses current proof-floor and route-reacquisition producers.
- Keeps paper and live notional at zero until receipts close.
- Gives Jangar one stable consumer contract for capital receipt convergence.
- Lets specialized ledgers become derived views instead of separate sources of truth.

Cons:

- Adds a new receipt contract.
- Requires consistent receipt IDs across existing proof objects.
- Delays paper until receipt chains are complete.

Decision: select Option C.

## Architecture

### ExecutableProfitReceipt

Add a pure reducer under `services/torghut/app/trading/`:

```text
executable_profit_receipt
  schema_version
  receipt_id
  generated_at
  fresh_until
  account_label
  trading_mode
  window
  torghut_revision
  torghut_image_digest
  profit_hypothesis_id
  symbol_scope
  capital_surface
  max_notional
  before_refs
  after_refs
  proof_floor_ref
  route_reacquisition_ref
  quant_receipt_ref
  empirical_receipt_ref
  market_context_receipt_ref
  alpha_readiness_ref
  execution_tca_ref
  options_receipt_ref
  profit_measure
  risk_measure
  falsification_result
  jangar_capital_receipt_epoch_id
  decision
  reason_codes
  rollback_target
```

Receipt decisions:

- `observe_only`
- `repair_candidate`
- `repair_settled`
- `paper_rehearsal_candidate_hold`
- `paper_rehearsal_ready`
- `live_hold`
- `blocked`

Rules:

- `max_notional` is always `0` unless a separate capital gate is fresh and explicitly allows a nonzero surface.
- A receipt can be `paper_rehearsal_ready` only when route, quant, empirical, market context, alpha, TCA, options, and
  Jangar receipts are fresh for the same account/window.
- Live receipts require paper rehearsal closure first.
- Aggregate quant health can support observation but cannot satisfy account/window quant receipts.
- Options readiness with `last_success_ts=null` is not a passing options receipt.

### RepairConvoySettlement

Add a companion reducer:

```text
repair_convoy_settlement
  schema_version
  convoy_id
  generated_at
  account_label
  trading_mode
  target_receipt_gap
  convoy_class
  before_refs
  required_after_refs
  produced_receipts
  jangar_repair_convoy_admission_id
  max_parallelism
  max_runtime_seconds
  route_budget_ms
  max_notional
  expected_unblock_value
  expected_cost
  after_cost_unblock_value
  falsification_check
  settlement_state
  next_action
  rollback_trigger
```

Initial convoy classes:

1. `live_routeability_repair`
   - Current before state: live has zero routeable symbols, five blocked, three missing.
   - Success: at least two symbols become routeable or explicitly retired with finite reason codes.
   - Guardrail: max notional zero; no live submit changes.

2. `live_quant_ingestion_repair`
   - Current before state: live account/window ingestion lag is about `538528` seconds, and materialization is not OK.
   - Success: ingestion and materialization stages OK within the configured freshness threshold.
   - Guardrail: aggregate quant health cannot satisfy this receipt.

3. `simulation_quant_refill`
   - Current before state: `TORGHUT_SIM/15m` latest metrics count is zero and stages are empty.
   - Success: nonempty sim latest metrics and required stages present.
   - Guardrail: the `NVDA` probing path remains no-notional until sim quant and TCA settle.

4. `simulation_tca_settlement`
   - Current before state: sim TCA is older than 86400 seconds and has one unsettled execution.
   - Success: fresh TCA and zero unsettled executions.
   - Guardrail: paper rehearsal still requires alpha and market-context receipts.

5. `empirical_authority_refresh`
   - Current before state: empirical jobs are stale and authority is blocked.
   - Success: required jobs fresh, truthful, and bound to the current candidate and dataset refs.
   - Guardrail: does not unlock paper without route, quant, market-context, alpha, and Jangar receipts.

6. `market_context_refresh`
   - Current before state: market context stale and domain states empty.
   - Success: domain states present with freshness and quality receipts.
   - Guardrail: failed refresh jobs produce negative evidence rather than retries without budget.

7. `options_success_receipt`
   - Current before state: options catalog ready with `last_success_ts=null`.
   - Success: non-null success timestamp or explicit out-of-scope proof for non-options hypotheses.
   - Guardrail: options proof cannot clear unrelated route or alpha blockers.

## Measurable Trading Hypotheses

- Repairing live routeability from 0 to at least 2 routeable symbols increases the eligible paper-rehearsal universe,
  but only after quant, empirical, market context, alpha, and Jangar receipts are fresh.
- Repairing live quant ingestion from multi-day lag to threshold-compliant stages reduces false freshness from aggregate
  metrics and makes account/window proof usable.
- Refilling simulation quant metrics makes the current `NVDA` probe measurable; failure falsifies the probe as a paper
  candidate.
- Settling sim TCA and unsettled execution count to zero separates useful paper seeds from stale execution artifacts.
- Refreshing empirical authority converts the dependency quorum blocker from broad capital hold to measurable proof.
- Refreshing market context with domain-state receipts reduces stale-context alpha blockers.
- Producing an options success timestamp prevents options-dependent hypotheses from borrowing a weak ready signal.

None of these hypotheses authorizes capital by itself.

## Capital Guardrails

Paper rehearsal remains blocked unless all are true:

- Jangar `capital_receipt_epoch` allows `paper_rehearsal`;
- Torghut proof floor is no worse than paper candidate for the account/window;
- routeability has at least two routeable or valid probing symbols with fresh TCA and zero unsettled executions;
- account/window quant latest metrics are nonempty and required stages are OK;
- empirical jobs are fresh and truthful;
- market context domain states are fresh;
- alpha readiness has at least one promotion-eligible hypothesis and no rollback-required blocker for the target;
- options receipt is fresh or explicitly out of scope.

Live remains blocked unless paper rehearsal receipts close first, live submit is enabled, routeability remains healthy,
and Jangar live material-action receipts allow the live class. Live never brownouts open.

## Implementation Scope

Engineer stage should:

1. Add `executable_profit_receipts.py` and `repair_convoy_settlement.py` as pure reducers.
2. Feed them from proof floor, route reacquisition, submission council quant evidence, empirical jobs, market context,
   alpha readiness, TCA, profitability runtime, and optional options readiness.
3. Expose compact summaries in `/trading/status`, `/trading/health`, and `/trading/autonomy`.
4. Keep the first rollout shadow/status-only.
5. Add receipt IDs to `revenue_repair.py` so repair digests can point at convoys.
6. Keep `main.py` as the assembler; do not add policy branches there beyond wiring.
7. Keep scheduler changes limited to consuming convoy decisions after shadow parity.

## Validation Gates

Required tests:

- live degraded state emits receipts with `capital_surface=zero_notional`, `decision=repair_candidate`, and blockers for
  routeability, alpha readiness, market context, empirical, and live submit;
- live latest metrics with ingestion lag still fails account/window quant receipt;
- sim `NVDA` probing plus empty quant latest store stays no-notional;
- sim stale TCA and unsettled execution block paper rehearsal;
- empirical refresh convoy cannot grant paper without route, quant, market-context, alpha, and Jangar receipts;
- options ready with null `last_success_ts` is a weak receipt;
- missing Jangar capital receipt epoch blocks paper and live while allowing observe/repair candidates.

Required local checks:

- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py`
- `uv run --frozen pytest services/torghut/tests/test_route_reacquisition.py`
- new focused tests for executable profit receipts and repair convoy settlement;
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Required deployed validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.executable_profit_receipts'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.repair_convoy_settlement'`
- `curl -fsS http://torghut-sim.torghut.svc.cluster.local/trading/status | jq '.executable_profit_receipts'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.capital_receipt_epoch'`

Acceptance gate: deployer can prove live is held by routeability zero, submit disabled, stale empirical authority,
market context stale, alpha readiness, and account/window quant ingestion; sim is held by empty quant latest store,
stale TCA, unsettled execution, missing symbols, market context, and alpha readiness.

## Rollout

1. Ship reducers and route fields behind `TORGHUT_EXECUTABLE_PROFIT_RECEIPTS_MODE=shadow`.
2. Publish receipt summaries in `/trading/status`, `/trading/health`, and `/trading/autonomy`.
3. Capture one live and one simulation receipt set after rollout.
4. Compare receipts with Jangar capital receipt epoch for one full market session.
5. Allow only zero-notional repair convoy dispatch after Jangar admission is present.
6. Keep paper rehearsal and live action gates blocked until receipts close for the same account/window.

## Rollback

Rollback:

- disable receipt publication with `TORGHUT_EXECUTABLE_PROFIT_RECEIPTS_MODE=off`;
- keep proof floor and route reacquisition book unchanged;
- stop consuming repair convoy settlement in scheduler/deployer tooling;
- keep capital state zero-notional;
- leave live submit disabled.

Rollback must trigger if receipt assembly increases `/trading/health` or `/trading/status` latency beyond the existing
route budget, if receipts contradict proof floor, or if any convoy attempts nonzero notional.

## Risks

- Receipt IDs can become inconsistent across producers. Mitigation: derive IDs from account, window, revision, receipt
  class, and generated-at bucket.
- Reducers can duplicate proof-floor logic. Mitigation: proof floor remains the capital source of truth; receipts cite
  it rather than reimplementing its decision.
- Repair convoys can encourage too many jobs. Mitigation: Jangar owns admission budgets and Torghut records max
  parallelism/runtime.
- Sim paper pressure can rise from `NVDA`. Mitigation: `NVDA` remains a no-notional repair seed until quant, TCA,
  market context, alpha, and Jangar receipts close.
- Options readiness can be over-trusted. Mitigation: `last_success_ts=null` is a weak receipt and cannot satisfy
  options proof.

## Handoff

Engineer handoff: implement executable profit receipts and repair convoy settlement as pure reducers. Wire them from
existing proof-floor, route-reacquisition, quant, empirical, market-context, alpha, TCA, profitability, and options
evidence. Keep status-only shadow mode first and add focused tests for live degraded, sim degraded, and missing Jangar
epoch cases.

Deployer handoff: after rollout, capture one live receipt set and one sim receipt set. Confirm live remains zero
notional because routeability is zero, live submit is disabled, empirical authority is stale, market context is stale,
alpha readiness is not promotable, and quant ingestion is stale. Confirm sim remains zero notional because quant latest
metrics are empty, TCA is stale, one execution is unsettled, seven symbols are missing, market context is stale, and
alpha readiness is not promotable. Admit only Jangar-approved zero-notional repair convoys.
