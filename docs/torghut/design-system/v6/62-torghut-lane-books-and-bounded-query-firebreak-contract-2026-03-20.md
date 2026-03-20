# 62. Torghut Lane Books and Bounded Query Firebreak Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`

Extends:

- `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
- `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
- `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
- `53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`

## Executive summary

The decision is to stop building Torghut's trading authority from one shared route-time gate and instead compile two
durable Torghut objects: **Lane Books** and **Bounded Query Firebreaks**.

The live evidence on `2026-03-20` is explicit:

- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/status`
  - reports `dependency_quorum.decision="unknown"` with `reasons=["jangar_status_fetch_failed"]`;
  - reports `live_submission_gate.blocked_reasons` including `quant_health_fetch_failed`;
  - reports all three hypotheses stuck in `shadow` or `blocked`;
  - still globalizes mixed evidence into one shared gate.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/health`
  - returns HTTP `503`;
  - still reports Postgres, ClickHouse, and Alpaca healthy;
  - still times out on the generic Jangar status path even though the typed Jangar quant route answers.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns `ok=true`, `status="degraded"`;
  - returns `latestMetricsCount=36`, `metricsPipelineLagSeconds=4`;
  - isolates the real bad stage as `ingestion.lagSeconds=98202`.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/empirical-jobs`
  - returns `ready=false`;
  - shows all four empirical jobs as `truthful=true` but stale from `2026-03-19T10:31:27Z`;
  - still clamps the whole trading gate instead of only the affected lanes.
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - exposes `torghut_clickhouse_guardrails_ta_signals_max_event_ts_seconds=nan`;
  - exposes `torghut_clickhouse_guardrails_ta_microbars_max_window_end_seconds=nan`;
  - exposes fallback counters `829` and `1944` for freshness queries.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 60`
  - shows the forecast and forecast-sim pods failing readiness with HTTP `503`.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/db-check`
  - returns `ok=true`, `schema_current=true`;
  - still surfaces migration-parent-fork warnings that need to remain visible in trading decisions.

The tradeoff is more additive state and stricter lane-local budgeting. I am keeping that trade because the next
six-month profitability failure will not come from total blindness. It will come from profitable lanes being globalized
by unrelated evidence debt or from heavy readiness/freshness paths turning mixed evidence into a false outage.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Torghut
  profitability with measurable hypotheses, guardrails, rollout gates, and rollback expectations

This document succeeds when:

1. every lane can cite one `lane_book_id`, one `profit_repair_exchange_id`, one Jangar `consumer_projection_id`, and
   zero or more `firebreak_id`s instead of one shared route-time gate;
2. the generic Jangar status fallback is removed from quant-health authority once shadow parity proves the typed
   consumer projection is stable;
3. forecast, ClickHouse freshness, market-context, and empirical-job degradation can clip only the lanes that declare
   those dependencies;
4. the new contract defines measurable profitability hypotheses and hard caps for degraded-mode probe capital.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is in a mixed-evidence state, not a total platform outage.

- `/trading/status`
  - returns HTTP `200`;
  - shows `control_plane_contract.alpha_readiness_hypotheses_total=3`;
  - shows one lane blocked and two in shadow;
  - still collapses the final trading answer into one shared gate.
- `/trading/health`
  - proves the core dependencies are reachable;
  - still returns degraded because empirical jobs and quant evidence are not ready.
- `/trading/empirical-jobs`
  - proves the empirical system has artifact-backed results;
  - also proves the staleness policy is currently portfolio-wide instead of lane-aware.
- forecast pods returning HTTP `503`
  - prove the forecast surface is a real dependency concern;
  - do not justify blocking continuation-style lanes that do not require forecast evidence.

Interpretation:

- Torghut has enough signal to make better lane-local decisions than it currently does;
- the problem is the authority shape, not absolute absence of evidence;
- the route-time gate is now the profitability bottleneck.

### Source architecture and test-gap evidence

The hottest source hotspots are still route-time composition and global fallback behavior.

- `services/torghut/app/trading/submission_council.py`
  - still falls back from the typed quant-health URL to the generic Jangar status URL;
  - still settles one shared live-submission gate from mixed mutable inputs.
- `services/torghut/app/trading/hypotheses.py`
  - still reduces Jangar truth to coarse dependency-quorum answers too early;
  - still loses too much lane-local capability detail.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still caches and reuses one live-submission gate payload rather than a lane book id per lane;
  - still has no durable firebreak state for expensive or invalid evidence paths.
- `services/torghut/app/main.py`
  - still projects `/readyz`, `/trading/status`, and `/trading/health` from partially overlapping request-time logic;
  - does not yet expose one durable lane-book id across those surfaces.
- `argocd/applications/torghut/knative-service.yaml`
  - still keeps startup and readiness anchored to `/healthz`;
  - still wires the generic Jangar control-plane status URL into runtime config.

Architectural test gaps:

- no regression proves the typed Jangar projection becomes mandatory once shadow parity is enabled;
- no parity test proves `/readyz`, `/trading/status`, and `/trading/health` expose the same lane-book and firebreak ids;
- no regression proves forecast degradation blocks only forecast-dependent lanes;
- no regression proves `nan` ClickHouse freshness gauges or repeated fallback counters open a bounded firebreak instead
  of silently degrading every lane.

### Database, schema, freshness, and consistency evidence

The data stores already expose enough truth to price evidence quality honestly.

- `/db-check`
  - confirms head parity and lineage readiness;
  - keeps migration-parent-fork warnings visible.
- the typed Jangar quant-health route
  - proves compute and materialization are fresh;
  - proves the bad data stage is ingestion lag, not route or DB unavailability.
- ClickHouse guardrail metrics
  - currently emit `nan` freshness gauges and large fallback totals;
  - prove the system needs bounded query policies, not broader scans.

Interpretation:

- Torghut can already see the difference between missing evidence, stale evidence, and expensive evidence;
- it does not yet persist that difference as a lane-level contract.

## Alternatives considered

### Option A: keep the current gate and tighten timeouts/caching

Pros:

- smallest implementation delta;
- may suppress the current status-route timeout symptom quickly.

Cons:

- still globalizes mixed evidence into one portfolio-wide answer;
- still leaves forecast and ClickHouse query pressure as request-time surprises;
- does not produce replayable ids for scheduler/status/readiness parity.

Decision: rejected.

### Option B: move final lane-capital authority into Jangar

Pros:

- one platform-owned authority surface;
- less Torghut-local composition logic.

Cons:

- makes Jangar's failure domain even more expensive;
- couples platform rollout and trading-economics final authority too tightly;
- reduces Torghut option value for lane-specific repair probes and capital experiments.

Decision: rejected.

### Option C: lane books plus bounded query firebreaks

Pros:

- gives every lane one durable profitability and authority record;
- turns heavy or invalid evidence paths into explicit firebreaks;
- preserves strict safety while allowing bounded repair probes on unaffected lanes.

Cons:

- adds new persistence and projection logic;
- requires shadow parity before any capital effect.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile lane books from typed Jangar consumer projections, evidence seats, and profit-repair exchanges,
then use bounded query firebreaks to keep expensive or invalid evidence from turning into portfolio-wide confusion.

## Architecture

### 1. Lane books

Add additive persistence:

- `trading_lane_books`
  - `lane_book_id`
  - `hypothesis_id`
  - `lane_id`
  - `account_label`
  - `jangar_consumer_projection_id`
  - `required_evidence_seat_ids_json`
  - `required_firebreak_ids_json`
  - `profit_repair_exchange_id`
  - `decision` (`observe`, `repair_probe`, `canary`, `live`, `quarantine`)
  - `capital_cap_bps`
  - `loss_cap_bps`
  - `observed_metrics_json`
  - `reason_codes_json`
  - `lane_book_digest`
  - `issued_at`
  - `expires_at`

Rules:

- one lane book is the authority object for scheduler, `/readyz`, `/trading/status`, and `/trading/health`;
- lane books are hypothesis-scoped and account-scoped, not portfolio-global;
- a lane may only enter `repair_probe`, `canary`, or `live` when its mandatory evidence seats are present and its
  required firebreaks are closed.

### 2. Bounded query firebreaks

Add additive persistence:

- `trading_query_firebreaks`
  - `firebreak_id`
  - `lane_id`
  - `surface_kind` (`jangar_quant_projection`, `forecast_registry`, `clickhouse_freshness`, `market_context`, `empirical_jobs`)
  - `source_ref`
  - `state` (`shadow`, `open`, `closed`)
  - `max_latency_ms`
  - `max_source_staleness_seconds`
  - `max_query_window_seconds`
  - `max_scan_rows`
  - `fallback_counter`
  - `last_observed_latency_ms`
  - `reason_codes_json`
  - `observed_at`
  - `expires_at`

Rules:

- `nan` freshness gauges or repeated fallback counters open the `clickhouse_freshness` firebreak;
- forecast `503` or stale registry output opens the `forecast_registry` firebreak;
- firebreaks affect only the lanes that declare the surface as required;
- open firebreaks may allow `observe` or `repair_probe` depending on lane policy, but never `canary` or `live`.

### 3. Jangar projection consumption becomes strict

Implementation consequences:

- `services/torghut/app/trading/submission_council.py`
  - must treat the typed Jangar consumer projection as the only valid quant-health authority once shadow parity is on;
  - may no longer fall back to the generic status route for final trading authority.
- `services/torghut/app/trading/hypotheses.py`
  - must preserve `degradation_scope` and segment detail from typed Jangar projections instead of collapsing too early.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - must persist and reuse lane-book ids rather than one shared gate payload.

### 4. Measurable profitability hypotheses and guardrails

The architecture now defines explicit measurable hypotheses:

1. **False global-block reduction**
   - objective: reduce portfolio-wide `observe` outcomes caused by unrelated lane evidence debt by at least `50%`
     relative to the current shared gate;
   - guardrail: `canary` and `live` remain impossible whenever any mandatory firebreak is open.
2. **Continuation lane repair-probe recovery**
   - lane: `H-CONT-01`;
   - success condition: continuation returns to `repair_probe` within one evaluation window once
     `jangar_quant_projection` is non-blocked and signal-continuity evidence is fresh;
   - guardrail: `capital_cap_bps <= 5`, `loss_cap_bps <= 8`, no forecast dependency may be inferred.
3. **Microstructure lane quarantine discipline**
   - lane: `H-MICRO-01`;
   - success condition: missing feature coverage, drift checks, or open forecast/clickhouse firebreaks force
     `quarantine`;
   - guardrail: zero repair-probe capital while required feature sets are unavailable.
4. **Event-reversion lane market-context discipline**
   - lane: `H-REV-01`;
   - success condition: event-reversion may only leave `observe` when market-context freshness is within contract and
     empirical evidence is within the allowed truthful-age budget;
   - guardrail: any market-context staleness or blocked Jangar projection forces `observe` or `quarantine`.

### 5. Status and rollout contract

The runtime surfaces change as follows:

- `/readyz`
  - exposes current lane-book ids and any open firebreak ids for the active account.
- `/trading/status`
  - exposes lane books, firebreaks, and the shared lane-book digest map;
  - becomes a projection reader, not a final authority compiler.
- `/trading/health`
  - reports the same lane-book/firebreak ids when degraded;
  - may report degraded service health while still proving that some lanes remain safely evaluable in `observe` or
    `repair_probe`.

## Validation, rollout, and rollback

Engineer acceptance gates:

1. Add tests proving the generic Jangar status fallback is removed once projection shadow parity is enabled.
2. Add parity tests proving `/readyz`, `/trading/status`, and `/trading/health` expose the same `lane_book_id`s and
   `firebreak_id`s.
3. Add tests proving forecast failure or ClickHouse `nan` freshness metrics open a firebreak and block only the lanes
   that require those surfaces.
4. Add tests proving lane books survive scheduler restart and still expire correctly when source evidence ages out.

Deployer acceptance gates:

1. Run lane books and firebreaks in shadow mode for at least one full market session.
2. Require `torghut_clickhouse_guardrails_freshness_fallback_total` to stop increasing in steady state before any
   repair-probe capital is enabled.
3. Flip one lane at a time from shared-gate observation to lane-book enforcement.
4. Enable `repair_probe` only after the shadow period proves status/readiness parity and bounded firebreak behavior.

Rollout sequence:

1. Land tables and compiler writes in shadow mode.
2. Surface lane-book ids and firebreak ids on status and readiness without capital effect.
3. Remove generic Jangar status fallback from the quant path.
4. Enforce firebreaks before enabling any repair-probe capital.
5. Enable repair-probe on `H-CONT-01` first, keep the other lanes in `observe`/`quarantine` until their evidence
   contracts are satisfied.

Rollback:

1. disable lane-book enforcement and restore the legacy gate for final capital decisions;
2. keep lane-book and firebreak writes running for audit and replay;
3. close repair-probe capital first, then revert consumer path changes if needed;
4. do not remove firebreak visibility during rollback.

## Risks and open questions

- truthful-but-stale empirical evidence needs a carefully bounded age policy or it becomes optimism in disguise;
- too many lane-local objects can raise operator load unless status surfaces summarize them well;
- forecast readiness and ClickHouse query cost remain real operational debts even after their effect is better scoped.

## Handoff to engineer and deployer

Engineer scope:

- add the lane-book and firebreak tables plus compiler;
- remove generic Jangar status fallback from final quant authority;
- update scheduler/readiness/status routes to project shared ids;
- add the firebreak and lane-local parity regressions listed above.

Deployer scope:

- keep lane books and firebreaks shadow-only until parity is visible on runtime routes;
- treat any disagreement between `/readyz`, `/trading/status`, and `/trading/health` as a hard stop;
- enable repair-probe only lane-by-lane with the documented capital and loss caps;
- rollback enforcement before rolling back visibility.
