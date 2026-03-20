# 59. Torghut Lane Balance Sheet and Dataset Seat Auction Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`

Extends:

- `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
- `57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`
- `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`

## Executive summary

The decision is to stop treating Torghut profitability as one route-time gate answer and start persisting lane-local
economics explicitly. Torghut will compile a durable **Lane Balance Sheet** per hypothesis and a durable
**Dataset Seat** per usable data bundle, then allocate capital through a deterministic auction over those objects.

The reason is concrete in the live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns HTTP `200`
  - reports `build.active_revision="torghut-00156"`
  - reports `live_submission_gate.blocked_reasons=["alpha_readiness_not_promotion_eligible","empirical_jobs_not_ready","dependency_quorum_block","quant_health_fetch_failed","live_promotion_disabled"]`
  - reports `forecast_service.status="degraded"`
  - reports `feature_staleness_ms_p95=421444`
  - reports `feature_quality_rejections_total=22`
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - returns HTTP `200`
  - reports four stale job types
  - reports the latest empirical bundle created at `2026-03-19T10:31:27.462740+00:00`
- direct Postgres query at `2026-03-20T21:04:33.765Z`
  - reports Alembic head `0025_widen_lean_shadow_parity_status`
  - reports `trade_decisions.total=29813` with latest row at `2026-03-19T20:13:44.913240+00:00`
  - reports `executions.total=3` with latest row at `2026-03-14T19:17:43.858275+00:00`
  - reports `vnext_empirical_job_runs.total=12`
  - reports `vnext_dataset_snapshots.total=0`
  - reports `strategy_hypotheses.total=0`
- direct ClickHouse query
  - reports `ta_signals` freshest active part at `2026-03-20T20:59:00Z` with `668394` rows
  - reports `ta_microbars` freshest active part at `2026-03-20T20:58:36Z` with `523694` rows
  - reports `system.replicas.is_readonly=0` and `absolute_delay=0`
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - reports `torghut_clickhouse_guardrails_last_scrape_success 0`
  - reports `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_signals"} 829`
  - reports `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_microbars"} 1943`

The tradeoff is more additive persistence and a stricter capital compiler. I am keeping that trade because the current
system is already fail-closed, but it still cannot tell us which lanes have enough evidence quality to keep learning or
earning under mixed upstream health.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Torghut
  profitability and Jangar resilience

This artifact succeeds when:

1. every capital decision cites one `lane_balance_sheet_id`, one `dataset_seat_id`, and one Jangar
   `consumer_attestation_id`;
2. empirical freshness, feature freshness, forecast health, and quant authority are compiled into one per-lane record
   instead of being reduced independently at route time;
3. degraded-mode capital becomes explicit probe capital with a capped freshness bond, not a silent fallback;
4. the runtime, allocator, `/trading/status`, and `/trading/profitability/runtime` all reference the same compiled
   economics object.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Torghut is operating in a mixed-health regime, not a flat outage.

- `GET /healthz`
  - returns HTTP `200`
- `GET /trading/status`
  - returns HTTP `200`
  - shows the service is running and the universe resolver is healthy
  - blocks live submission because quant authority, empirical freshness, and forecast readiness disagree
- `GET /trading/profitability/runtime`
  - returned HTTP `502` with `EOF` through Istio on `2026-03-20T21:05:21Z`
- `kubectl get pods -n torghut -o wide`
  - shows the live Torghut, simulation Torghut, TA, ClickHouse, lean runner, and WS pods as running
  - shows both forecast lanes unready
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -n 40`
  - shows repeated forecast readiness failures
  - shows the live Knative revision becoming ready and then failing latest-ready flow during rollout churn

Interpretation:

- health is good enough to preserve diagnostic and shadow activity;
- the missing architecture is a durable lane-local economic record, not another global status endpoint.

### Source architecture and high-risk modules

The current source tree already contains most of the evidence inputs, but it still composes them too late.

- `services/torghut/app/trading/submission_council.py`
  - `resolve_quant_health_url()` still falls back from the explicit quant-health URL to the generic Jangar control-plane
    status URL and then to the market-context URL
- `services/torghut/app/trading/scheduler/pipeline.py`
  - commits the ingest cursor when `_build_run_context()` fails, which burns replay opportunity during upstream
    authority failure
  - handles feature-quality rejection and market-context blocking in the same mutable run loop
- `services/torghut/app/trading/scheduler/state.py`
  - stores market context, universe, signal continuity, drift, and autonomy observations in one process-local
    `TradingState`
  - does not persist per-lane economic state
- `services/torghut/app/trading/empirical_jobs.py`
  - correctly persists normalized empirical job runs
  - does not materialize a dataset seat or lane-local capital object from them
- `services/torghut/app/main.py`
  - reconstructs `/trading/status` and `/trading/profitability/runtime` from live runtime state
  - does not read a durable per-lane profitability record

The highest-risk missing tests are:

- no regression test proves the explicit quant-health URL is mandatory once dataset seats are introduced;
- no test proves empty `vnext_dataset_snapshots` and empty `strategy_hypotheses` force lane balance sheets to stay in
  `observe` or `probe` only;
- no replay test ties ClickHouse low-memory freshness fallback, stale empirical jobs, and forecast degradation to one
  deterministic auction result.

### Database, schema, freshness, and consistency evidence

The data layer is healthy enough for additive persistence, but it is not compiling the right economics yet.

- Postgres:
  - Alembic head is current
  - normalized empirical-job rows are present and truthful, but stale
  - `vnext_dataset_snapshots` is empty
  - `strategy_hypotheses` is empty
  - executions remain sparse enough that any live-capital conclusion from raw execution history would be dishonest
- ClickHouse:
  - replica health is good and tables are writable
  - freshness is available only through low-memory fallback right now
  - the exporter that should explain freshness is itself failing every scrape

Interpretation:

- the system has the raw inputs to make lane-local balance-sheet decisions;
- it is missing the durable object that composes those inputs into capital truth.

## Problem statement

Torghut still has seven profitability-critical gaps:

1. it can still derive quant authority from the wrong endpoint;
2. it has no durable object that says what one lane actually knew about freshness, empirical readiness, and forecast
   health when capital was allocated;
3. feature freshness, empirical freshness, and dataset lineage are not collapsed into one reusable seat;
4. live capital still cannot distinguish a recoverable data-quality debt from a structural lane failure;
5. route-time status and runtime profitability views can disagree because they reconstruct from different mutable state;
6. the allocator cannot ration scarce capital to the best lane under mixed health because the evidence is not
   normalized that way;
7. empty `vnext_dataset_snapshots` and empty `strategy_hypotheses` mean there is no durable bridge between research
   lineage and live runtime allocation.

That is safe enough to block. It is not good enough to compound edge.

## Alternatives considered

### Option A: require the explicit quant URL and keep the global gate model

Summary:

- make `TRADING_JANGAR_QUANT_HEALTH_URL` mandatory;
- remove the permissive fallbacks;
- keep capital decisions global and gate-based.

Pros:

- smallest implementation delta;
- removes one wrong authority path quickly.

Cons:

- still leaves profitability tied to route-time reducers;
- still cannot tell which lane deserves capital under partial outage;
- does not solve empty dataset-snapshot lineage.

Decision: rejected.

### Option B: move final capital allocation into Jangar

Summary:

- Jangar would own the final decision about per-lane live capital;
- Torghut would mainly execute.

Pros:

- one place to inspect platform and trading state.

Cons:

- couples infrastructure authority to trading economics;
- increases Jangar blast radius;
- slows hypothesis-local iteration and option value.

Decision: rejected.

### Option C: lane balance sheets and dataset-seat auction

Summary:

- Jangar provides consumer-scoped attestation;
- Torghut compiles dataset seats and lane balance sheets;
- a deterministic auction allocates `observe`, `probe`, `canary`, or `live` capital from those objects.

Pros:

- makes mixed health actionable instead of merely blocked;
- gives every capital decision replayable lineage and freshness proof;
- preserves separation between platform truth and trading economics.

Cons:

- adds additive tables and a stronger compiler;
- requires shadow replay before any capital effect;
- makes stale-data debt much more visible.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile lane-local balance sheets and dataset seats, then allocate capital through a deterministic auction
over those objects instead of letting route-time status responses approximate the same question differently.

## Architecture

### 1. Dataset seats

Add additive tables:

- `dataset_seats`
  - `dataset_seat_id`
  - `consumer_attestation_id`
  - `account`
  - `lane_id`
  - `dataset_snapshot_ref`
  - `clickhouse_freshness_ref`
  - `empirical_bundle_ref`
  - `feature_schema_hash`
  - `seat_class` (`observe`, `probe`, `canary`, `live`)
  - `issued_at`
  - `expires_at`
  - `evidence_refs_json`
- `dataset_seat_inputs`
  - `dataset_seat_id`
  - `source_name`
  - `source_status`
  - `freshness_seconds`
  - `truthfulness`
  - `reason_codes_json`

Rules:

- no live or canary capital is possible without a dataset seat;
- a dataset seat is invalid if empirical lineage, ClickHouse freshness, or explicit quant attestation is missing;
- low-memory ClickHouse freshness fallback can mint only `observe` or `probe` seats until exporter parity is restored.

### 2. Lane balance sheets

Add additive tables:

- `lane_balance_sheets`
  - `lane_balance_sheet_id`
  - `consumer_attestation_id`
  - `dataset_seat_id`
  - `authority_session_id`
  - `account`
  - `hypothesis_id`
  - `lane_id`
  - `capital_stage`
  - `expected_edge_bps`
  - `realized_edge_bps`
  - `feature_staleness_p95_ms`
  - `signal_freshness_seconds`
  - `empirical_job_freshness_seconds`
  - `forecast_status`
  - `market_context_status`
  - `confidence_score`
  - `freshness_bond_notional`
  - `auction_rank`
  - `decision` (`observe`, `probe`, `canary`, `live`, `quarantine`)
  - `issued_at`
  - `expires_at`
- `lane_balance_sheet_reasons`
  - `lane_balance_sheet_id`
  - `reason_code`
  - `severity`
  - `evidence_ref`

Rules:

- every lane balance sheet is per hypothesis and per lane, not account-global;
- the runtime keeps `TradingState` only as a short-term cache and metrics source, not as the authoritative economic
  record;
- `/trading/status` and `/trading/profitability/runtime` must read the same latest balance sheet ids.

### 3. Auction and freshness bonds

Capital allocation becomes deterministic:

- `observe`
  - always allowed if the lane is diagnostically healthy enough to score
- `probe`
  - allowed only with a valid consumer attestation, a dataset seat, and freshness debt below a configured cap
- `canary`
  - allowed only with:
    - explicit quant attestation
    - forecast healthy
    - non-stale empirical bundle
    - no unresolved exporter failure on the bound dataset seat
- `live`
  - allowed only after repeated positive balance sheets and deployer promotion acceptance

Freshness bonds:

- a freshness bond is the maximum probe notional a lane may consume while one upstream surface is degraded;
- the bond decays to zero when empirical freshness or explicit quant attestation expires;
- stale empirical bundles from `2026-03-19T10:31:27Z` and current exporter scrape failure force bonds to remain
  diagnostic-only until refreshed.

### 4. Source cutover expectations

Implementation scope implied by this contract:

- `submission_council.py`
  - remove fallback to the generic control-plane and market-context URLs once explicit quant-health wiring lands
- `scheduler/pipeline.py`
  - stop committing replay opportunity when run-context construction fails on authority debt
  - emit dataset-seat and lane-balance-sheet writes after feature-quality evaluation
- `scheduler/state.py`
  - retain in-memory counters and recent observations only
  - stop acting as the authoritative source of profitability truth
- `empirical_jobs.py`
  - compile dataset-seat inputs from normalized empirical-job lineage
- `main.py`
  - project latest balance-sheet and seat ids through `/trading/status` and `/trading/profitability/runtime`

### 5. Validation and acceptance gates

Engineer acceptance gates:

- unit tests for:
  - dataset-seat compilation from stale versus fresh empirical bundles
  - explicit quant-health URL requirement
  - auction ranking under mixed freshness and forecast states
- replay tests using the March 19, 2026 empirical bundle and March 20, 2026 ClickHouse freshness values
- migration tests proving empty `vnext_dataset_snapshots` and empty `strategy_hypotheses` produce `observe` only

Deployer acceptance gates:

- probe-only rollout first, with capital hard-capped by freshness bonds
- no canary or live capital unless:
  - dataset seat is current
  - empirical bundle is fresh
  - forecast is healthy
  - Jangar promotion attestation is `allow`
- rollback is automatic if the latest balance sheet drops to `quarantine` or the bound seat expires

## Rollout plan

Phase 0. Add tables and shadow writes.

- runtime keeps current gating behavior
- status endpoints expose seat and balance-sheet ids in shadow mode only

Phase 1. Require explicit quant-health wiring.

- manifests must set `TRADING_JANGAR_QUANT_HEALTH_URL`
- tests fail if the runtime falls back to generic control-plane or market-context URLs

Phase 2. Shadow auction.

- runtime computes dataset seats and lane balance sheets
- auction output is logged and surfaced, but capital remains `observe`

Phase 3. Probe capital only.

- capped freshness bonds allow tiny diagnostic capital on the best lanes only
- stale empirical jobs or missing seats clamp the bond to zero

Phase 4. Canary and live cutover.

- canary activates only after repeated positive balance sheets and healthy bound seats
- live scale depends on deployer approval plus durable profitability evidence

## Rollback

If the seat compiler or auction logic is wrong:

1. set all lane balance sheets to `observe`;
2. stop using auction output for any capital effect;
3. preserve dataset seats and balance sheets for replay and audit;
4. continue using the current route-time fail-closed gates until the compiler is repaired.

## Risks and open questions

- Empty research-lineage tables mean the first implementation increment must decide whether live runtime or replay jobs
  mint the first dataset seats. I prefer replay jobs so seats remain empirical-first.
- The exporter failure means low-memory freshness is the only currently credible ClickHouse signal. That is acceptable
  for shadow and probe, not for canary or live.
- Overly aggressive freshness bonds would recreate the current global block in a new form. Overly permissive bonds
  would let bad data masquerade as profitable resilience.

## Handoff to engineer and deployer

Engineer handoff:

- implement dataset-seat and lane-balance-sheet tables, compiler, and endpoint projection
- remove permissive quant-health URL fallback
- add replay and migration tests for empty lineage tables, stale empirical bundles, and low-memory ClickHouse
  freshness

Deployer handoff:

- require bound dataset-seat ids and balance-sheet ids in rollout evidence
- keep probe capital capped until empirical freshness and exporter parity are restored
- treat `quarantine` or expired seats as automatic rollback triggers

The acceptance bar is not "the service stops returning 503." The acceptance bar is that every unit of capital can be
traced to one attestation, one dataset seat, one lane balance sheet, and one replayable evidence story.
