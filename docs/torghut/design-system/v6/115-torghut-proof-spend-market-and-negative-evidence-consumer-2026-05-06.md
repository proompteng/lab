# 115. Torghut Proof Spend Market And Negative Evidence Consumer (2026-05-06)

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

Torghut should consume Jangar action SLO budgets through a **proof spend market** before it spends repair time or
broker capital.

The current service state is workable but not capital-grade. Torghut `/healthz` returns HTTP `200`; Torghut live and
simulation deployments are rolled out; Postgres, ClickHouse, Alpaca, database schema, and the Jangar universe are
healthy in `/readyz`. The same `/readyz` payload returns HTTP `503` because live submission is disabled, capital stage
is `shadow`, empirical jobs are degraded, three hypotheses require rollback, and no hypothesis is promotion eligible.
Jangar global quant latest metrics are fresh, but the quant alert route still has open critical lag alerts for scoped
strategy/window tuples. Market context for `AAPL` is degraded across technicals, fundamentals, news, and regime.

The selected design turns those holds into a ranked proof-spend market. Torghut should not treat every missing proof as
equally urgent. It should choose repair and shadow work by expected information value, capital-unlock probability, data
freshness impact, and runtime cost. Jangar budgets tell Torghut which action classes are allowed; Torghut's proof market
decides which proof repair deserves the next slot.

The tradeoff is that profitability work becomes more explicit and slower to bypass. I accept that. A control-plane hold
is useful only if it causes the next best proof to be repaired. Otherwise it is just a stopped system.

## Current Evidence

All evidence below came from read-only cluster commands or service-owned HTTP projections.

### Cluster And Route Evidence

- Torghut live `torghut-00234-deployment` and sim `torghut-sim-00316-deployment` were both successfully rolled out.
- Torghut pods for live, sim, Postgres, ClickHouse, Keeper, websocket services, options services, TA services, Alloy,
  exporters, and Symphony were running.
- Recent Torghut events still showed duplicate ClickHouse PDB matches and Keeper PDB no-pod warnings.
- A FlinkDeployment event for `torghut-options-ta` reported that status had been modified externally during a running
  job state.
- Torghut `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut `/readyz` returned HTTP `503` and `status=degraded`.

### Database And Data Evidence

- Direct pod exec and CNPG access were not available to the worker service account, so database assessment used
  Torghut `/db-check` and Jangar control-plane projections.
- Torghut `/db-check` returned HTTP `200`, schema current at expected head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and `account_scope_ready=true`.
- `/db-check` still reported lineage warnings for historical parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` dependencies reported Postgres, ClickHouse, Alpaca, database schema, and Jangar universe as healthy.
- `/readyz` also reported `readiness_cache.cache_stale=true`, `empirical_jobs.detail=degraded`,
  `live_submission_gate.allowed=false`, `capital_stage=shadow`, `promotion_eligible_total=0`,
  `rollback_required_total=3`, and `quant_evidence.reason=quant_health_not_configured`.
- Jangar quant health reported a fresh global latest-metrics store with `latestMetricsCount=3780` and
  `metricsPipelineLagSeconds=1`.
- Jangar quant alerts included open critical `metrics_pipeline_lag_seconds` alerts for strategy/window tuples that were
  stale on 2026-05-05.
- Jangar market-context health for `AAPL` reported `overallState=degraded`; technicals, fundamentals, news, and regime
  were all stale.

### Source Evidence

- `services/torghut/app/main.py` assembles readiness, database checks, trading health, quant evidence, empirical jobs,
  live submission gates, and route payloads.
- `services/torghut/app/trading/submission_council.py` already has typed Jangar quant-health consumer logic and tests.
- `services/torghut/app/trading/scheduler/pipeline.py` records market-context observations, rejection reasons,
  signal-continuity state, and decision context.
- `services/torghut/app/trading/hypotheses.py` evaluates hypothesis runtime state and promotion eligibility.
- `services/torghut/tests/test_trading_api.py`, `services/torghut/tests/test_submission_council.py`,
  `services/torghut/tests/test_hypotheses.py`, `services/torghut/tests/test_market_context.py`, and
  `services/torghut/tests/test_db.py` are the natural test homes for the consumer contract.

## Problem

Torghut has enough observability to know why capital is held, but not enough structure to decide which proof to repair
first.

The present state names several blockers:

1. live submission disabled;
2. empirical jobs degraded;
3. rollback required for all currently tracked hypotheses;
4. promotion eligible total is zero;
5. market context is stale;
6. scoped quant alerts remain open even while a global latest-store projection is fresh;
7. data-plane rollout ambiguity exists in events.

Those blockers are not equal. Some produce high-value learning if repaired now. Some are capital gates but not useful
repair targets during the current session. Some are rollout hygiene that should block widening but not shadow research.
Torghut needs a market for proof spend: every repair candidate must define the missing proof, expected capital unlock,
expected post-cost edge, runtime cost, and stop condition.

## Alternatives Considered

### Option A: Keep Torghut Shadow-Only Until All Signals Are Green

Pros:

- Safe for live broker capital.
- Simple to reason about.
- Fits the current `simple_submit_disabled` posture.

Cons:

- Does not rank repairs.
- Lets stale market context, empirical jobs, and quant proof compete through manual judgment.
- Slows profitability learning even when observe and paper actions are safe.

Decision: reject as the architecture. Keep it as the emergency default when Jangar budgets are missing.

### Option B: Make Quant Health The Only Reentry Gate

Pros:

- Directly addresses quant freshness and latest-store concerns.
- Easy to wire into the existing submission council.
- Gives a crisp account/window condition before paper or live capital.

Cons:

- Ignores empirical job debt and rollback-required hypotheses.
- Does not decide whether market context, signal continuity, or data-plane rollout ambiguity should spend the next
  repair slot.
- Can block learning when quant proof is fresh globally but stale or alerting for scoped strategy/window tuples.

Decision: reject as the whole system. Quant health is a required input, not the proof market.

### Option C: Proof Spend Market Consuming Jangar Action Budgets

Pros:

- Converts Jangar action budgets into Torghut repair and capital decisions.
- Keeps observe/shadow work active while paper/live capital is held.
- Ranks repairs by expected information value and capital unlock probability.
- Prevents route health from being mistaken for profit authority.
- Gives engineer and deployer stages concrete acceptance gates.

Cons:

- Adds a new consumer reducer and persistence contract.
- Requires conservative scoring so proof spend cannot become a capital bypass.
- Needs shadow comparison before any broker-facing enforcement.

Decision: select Option C.

## Chosen Architecture

Torghut introduces a proof-spend market that consumes Jangar `action_slo_budget` records.

```text
proof_spend_round
  round_id
  account
  window
  release_digest
  jangar_router_epoch_id
  action_budget_refs
  capital_stage
  candidate_repairs
  winning_repairs
  expected_information_value
  expected_capital_unlock_probability
  max_runtime_seconds
  max_notional_delta
  observed_at
  expires_at
```

```text
proof_repair_bid
  bid_id
  round_id
  proof_gap                 # quant_scoped_latest, empirical_jobs, market_context,
                            # signal_continuity, rollback_rehearsal, data_plane_rollout
  action_class_unlocked
  required_budget_decision
  expected_output_ref
  validation_command
  stop_condition
  expected_information_value
  expected_capital_unlock_probability
  runtime_cost_score
  risk_score
  decision                  # accept, observe, defer, reject
```

The first proof gaps are:

- `quant_scoped_latest`: prove the target account/window/strategy has non-empty latest metrics and no open critical lag
  alerts inside the required window.
- `empirical_jobs`: refresh stale empirical jobs for the highest-capacity hypothesis family.
- `market_context`: refresh stale technicals, fundamentals, news, and regime for the active universe.
- `signal_continuity`: prove cursor-tail stability and actionable signal coverage.
- `rollback_rehearsal`: clear rollback-required hypothesis debt before any paper-to-live promotion.
- `data_plane_rollout`: resolve duplicate PDB or Flink status-race ambiguity before deploy widening.

Scoring is intentionally conservative:

```text
expected_information_value =
  expected_post_cost_edge_bps
  * capital_unlock_probability
  * data_confidence
  * hypothesis_capacity_score
  * jangar_action_budget_weight
  - runtime_cost_score
  - risk_score
```

Missing inputs reduce the score. They never create capital authority.

## Capital Guardrails

- `torghut_observe` can run when Jangar budget decision is `allow` and the action is read-only.
- `shadow_decide` can run when market or quant proof is stale, but the action produces evidence and spends no broker
  capital.
- `paper_canary` requires a Jangar `paper_canary` budget, fresh scoped quant proof, fresh empirical proof, market
  context not degraded for the active universe, and zero unresolved rollback-required hypotheses for the candidate.
- `live_micro_canary` requires paper settlement, broker-event reconciliation, TCA freshness, clean rollback rehearsal,
  and a Jangar live budget.
- `live_scale` requires positive post-cost paper/live micro-canary settlement and no open critical proof-spend
  blockers.

The proof market can spend repair runtime while capital is held. It cannot mint capital authority.

## Implementation Scope

Engineer stage owns:

1. Add a Torghut proof-spend reducer that accepts Jangar action budgets plus Torghut readiness, quant, empirical,
   market-context, signal, rollback, and data-plane evidence.
2. Add persistence for proof-spend rounds and repair bids, or a first observe-mode projection if persistence is delayed.
3. Extend `/readyz` or `/trading/status` with proof-spend state in observe mode.
4. Add tests proving stale market context, open critical scoped quant alerts, degraded empirical jobs, and
   rollback-required hypotheses can win repair bids but cannot allow paper/live capital.
5. Add tests proving a fresh Jangar observe budget permits zero-notional proof production.
6. Add tests proving missing Jangar budgets fail closed to shadow/hold.

Deployer stage owns:

1. Run one market-session shadow comparison between existing readiness gates and proof-spend decisions.
2. Verify proof-spend rounds cite the Jangar router epoch and action budget ids.
3. Confirm the winning repair explains expected output, validation command, runtime budget, and stop condition.
4. Enforce only observe/shadow proof spend first.
5. Enable paper-canary consumption only after scoped quant, empirical, market-context, and rollback proof are fresh.

## Validation Gates

- Torghut `/db-check` remains HTTP `200`, schema current, and account-scope ready.
- Jangar action budgets are fresh for the target account/window/release digest.
- Proof-spend state is visible without pod exec, CNPG access, or manual database reads.
- Open critical scoped quant alerts block paper/live capital even if global latest metrics are fresh.
- Stale market context blocks capital but can win a bounded repair bid.
- Degraded empirical jobs and rollback-required hypotheses block capital until repaired or explicitly waived with a
  rollback target.
- Data-plane rollout ambiguity blocks deploy widening but not read-only observation.

## Rollout

1. Implement proof-spend projection in observe mode.
2. Compare proof-spend decisions with current `/readyz`, submission-council, and Jangar budget decisions for one market
   session.
3. Enforce observe/shadow proof spend.
4. Enforce paper-canary proof spend after scoped quant and empirical proof freshness is demonstrated.
5. Enforce live micro-canary and live scale only after paper settlement and rollback rehearsal.

## Rollback

- Disable proof-spend enforcement and return to the existing `simple_submit_disabled`/capital-stage shadow posture.
- Preserve proof-spend rounds as audit evidence even when enforcement is disabled.
- If Jangar budget parsing fails, Torghut must fail closed for paper/live capital and keep observe routes available.
- If proof-spend scoring is wrong, reject all bids except read-only observation until the reducer is fixed.

## Risks

- The market can over-rank cheap repairs that do not unlock profit. Mitigation: require expected capital unlock and
  post-cost edge inputs; missing values lower the score.
- A fresh global quant projection can mask stale scoped strategy/window alerts. Mitigation: paper/live gates require
  scoped proof and no open critical scoped alerts.
- Proof repair can consume runtime during a cluster brownout. Mitigation: Jangar action budgets set maximum runtime and
  action class before Torghut bids are accepted.
- Market-context repairs can dominate if external providers are flaky. Mitigation: cap consecutive market-context
  repair spend and allow only observe/shadow output until freshness is restored.

## Handoff Contract

Engineer acceptance is a merged PR that exposes proof-spend decisions in observe mode and includes tests for stale
market context, open scoped quant alerts, degraded empirical jobs, rollback-required hypotheses, and missing Jangar
budgets.

Deployer acceptance is a shadow-session report showing which repair bid would have won under current evidence, which
capital action stayed held, and which rollback flag disables enforcement. No paper or live capital may consume this
contract until that report exists and Jangar action budgets are fresh.
