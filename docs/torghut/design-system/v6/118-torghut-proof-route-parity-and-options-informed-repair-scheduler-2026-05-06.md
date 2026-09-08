# 118. Torghut Proof Route Parity And Options-Informed Repair Scheduler (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

Torghut will adopt **proof-route parity and an options-informed repair scheduler** before any paper or live capital
readmission.

The live system is operational but not capital-ready. Live `torghut-00236` and sim `torghut-sim-00322` are running.
Postgres, ClickHouse, Alpaca, and the 12-symbol Jangar universe are healthy from the live route. `/db-check` is HTTP
`200` with the Alembic head current at `0029_whitepaper_embedding_dimension_4096`. Options catalog, options enricher,
live TA, and sim TA are up. Those are useful assets.

The same evidence says capital must stay held. Live `/readyz` and `/trading/health` are HTTP `503`. Live submission is
blocked by `simple_submit_disabled`. Alpha readiness has three hypotheses, zero promotion-eligible hypotheses, and
three rollback-required hypotheses. Jangar dependency quorum fetches inside Torghut are failing with connection
refused. Quant health is not configured for the live route, while the Jangar typed live-account route is reachable but
stale by `67353` seconds and the sim account route is empty. Empirical jobs are still stale from the March 18 dataset.
Signal continuity has a `cursor_ahead_of_stream` alert. The options catalog is ready but reports `last_success_ts=null`,
while the enricher has a current success timestamp.

I am not choosing a generic repair backlog. I am choosing a scheduler that first proves the routes carrying evidence are
the same between Jangar, Torghut live, and Torghut sim, then ranks repairs by the profit option they unlock. The
tradeoff is that we will spend engineering time on proof plumbing before attempting a paper canary. That is the right
tradeoff. A profitable quant system needs fresh edge and a reliable proof path. If either one is missing, capital stays
at `0`.

## Evidence Snapshot

All cluster and database assessment was read-only. Direct database shells were not available to this runner:
`pods/exec` is forbidden in the `torghut` namespace, and ClickHouse HTTP requires credentials. I used Torghut and
Jangar service-owned projections for database and data evidence.

### Runtime And Data Evidence

- Torghut live `torghut-00236-deployment` was `1/1`; sim `torghut-sim-00322-deployment` was `1/1`.
- Torghut Postgres, ClickHouse replicas, Keeper, options catalog, options enricher, live TA, sim TA, websocket, Alloy,
  and Symphony pods were running.
- `/healthz` on live and sim returned HTTP `200`.
- Live `/readyz` returned HTTP `503` with scheduler healthy, Postgres healthy, ClickHouse healthy, Alpaca broker status
  `broker_ok`, fresh Jangar universe, DB schema current, empirical jobs degraded but not required, and live submission
  blocked by `simple_submit_disabled`.
- Live `/db-check` returned HTTP `200`, `schema_current=true`, `schema_graph_lineage_ready=true`,
  `schema_head_signature=3c1a76a911bc0a1af7d88d931bd53837ef1d5a4b0eac48c9b690317f3e76756d`, and
  `account_scope_ready=true`.
- Live `/trading/status` reported active revision `torghut-00236`, build commit
  `61ee8f7aee31e623f93a3a1881bf2b08ae1e54c3`, `last_decision_at=2026-05-04T17:25:57.901670Z`,
  `orders_submitted_total=0`, `planned_decision_age_seconds=0`, and signal continuity alert
  `cursor_ahead_of_stream`.
- Live `/trading/autonomy` reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all created on `2026-03-21T09:03:22.150009+00:00` for candidate
  `intraday_tsmom_v1@prod`.
- Sim `/trading/health` returned HTTP `200`, but its quant evidence carried `quant_health_fetch_failed` against
  `http://jangar.jangar.svc.cluster.local/...`.
- Jangar typed quant health for live account `PA3SX7FYNUTF`, window `15m`, returned HTTP `200`, `status=ok`,
  `latestMetricsCount=108`, and stale `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`.
- Jangar typed quant health for `TORGHUT_SIM`, window `15m`, returned HTTP `200`, `status=degraded`,
  `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.
- `torghut-options-catalog` returned HTTP `200`, `ready=true`, and `last_success_ts=null`.
- `torghut-options-enricher` returned HTTP `200`, `ready=true`, and
  `last_success_ts=2026-05-06T12:10:17.331627+00:00`.
- Live and sim Flink TA REST endpoints each returned one `RUNNING` job.

### Source Evidence

- `services/torghut/app/config.py` keeps Jangar status and quant-health integration as optional URL settings:
  `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` and `TRADING_JANGAR_QUANT_HEALTH_URL`.
- `services/torghut/app/main.py` builds readiness, trading health, trading status, autonomy status, DB checks, and live
  submission gate payloads from those settings and service-owned data checks.
- `services/torghut/app/trading/submission_council.py` already turns quant-health status, empirical jobs, dependency
  quorum, and promotion eligibility into capital-gate reasons.
- `services/torghut/app/options_lane/repository.py` owns the Postgres-backed options catalog, subscription state,
  watermarks, and status counts that can become repair scheduling inputs.
- `services/torghut/config/trading/hypotheses/*.json` already names dependency capabilities such as
  `jangar_dependency_quorum`, `market_context_freshness`, `signal_continuity`, and `feature_coverage`.
- The high-risk modules are concentrated: `main.py` is `4051` lines, `scheduler/pipeline.py` is `4349` lines,
  `submission_council.py` is `1196` lines, and `options_lane/repository.py` is `941` lines.

## Problem

Torghut currently has healthy subsystems and unhealthy proof routes. Treating those as the same thing would either
freeze useful zero-notional repair or allow capital on incomplete proof.

The current capital blockers are route-specific and proof-specific:

1. Torghut live cannot prove it is reading the serving Jangar status route.
2. Torghut live does not require or cite Jangar quant health in `/trading/health`.
3. Jangar can answer live account quant health, but the data is stale.
4. Jangar can answer sim account quant health, but the latest store is empty.
5. Empirical proof is stale for the only named production candidate.
6. Options infrastructure is alive, but catalog discovery success and watermarks are not yet capital-grade.
7. Signal continuity and rollback-required hypotheses correctly keep promotion eligibility at zero.

The architecture gap is proof-route parity. Torghut needs to know whether live, sim, and Jangar are talking about the
same endpoint contract before it prices any repair or prepares any order path.

## Alternatives Considered

### Option A: Fix The Jangar URL And Recheck Health

Pros:

- Solves the most obvious failure quickly.
- Gives live `/trading/health` a chance to observe dependency quorum again.
- Small operational change.

Cons:

- Does not prove sim/live parity.
- Does not bind freshness, route identity, and capital gate in one record.
- Does not use the options lane or empirical proof state to rank the next repair.

Decision: reject as sufficient. It is the first route-parity repair, not the architecture.

### Option B: Replay Empirical Jobs First

Pros:

- Directly addresses `empirical_jobs_degraded`.
- Moves the production candidate closer to paper-canary eligibility.
- Builds on existing empirical job tests and scripts.

Cons:

- If the Jangar status and quant-health routes remain wrong, fresh replay receipts may still be unreadable by the
  consumer that gates capital.
- Does not fix empty sim quant proof or live route quant-health configuration.
- Can spend runtime budget before the route that proves the result is reliable.

Decision: reject as the first invariant. Empirical replay remains a high-priority repair once route parity is proven.

### Option C: Proof-Route Parity With Options-Informed Repair Scheduling

Pros:

- Proves live, sim, and Jangar consume the same evidence contracts before capital gates read them.
- Keeps zero-notional repair open while holding paper and live capital.
- Uses options infrastructure as an information-value input instead of treating it as immediately capital-ready.
- Separates route repairs from profit-proof freshness repairs, which makes acceptance and rollback cleaner.

Cons:

- Delays paper capital until route parity is implemented.
- Requires new fields in readiness, trading health, scheduler observations, and submission-council verdicts.
- Requires careful ranking so options discovery does not outrank empirical replay for candidates that still lack proof.

Decision: select Option C.

## Architecture

Torghut adds two data products and one scheduler policy.

```text
torghut_proof_route_parity_receipt
  receipt_id
  observed_at
  account
  environment                  # live, sim
  evidence_contract_id
  producer_surface             # jangar_status, quant_health, empirical_jobs, market_context, options_catalog
  resolved_endpoint
  expected_endpoint
  parity_status                # ok, wrong_service, timeout, stale, empty, not_required, disabled
  freshness_seconds
  capital_gate_impact          # observe, repair, paper_canary, live_micro
  closure_action
```

```text
market_session_repair_schedule
  schedule_id
  market_session_id
  generated_at
  route_parity_receipts
  candidate_id
  hypothesis_id
  repair_items
    repair_class               # route_parity, empirical_replay, live_quant_backfill,
                               # sim_quant_bootstrap, options_catalog_watermark,
                               # market_context_refresh, signal_continuity_repair
    expected_profit_option      # low, medium, high, critical
    capital_gate_unlocked
    max_runtime_minutes
    max_query_budget
    max_notional
    guardrails
    closure_receipt_schema
```

Scheduler policy:

- Route-parity repairs run before profit-proof repairs when the affected capital gate cannot read the evidence.
- Empirical replay outranks options and market-context work for a named candidate that lacks fresh replay receipts.
- Live quant backfill outranks options work when live account/window proof is stale.
- Sim quant bootstrap outranks options work when paper canary requires sim parity and the sim latest store is empty.
- Options catalog watermark repair enters the top tier only after catalog discovery has a current success timestamp,
  watermarks are fresh, and the target hypothesis declares an options dependency.
- Paper and live preparation require `max_notional=0` until route parity, empirical replay, quant freshness, market
  context, broker reconciliation, and Jangar settlement all allow the matching capital class.

## Measurable Hypotheses

Hypothesis 1:

- If Torghut consumes Jangar status and quant health through evidence contract ids instead of raw URL strings, live and
  sim health will stop reporting `jangar_status_fetch_failed` and `quant_health_fetch_failed` for wrong service DNS.
- Success metric: both live and sim health payloads echo the active contract ids and report `parity_status=ok`.
- Guardrail: no order preparation change in this slice.

Hypothesis 2:

- If live account quant backfill runs after route parity, the stale `PA3SX7FYNUTF` 15-minute metrics lag will fall below
  the configured threshold during market hours.
- Success metric: live quant `metricsPipelineLagSeconds` remains under the configured threshold for seven consecutive
  checks or emits closure debt.
- Guardrail: `TRADING_SIMPLE_SUBMIT_ENABLED=false` and max notional `0`.

Hypothesis 3:

- If sim quant bootstrap runs before paper-canary scheduling, the empty `TORGHUT_SIM` latest store will no longer block
  sim/live proof comparison.
- Success metric: sim account quant health has nonzero latest metrics and a current account/window freshness receipt.
- Guardrail: paper canary remains disabled until empirical replay is also fresh.

Hypothesis 4:

- If options catalog and enricher status are included as repair scheduling inputs, options work will improve future
  hypothesis option value without bypassing core proof gates.
- Success metric: options catalog has a current success timestamp and watermarks before any options hypothesis is
  marked paper-eligible.
- Guardrail: options repairs cannot unlock paper or live capital unless empirical replay and quant proof are current.

## Implementation Scope

Torghut engineer scope:

- Add proof-route parity receipts to `/readyz`, `/trading/health`, `/trading/status`, and scheduler observation records.
- Consume Jangar evidence transport contract ids for dependency quorum and quant health, with raw URL fallback during
  shadow rollout.
- Add a market-session repair scheduler that emits route-parity, empirical-replay, quant-backfill, sim-bootstrap,
  options-watermark, market-context, and signal-continuity repair items.
- Extend `submission_council.py` so `wrong_service`, `timeout`, `stale`, or `empty` proof-route parity blocks paper and
  live preparation.
- Extend options-lane status with catalog discovery freshness and watermark readiness before it can contribute to
  capital eligibility.

Jangar engineer scope:

- Publish the active evidence contract ids and resolver leases described in the companion Jangar design.
- Feed Torghut proof-route parity receipts into contradiction settlement and profit repair auctions.
- Keep route-parity repair bids at `max_notional=0`.

## Validation Gates

- Unit tests prove wrong Jangar service DNS becomes a `route_parity` repair item and blocks paper/live preparation.
- Unit tests prove stale live account quant proof becomes `live_quant_backfill`.
- Unit tests prove empty sim account quant proof becomes `sim_quant_bootstrap`.
- Unit tests prove options catalog readiness with `last_success_ts=null` cannot unlock paper eligibility.
- Integration tests prove `/trading/health` includes proof-route parity receipts and Jangar contract ids.
- Scheduler tests prove route-parity repairs outrank empirical replay only when the evidence route itself is unreadable;
  otherwise fresh empirical replay outranks options and market-context repairs.
- Regression tests prove `orders_submitted_total` stays `0` and live notional stays `0` while route parity is not `ok`.

## Rollout Plan

1. Emit proof-route parity receipts in shadow mode while preserving existing URL settings.
2. Add Jangar contract ids to live and sim health payloads.
3. Fix the Jangar status and quant-health service routes through the contract resolver.
4. Run live quant backfill and sim quant bootstrap after route parity is `ok`.
5. Replay empirical jobs for `intraday_tsmom_v1@prod` after the receipts can be read by Jangar and Torghut.
6. Add options catalog watermarks to repair scheduling only after catalog discovery success is current.
7. Permit paper canary only after route parity, empirical replay, quant freshness, market context, and Jangar settlement
   all allow the exact account/strategy/window.

## Rollback Plan

- Disable proof-route parity enforcement and fall back to existing URL-based gates.
- Continue emitting receipts as ignored audit evidence during rollback.
- If repair ranking is wrong, use fixed priority: route parity, live quant backfill, sim quant bootstrap, empirical
  replay, market context, options watermarks, signal continuity.
- If options status becomes noisy, remove it from ranking while leaving core route and empirical proof gates enforced.
- If route parity is unavailable, Torghut must continue zero-notional observation only and hold paper/live capital.

## Risks

- Route parity can be mistaken for proof freshness. Mitigation: the receipt has separate `parity_status` and
  `freshness_seconds`, and capital requires both.
- Options infrastructure can look exciting before it has data quality. Mitigation: catalog discovery success and
  watermarks are required before options can affect eligibility.
- The scheduler can add complexity to already large modules. Mitigation: implement repair ranking as a pure helper with
  tests before wiring it into `main.py` or `pipeline.py`.
- Raw URL fallback can hide contract drift. Mitigation: fallback is shadow-only and must emit a repair item when used.

## Handoff

Engineer stage should start with receipts and pure ranking logic. The first mergeable slice is live/sim health echoing
Jangar contract ids plus tests for wrong service DNS, stale live quant proof, empty sim proof, and options catalog
without discovery success. Do not change broker submission in that slice.

Deployer stage should validate proof-route parity before asking for paper capital. The deployer should capture the
receipt ids, Jangar contract ids, empirical replay receipts, quant freshness receipts, options watermarks if applicable,
and the Jangar settlement id. Pod readiness is necessary, but it is not a capital gate.
