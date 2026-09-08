# 128. Torghut Data-Plane Disruption Premium And Freshness Settlement (2026-05-06)

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

Torghut will price **data-plane disruption premium and freshness settlement** into every shadow, paper, and live
profit decision.

The current system is operational but not capital-ready. Live `/readyz` returned HTTP `503` because
`simple_submit_disabled` keeps live submission blocked. The scheduler, Postgres, ClickHouse, Alpaca, database schema,
and Jangar universe were healthy, but empirical jobs were degraded, live quant evidence was not locally configured, and
Jangar's typed live quant route showed a `82551` second lag. The sim route was healthy for non-live mode but its typed
quant latest store was empty. The Torghut sim rollout also produced a failed teardown-clean analysis. Meanwhile,
Kubernetes warning events showed ClickHouse pods matching multiple PDBs.

That evidence means Torghut should not merely ask whether a hypothesis has expected edge. It should ask whether the
data plane that feeds that edge can be disrupted safely, whether the proof window is fresh, and how much expected edge
must be discounted for stale or ambiguous data. The selected design adds a data-plane disruption premium and a
freshness settlement to the capital proof path. A strategy with stale metrics, empty sim proof, ambiguous ClickHouse
disruption, or stale empirical jobs can still observe and repair; it cannot claim paper or live profit authority.

The tradeoff is stricter capital reentry and slower paper widening. I accept that because the observed failure is not
lack of alpha paperwork. It is stale proof, empty sim evidence, and stateful rollout ambiguity around the data system
that feeds alpha.

## Runtime Objective And Success Metrics

This contract increases profitability by discounting or holding expected edge when the data plane is stale, empty, or
operationally ambiguous.

Success means:

- Every capital intent cites a Jangar disruption settlement and data freshness settlement.
- Stale live quant metrics reduce expected edge to zero for paper/live promotion until refreshed.
- Empty sim latest metrics become a repair item before sim proof can support paper.
- Duplicate ClickHouse PDB ambiguity adds a disruption premium and blocks paper/live capital.
- Empirical proof, quant freshness, fillability, and disruption state settle into one capital verdict.
- Observe and zero-notional repair remain available with max notional `0`.

## Evidence Snapshot

All evidence was collected read-only. No trading flags, orders, broker state, Kubernetes resources, GitOps resources,
or database rows were changed.

### Runtime And Cluster Evidence

- Torghut pods were running across live, sim, ClickHouse, Keeper, Postgres, live TA, sim TA, options TA, options
  catalog/enricher, websocket, guardrail exporters, Alloy, and Symphony.
- Live revision `torghut-00239` was running; sim revision `torghut-sim-00335` was running.
- Torghut events showed duplicate ClickHouse PDB matches for both ClickHouse replicas, transient readiness 503s, and a
  failed `teardown-clean` AnalysisRun for `torghut-sim-teardown-clean-sim-2026-05-05-chip-5e447b6d-r1`.
- This service account could not list PDBs, CNPG clusters, Knative serving objects, or exec into database pods. Torghut
  profitability gates must therefore consume application routes plus Jangar observation settlements, not privileged
  manual SQL.

### Data And Schema Evidence

- Live `/readyz` returned HTTP `503`, `status=degraded`, scheduler OK, Postgres OK, ClickHouse OK, Alpaca live account
  OK, database schema current, universe fresh, and `live_submission_gate.allowed=false` for `simple_submit_disabled`.
- Live Alembic head was `0029_whitepaper_embedding_dimension_4096`, schema signature
  `3c1a76a911bc0a1af7d88d931bd53837ef1d5a4b0eac48c9b690317f3e76756d`, and schema lineage was ready with known parent
  fork warnings.
- Jangar live quant health for account `PA3SX7FYNUTF` returned `latestMetricsCount=108`, latest metric
  `2026-05-05T17:28:03.839Z`, `metricsPipelineLagSeconds=82551`, and `missingUpdateAlarm=true`.
- Sim `/readyz` returned OK for non-live mode, but Jangar sim quant health for `TORGHUT_SIM` returned
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Jangar control-plane receipts already hold paper and live capital because empirical jobs are stale:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

### Source Evidence

- `services/torghut/app/main.py` owns `/readyz`, database contract projection, empirical jobs, trading status, and live
  submission gate assembly.
- `services/torghut/app/trading/submission_council.py` combines dependency quorum, empirical jobs, DSPy runtime,
  quant evidence, market context, toggles, and capital stage. It is the correct consumer for Jangar settlement refs.
- `services/torghut/app/trading/empirical_jobs.py` can provide proof freshness and truthfulness for each required job.
- `services/torghut/app/trading/profitability_archive.py` owns historical proof archive material, but current runtime
  capital must discount stale or unfilled proof before it reaches paper.
- `argocd/applications/torghut/clickhouse/clickhouse-pdb.yaml` defines the GitOps ClickHouse PDB; live events prove an
  additional matching PDB also exists.
- Jangar companion status already exposes material receipts and quant freshness; Torghut should consume those refs
  instead of reimplementing Kubernetes observation logic.

## Problem

Torghut has three separate questions that are currently answered in different places:

1. Is the strategy expected to make money after costs?
2. Is the proof fresh enough to trust that expectation?
3. Is the data plane safe enough to keep producing the evidence while rollout or capital changes happen?

The runtime evidence says those questions must be settled together. A stale live metric store can make a fresh-looking
strategy untrustworthy. An empty sim store can make paper proof incomplete. Duplicate ClickHouse PDBs can turn a normal
disruption into arbitrary data-plane behavior. Stale empirical jobs can keep a promising lane in shadow until proof is
renewed.

If Torghut only optimizes for more signals, it will send capital back into the same stale proof and ambiguous data-plane
conditions. Profitability improves when the expected edge is discounted by freshness and disruption state before the
system requests paper or live capital.

## Alternatives Considered

### Option A: Refresh Empirical Jobs And Reuse Existing Submission Gates

Pros:

- Directly addresses the current dependency quorum blocker.
- Uses existing proof job contracts.
- Lowest new architecture cost.

Cons:

- Does not price stale live quant metrics.
- Does not repair empty sim latest metrics.
- Does not block capital on duplicate ClickHouse PDB ambiguity.
- Keeps data-plane disruption as a deployer concern instead of a capital input.

Decision: reject as sufficient. Empirical renewal remains required but cannot be the only gate.

### Option B: Keep Disruption Risk Outside Trading Logic

This option treats PDB overlap and rollout warnings as platform issues. Torghut gates only on trading, proof, and
broker state.

Pros:

- Clean domain boundary.
- Avoids adding Kubernetes-derived evidence to capital logic.
- Keeps submission council focused on trading surfaces.

Cons:

- Data-plane disruption can create stale or missing features that directly affect profitability.
- Jangar already owns rollout evidence; ignoring its settlement would split authority.
- A stateful data-plane warning can be missed during a market window.

Decision: reject. Torghut should consume Jangar's verdict, not own Kubernetes mechanics.

### Option C: Data-Plane Disruption Premium And Freshness Settlement

Torghut consumes Jangar disruption and freshness settlements, discounts expected edge, and blocks paper/live capital
when proof is stale, empty, or disruption-ambiguous.

Pros:

- Directly prices the observed stale live metrics and empty sim evidence.
- Lets zero-notional observe/repair continue.
- Gives one capital verdict that combines edge, freshness, empirical proof, fillability, and rollout risk.
- Avoids broad RBAC or manual SQL in deployer validation.
- Converts platform warnings into measurable trading guardrails.

Cons:

- Adds a new input to the submission council.
- Requires shadow calibration so the premium does not over-block paper.
- Requires stable Jangar settlement refs in route payloads.

Decision: select Option C.

## Architecture

### DataPlaneDisruptionPremium

Torghut consumes Jangar `disruption_budget_settlement` and converts it into a cost on expected edge.

```text
data_plane_disruption_premium
  premium_id
  generated_at
  expires_at
  account
  strategy_id
  hypothesis_id
  data_plane_ref
  jangar_disruption_settlement_ref
  disruption_decision          # allow, repair_only, ambiguous, unobserved, block
  edge_discount_bps
  capital_stage_cap            # observe, shadow_repair, paper, live_micro, live_scale
  required_repairs
```

Rules:

1. `allow` applies no disruption discount.
2. `repair_only` caps stage at shadow repair and max notional `0`.
3. `ambiguous` blocks paper and live; it also blocks live submission even if toggles are enabled.
4. `unobserved` holds paper unless a time-boxed waiver names the missing observation right.
5. `block` prevents all non-observe capital.

### FreshnessSettlementConsumer

Torghut consumes Jangar `data_freshness_settlement` and prices stale or empty evidence.

```text
freshness_settlement_consumer
  settlement_ref
  account
  window
  latest_metrics_count
  latest_metrics_updated_at
  metrics_pipeline_lag_seconds
  freshness_decision          # fresh, stale, empty, unobserved, repair_only
  edge_discount_bps
  proof_state                 # usable, repair_required, hold_capital, block_live
```

Rules:

1. `fresh` can support paper if empirical and fillability gates pass.
2. `stale` sets expected live edge to zero and holds paper until refreshed or waived.
3. `empty` creates a sim or live store backfill repair before paper.
4. `unobserved` keeps observe available but blocks live.
5. `repair_only` permits zero-notional proof generation only.

### CapitalVerdict Integration

`torghut_capital_activation_receipt` adds:

- `jangar_disruption_settlement_ref`;
- `jangar_data_freshness_settlement_ref`;
- `data_plane_disruption_premium_bps`;
- `freshness_discount_bps`;
- `post_freshness_expected_edge_bps`;
- `post_disruption_expected_edge_bps`;
- `stage_cap`;
- `required_repairs`.

Final rule:

```text
post_settlement_edge =
  expected_net_edge_bps
  - freshness_discount_bps
  - data_plane_disruption_premium_bps
```

If `post_settlement_edge <= 0`, the lane remains observe or shadow repair. If the stage cap is below paper, the lane
cannot request paper even if edge remains positive.

## Profitability Hypotheses

H1: Blocking paper/live promotion when live quant metrics are stale by more than the action window reduces false
positive alpha promotion versus route-level readiness alone.

H2: Requiring non-empty sim latest metrics before paper improves paper-to-live promotion quality by eliminating replay
windows that cannot prove current feature materialization.

H3: Applying a disruption premium during ambiguous stateful rollout periods reduces drawdown and alert churn versus
capital decisions that ignore data-plane disruption warnings.

H4: Allowing observe and zero-notional repair under stale or ambiguous data improves evidence volume without increasing
notional risk.

Measurement:

- Compare paper candidates accepted with fresh settlements versus candidates held for stale or empty settlements.
- Track realized paper PnL, fillability, and post-cost edge by settlement decision.
- Track the time from repair item to fresh settlement.
- Track whether duplicate-PDB ambiguity correlates with missing or lagged quant updates.

## Implementation Scope

Engineer scope:

- Extend submission council input parsing to accept Jangar disruption and freshness settlement refs.
- Add premium and discount reducers with fixtures for stale live metrics, empty sim metrics, ambiguous PDB, and repair
  only.
- Add capital receipt fields for post-settlement expected edge and stage cap.
- Keep live submission disabled until fresh settlement and empirical proof are current.
- Add tests that stale/empty/ambiguous evidence allows observe but blocks paper/live.

Deployer scope:

- Confirm the companion Jangar settlement refs appear in Torghut capital receipts before any paper widening.
- Fix or document ClickHouse PDB overlap through GitOps before live capital.
- Keep `simple_submit_disabled` in place until paper has fresh quant, empirical, fillability, and disruption
  settlements.
- Validate using routes and events, not pod exec or Secret reads.

## Validation Gates

Local gates:

- `pytest services/torghut/tests/test_submission_council.py` focused tests for disruption premium and freshness
  discount once implemented.
- Existing empirical job, quant readiness, fillability, and trading scheduler tests remain required for code changes.
- Fixture: stale live metrics with positive edge still holds paper/live.
- Fixture: empty sim metrics creates backfill repair.
- Fixture: ambiguous disruption settlement blocks paper/live but allows observe.

Runtime gates:

- Jangar data freshness settlement is `fresh` for the target account/window.
- Jangar disruption settlement is `allow` for ClickHouse and any other required data-plane workload.
- Torghut empirical jobs are current for all required jobs.
- Fillability receipt shows buying power pass or shrink, not reject.
- `post_settlement_edge_bps` remains positive after freshness and disruption discounts.

## Rollout And Rollback

Rollout:

1. Consume settlements in shadow mode and log the premium/discount without changing capital decisions.
2. Enforce paper holds for stale or empty freshness after two healthy settlement windows.
3. Enforce paper/live holds for ambiguous disruption after the ClickHouse PDB source is identified.
4. Require post-settlement edge for paper reentry.
5. Require live `/readyz=200`, fresh live data, no ambiguous disruption, empirical proof current, and paper settlement
   success before live micro-canary.

Rollback:

- Disable premium enforcement and keep emitting the receipt fields.
- Keep existing empirical jobs, simple-submit, quant evidence, market-context, and Jangar dependency quorum gates.
- Do not roll back by enabling live submission while freshness settlement is stale or sim proof is empty.
- Preserve zero-notional observe and repair lanes.

## Risks

- Premium calibration can be too conservative. Mitigation: ship shadow first and compare held candidates with realized
  paper outcomes.
- Jangar settlement refs may lag during route churn. Mitigation: require expiry and use repair-only instead of live
  permission when refs are stale.
- Data freshness and empirical freshness can both hold the same lane, creating duplicate repairs. Mitigation: collapse
  repairs by account, strategy, and window.
- Operators may remove duplicate PDB warnings before settlement support lands. Mitigation: keep the design because the
  next stateful data-plane can repeat the pattern.

## Engineer And Deployer Handoff

Engineer acceptance:

- Torghut receipts include Jangar disruption/freshness settlement refs and post-settlement edge.
- Stale live metrics, empty sim metrics, and ambiguous disruption each block paper/live in tests.
- Observe and zero-notional repair remain available with max notional `0`.
- No new code path requires pod exec, Secret reads, or direct database credentials.

Deployer acceptance:

- Do not widen paper or live capital until the target account/window has fresh data settlement and ClickHouse
  disruption settlement is `allow`.
- Treat `simple_submit_disabled` as intentional protection until post-settlement edge and fillability are proven.
- Resolve ClickHouse duplicate-PDB ambiguity before live micro-canary.
- Use squash merge and GitOps rollout; do not mutate runtime flags directly from the worktree.
