# 140. Torghut Post-Cost Alpha Reentry And Proof-Query Market (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Decision

I am selecting **post-cost alpha reentry with a proof-query market** as Torghut's next quant profitability architecture
step.

Torghut is alive and running, but it is still correctly refusing capital. At `2026-05-07T08:12Z`,
`GET /healthz` returned `ok`; `GET /db-check` returned `ok=true`, schema current, and Alembic head
`0029_whitepaper_embedding_dimension_4096`. `GET /trading/status` returned live revision `torghut-00251`,
`mode=live`, `enabled=true`, `running=true`, `kill_switch_enabled=false`, and aligned critical toggles. Empirical jobs
were fresh and truthful for `chip-paper-microbar-composite@execution-proof`.

The blockers are capital blockers, not uptime blockers. `/trading/health` timed out after 10 seconds. The proof floor
is `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`. The live submission
gate is closed for `simple_submit_disabled`. Alpha readiness has `3` runtime hypotheses, `0` promotion eligible, and
`3` rollback required. Execution TCA is stale from `2026-04-02T20:59:45.136640Z`; the status payload reports `13775`
orders and average absolute slippage around `568.61` bps against an `8` bps guardrail. Jangar dependency quorum delays
promotion because execution trust is degraded.

The database adds two important contradictions. Torghut Postgres has `147,623` trade decisions and `13,775` TCA rows,
but `execution_order_events` has `0` rows and table statistics estimate only `17` trade decisions and `0` TCA rows.
Runtime status exposes three active hypotheses from source manifests, while `strategy_hypotheses` contains one
persisted row. Jangar's latest quant metrics are fresh, but many account/window metrics are still
`insufficient_data`, market-context snapshots are from `2026-05-06T13:44Z`, and simulation runs in Jangar's control
plane last updated on `2026-03-19`.

I am not choosing direct paper promotion and I am not choosing a blanket freeze. I am choosing a market that prices
proof queries and post-cost repairs before capital reentry. The tradeoff is that fresh empirical evidence becomes
repair priority, not paper authority. That is the right tradeoff because Torghut's next profitable move is to retire
TCA, hypothesis-parity, market-context, and proof-query debt in the order most likely to unblock capital safely.

## Runtime Objective And Success Metrics

This contract increases profitability by making post-cost alpha the first capital gate and by making expensive proof
queries compete for bounded repair budget.

Success means:

- Empirical jobs can nominate repair candidates but cannot bypass stale TCA, missing order-feed evidence, stale
  market context, or Jangar stale-verify custody.
- Each hypothesis gets a reentry state: `research_only`, `repair_bid`, `shadow_ready`, `paper_ready`,
  `live_micro_ready`, or `blocked`.
- TCA refresh, order-feed backfill, hypothesis source/DB parity, and market-context freshness are measurable repair
  bids with expected capital unblock value.
- `/trading/health` uses precomputed proof receipts and returns within `5s`; slow proof families become
  `query_budget_exhausted` bids instead of endpoint timeouts.
- Paper canary remains impossible until post-cost expectancy is positive after slippage, order-feed coverage is
  non-zero, the relevant hypothesis is promotion eligible, and Jangar verification trust is current.

Initial success thresholds:

- TCA freshness under `24h` before paper, under `4h` before live micro.
- Average absolute slippage at or below the hypothesis budget: `12` bps for continuation and reversion, `8` bps for
  microstructure.
- Order-feed coverage above `95%` for executions used in TCA.
- Hypothesis source/DB parity at `100%` for active candidates before paper.
- Market-context freshness under `300s` for context-using hypotheses during market hours.
- `/trading/health` route budget under `5s`.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, empirical
artifacts, GitOps resources, ClickHouse data, or trading flags.

### Cluster And Service Evidence

- Torghut pods were Running: live `torghut-00251-deployment`, sim `torghut-sim-00351-deployment`, Postgres,
  ClickHouse, Keeper, TA, TA sim, options TA, options catalog/enricher, WebSocket services, guardrail exporters,
  Alloy, and Symphony.
- Several old Knative revisions were scaled to `0/0`; current live and sim revisions were `1/1`.
- Recent events repeatedly warned that ClickHouse pods match multiple PodDisruptionBudgets. The service account cannot
  list PDBs, Knative services, Argo Rollouts, or CNPG clusters, so the deployer validation path must use permitted
  Kubernetes reads and service routes.
- Jangar is serving, but its `/ready` payload degrades execution trust because the verify stage is stale. That makes
  Torghut's dependency quorum a capital hold.

### Route Evidence

- `/healthz`: `{"status":"ok","service":"torghut"}`.
- `/db-check`: `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one schema head, and known lineage warnings for parent forks around
  revisions `0010` and `0015`.
- `/trading/health`: client timeout after `10s`.
- `/trading/status`: running live revision `torghut-00251`, submit disabled, zero notional, no promotion-eligible
  hypotheses, and Jangar dependency quorum `delay`.
- Quant evidence: not required, `status=degraded`, `reason=quant_pipeline_stages_missing`, latest metrics updated
  `2026-05-07T08:11:27Z`, and metrics lag `32s` for the scoped account/window in the status payload.
- Empirical jobs: `healthy`, with `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` fresh for the chip dataset.
- Forecast service: `degraded`, authority `blocked`, message `registry_empty`.
- Market context: optional in current config, but no last symbol/as-of/quality on the live status payload.

### Database And Data Evidence

- Torghut DB connected as application user `torghut_app`.
- Actual row counts and freshness:
  - `trade_decisions`: `147,623`, latest `2026-05-06 17:44:19+00`.
  - `executions`: `13,778`, latest `2026-04-03 05:32:38+00`.
  - `execution_tca_metrics`: `13,775`, latest `2026-04-02 20:59:45+00`.
  - `execution_order_events`: `0`.
  - `position_snapshots`: `42,186`, latest `2026-05-06 20:58:44+00`.
  - `vnext_empirical_job_runs`: `20`, latest `2026-05-06 16:27:32+00`.
  - `strategy_hypothesis_metric_windows`: `3`, latest `2026-05-06 18:01:00+00`.
  - `strategy_hypotheses`: `1`, latest `2026-05-06 22:34:19+00`.
- Postgres table estimates are stale for key proof tables: `pg_stat_user_tables` estimated `17` trade decisions and
  `0` TCA rows despite the actual counts above. Proof queries and planners need stats custody, not just schema
  custody.
- Jangar DB estimates `50,969,757` quant pipeline health rows, `3,722,580` quant metrics series rows, and `4,032`
  latest metrics rows. A recent pipeline aggregation timed out under a 5 second statement budget.

### Source Evidence

- `services/torghut/app/main.py` is `4124` lines and currently composes readiness, trading status, empirical jobs,
  quant evidence, live submission gate, and proof floor.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and owns quant health and live gate evaluation.
- `services/torghut/app/trading/proof_floor.py` is `558` lines and already turns blockers into repair ladder items.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` is `683` lines and should not absorb more proof
  branching.
- The test surface is broad: `149` Python test files under `services/torghut/tests`, plus focused coverage for proof
  floor, empirical jobs, hypotheses, trading API, submission council, policy checks, TCA, and scheduler safety.
- The missing source layer is a bounded post-cost proof receipt that the health route can read cheaply and the capital
  gate can trust.

## Problem

Torghut has enough data to explain why capital is blocked, but not enough settled proof to rank the repairs that would
make capital profitable again.

Fresh empirical jobs are useful but insufficient. They say a candidate deserves attention; they do not prove that the
candidate survives live slippage, that order-feed evidence covers the executions, that source and database hypotheses
agree, or that Jangar is current enough to custody the decision.

The current system also makes some proof reads too expensive or too late:

- `/trading/health` can time out while `/trading/status` eventually emits the needed blockers.
- TCA evidence is stale by more than a month.
- Order-feed normalized events are empty.
- Runtime and DB hypothesis counts disagree.
- Database statistics are stale enough to mislead query planning.
- Jangar quant pipeline history is large enough that direct aggregations can exceed operator budgets.

The next architecture needs to convert these facts into an ordered, measurable repair market.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper

Pros:

- Fastest way to collect new observations.
- Uses the fresh Janus and parity evidence before it decays.
- Keeps the quant lane visibly active.

Cons:

- Ignores stale TCA and high slippage.
- Ignores empty order-feed coverage.
- Ignores zero promotion eligibility.
- Ignores stale Jangar verify trust.

Decision: reject.

### Option B: Run A One-Off TCA And Market-Context Backfill

Pros:

- Directly addresses two concrete blockers.
- Operationally familiar.
- May unblock some shadow readiness quickly.

Cons:

- Does not fix `/trading/health` timeout behavior.
- Does not price proof-query cost or DB stats drift.
- Does not settle source/DB hypothesis parity.
- Likely repeats as soon as evidence ages again.

Decision: reject as the system design.

### Option C: Post-Cost Alpha Reentry With A Proof-Query Market

Pros:

- Treats empirical evidence as a repair bid, not as capital authority.
- Makes TCA, order-feed coverage, hypothesis parity, market context, and Jangar custody explicit bids.
- Gives `/trading/health` a small settled proof payload.
- Prioritizes repairs by expected capital unblock value and operational risk.
- Keeps observe and zero-notional repair active while holding paper/live capital.

Cons:

- Requires one reducer and one persisted receipt family.
- Requires calibration of expected unblock value.
- May keep paper blocked longer than a manual one-off repair.

Decision: select Option C.

## Architecture

Torghut emits one post-cost alpha reentry receipt per account, revision, and market window.

```text
post_cost_alpha_reentry_receipt
  receipt_id
  generated_at
  account_label
  torghut_revision
  market_window
  proof_floor_ref
  jangar_verification_trust_ref
  health_route_budget_ref
  capital_state                 # zero_notional, repair_only, shadow_ready, paper_ready, live_micro_ready
  max_notional
  selected_repair_bid_refs
  blocked_repair_bid_refs
  hypothesis_states
  reason_codes
  fresh_until
  rollback_target
```

Each proof repair becomes a bid.

```text
proof_query_market_bid
  bid_id
  evidence_family               # tca, order_feed, hypothesis_parity, market_context, quant_pipeline, db_stats
  blocker_code
  current_value
  threshold
  query_budget_ms
  observed_query_ms
  expected_unblock_value
  empirical_support_refs
  validation_command_ref
  capital_effect                # observe_only, shadow_ready, paper_hold_removed, live_hold_removed
  selected
  reason_codes
```

Initial repair order under the current evidence:

1. `tca_refresh`: stale since `2026-04-02`, highest capital impact.
2. `order_feed_coverage`: `execution_order_events=0`, required to trust TCA and reconciliation.
3. `hypothesis_parity`: runtime has three hypotheses; DB has one persisted hypothesis row.
4. `health_route_budget`: `/trading/health` must answer from settled receipts within `5s`.
5. `market_context_freshness`: required for event reversion and LLM/context-using lanes.
6. `quant_pipeline_stage_rollup`: Jangar latest metrics are fresh, but stage proof must be scoped and cheap.

## Hypotheses And Guardrails

- `H-CONT-01` continuation: stays `repair_bid` until signal lag is under `90s`, TCA is fresher than `24h`, average
  absolute slippage is at most `12` bps, and Jangar verification trust is current.
- `H-MICRO-01` microstructure breakout: stays `blocked` until feature rows and drift checks exist, order-feed coverage
  is above `95%`, TCA is fresher than `24h`, and average absolute slippage is at most `8` bps.
- `H-REV-01` event reversion: stays `repair_bid` until market context freshness is under `120s` during market hours,
  TCA is fresher than `24h`, and Jangar verification trust is current.

Paper canary requires all of the following:

- live submit still intentionally enabled by deployer, not inferred from proof;
- selected hypothesis state `paper_ready`;
- post-cost expectancy positive after slippage and fees;
- order-feed coverage above `95%`;
- no `query_budget_exhausted` on selected evidence families;
- Jangar verification trust receipt `current`;
- rollback target `zero_notional`.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a post-cost alpha reentry reducer beside `proof_floor.py` and `submission_council.py`.
- Persist or expose a compact receipt that `/trading/health` and `/trading/status` can both read without recomputing
  heavy proof families.
- Add repair bids for TCA freshness, order-feed coverage, hypothesis parity, health route budget, market context, and
  Jangar quant pipeline stage rollups.
- Add source/DB hypothesis parity checks using active source manifests and persisted strategy hypothesis rows.
- Add DB stats custody checks for the proof tables whose actual counts diverge materially from planner estimates.
- Keep the scheduler in zero-notional repair mode until receipts reach `paper_ready`.

## Validation Gates

Engineer acceptance:

- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k "trading_health or proof_floor"`
- New tests prove stale TCA, empty order-feed events, hypothesis parity mismatch, and query-budget exhaustion keep
  `max_notional=0`.
- `curl -m 5 http://torghut.ide-newton.ts.net/trading/health` returns a receipt-backed payload or a bounded degraded
  payload.
- `curl -m 5 http://torghut.ide-newton.ts.net/trading/status` includes the same receipt id as health for the current
  proof floor.

Deployer acceptance:

- `/db-check` remains schema-current.
- TCA receipt is fresher than `24h` before paper and `4h` before live micro.
- `execution_order_events` coverage for TCA-backed executions is above `95%`.
- Active hypothesis source and DB parity is `100%`.
- Jangar verification trust is current.
- Live submit remains disabled until all gates pass and an explicit deployer action widens paper.

## Rollout

1. Emit the post-cost receipt read-only and compare it with the existing proof floor.
2. Serve `/trading/health` from the receipt while preserving current status payload fields.
3. Start selecting repair bids but keep `max_notional=0`.
4. After TCA, order-feed, parity, and Jangar trust gates pass, allow paper canary for one hypothesis and one account.
5. Keep live micro and scale blocked until paper canary has fresh post-cost settlement.

## Rollback

Rollback target is always `zero_notional`.

- Disable receipt enforcement if it disagrees with the existing proof floor and keep receipt emission for diagnosis.
- Close paper canary by setting the capital state back to `repair_only`; do not delete evidence rows.
- Hold all live actions if `/trading/health` exceeds `5s`, Jangar verification trust is stale, or TCA freshness exceeds
  the threshold.
- Do not mutate database rows by hand to clear a blocker; repair through the owning job or GitOps-controlled rollout.

## Risks

- DB stats custody may require an operational ANALYZE path that the current app role cannot perform.
- Order-feed coverage may expose older execution data that cannot be fully reconstructed.
- Health route receipts can become stale if the reducer fails; freshness and last-good semantics must be visible.
- Expected unblock value can be gamed unless it is tied to concrete gates and post-cost thresholds.

## Handoff Contract

Engineer owns the reducer, receipt payload, tests, and bounded route behavior. Deployer owns GitOps rollout and the
paper-widen decision after gates pass. Until the receipt says `paper_ready`, Torghut remains in observe and
zero-notional repair mode, no matter how fresh empirical proof looks.
