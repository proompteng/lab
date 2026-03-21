# 63. Torghut Opportunity Books and Evidence-Drift Warrants Contract (2026-03-21)

Status: Approved for implementation (`discover`)
Date: `2026-03-21`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/64-jangar-recovery-warrants-and-rollout-cohorts-contract-2026-03-21.md`

Extends:

- `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
- `61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
- `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
- `60-torghut-hypothesis-passports-and-profit-guardrail-admission-contract-2026-03-20.md`

## Executive summary

The decision is to keep final profitability authority inside Torghut, but stop expressing it as one portfolio-wide
route-time gate. Torghut will instead compile **Opportunity Books** and **Evidence-Drift Warrants** bound to typed
Jangar recovery warrants.

The live evidence on `2026-03-21` makes this the higher-leverage direction:

- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/status`
  - at `2026-03-21T00:15Z` reports `blocked_reasons=["alpha_readiness_not_promotion_eligible","empirical_jobs_not_ready","dependency_quorum_block","quant_health_fetch_failed","live_promotion_disabled"]`;
  - still reports all three hypotheses held in `shadow` or `blocked`;
  - still points `quant_evidence.source_url` at the generic Jangar status route.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/health`
  - at `2026-03-21T00:15:42Z` still returns HTTP `503`;
  - still reports Postgres, ClickHouse, and Alpaca healthy;
  - proves the current block is mixed evidence, not total runtime failure.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - at `2026-03-21T00:15:25Z` reports `latestMetricsCount=36`, `metricsPipelineLagSeconds=2`;
  - also reports `ingestion.lagSeconds=100886` while compute and materialization remain fresh.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/empirical-jobs`
  - at `2026-03-21T00:12:23Z` reports four truthful but stale empirical jobs created at `2026-03-19T10:31:27Z`.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/db-check`
  - at `2026-03-21T00:12:33Z` reports schema head `0025_widen_lean_shadow_parity_status` current;
  - still reports migration parent-fork lineage warnings.
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - currently emits low-memory and fallback counters for `ta_signals` and `ta_microbars`;
  - does not currently emit sampled freshness values for the max-event gauges on this scrape.
- `kubectl -n torghut get pod torghut-forecast-7ff6d8658b-d2vg4 torghut-forecast-sim-789c5f7844-rtj4s -o json`
  - at `2026-03-21T00:15Z` still shows both forecast pods `Running` but `Ready=False`.

The tradeoff is more additive state, sharper lane-local budgets, and stricter parity checks between source and live
authority. I am keeping that trade because the next profitability miss will come from globalizing mixed evidence, not
from lack of any evidence at all.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Torghut
  profitability with measurable hypotheses, guardrails, rollout gates, and rollback expectations

This artifact succeeds when:

1. each hypothesis and regime window can cite one `opportunity_book_id`, zero or more `evidence_drift_warrant_id`s,
   and one Jangar `recovery_warrant_id`;
2. Torghut no longer needs one portfolio-wide `observe` answer when only one evidence surface is stale;
3. the typed Jangar quant route becomes mandatory and any live fallback to the generic status route is treated as
   drift, not as acceptable authority;
4. degraded-mode repair probes stay explicitly budgeted, measurable, and reversible.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is in a mixed-evidence regime, not a true runtime outage.

- `/trading/status`
  - returns HTTP `200`;
  - proves the service can still compile profitability state;
  - still collapses final capital authority into one shared gate.
- `/trading/health`
  - returns degraded even while core dependencies are healthy;
  - proves the block comes from stale empirical jobs and broken quant-authority sourcing.
- forecast pods
  - remain unready;
  - should block only forecast-dependent opportunities, not the entire portfolio.
- Jangar control-plane status
  - is now healthy for controller rollout but still degraded for stale swarm authority;
  - proves Torghut needs typed recovery inputs instead of one generic dependency summary.

Interpretation:

- the system already distinguishes fresh versus stale evidence internally;
- the profitability contract still prices those differences too coarsely;
- Torghut should turn that internal distinction into durable regime- and lane-level capital decisions.

### Source architecture and high-risk modules

The highest-risk source hotspots still concentrate profitability truth too early.

- `services/torghut/app/trading/submission_council.py`
  - still settles one shared `live_submission_gate` after mixing quant, empirical, toggle, and hypothesis evidence;
  - cannot expose one regime-scoped opportunity id across status and runtime surfaces.
- `services/torghut/app/trading/hypotheses.py`
  - already knows lane-specific reasons such as `signal_lag_exceeded`, `drift_checks_missing`, and
    `required_feature_set_unavailable`;
  - still hands those reasons into a portfolio-level gate rather than a regime-scoped book.
- `services/torghut/app/main.py`
  - still projects `/readyz`, `/trading/status`, `/trading/health`, and `/db-check` independently;
  - does not surface a shared opportunity-book or drift-warrant id.
- `services/torghut/app/trading/empirical_jobs.py`
  - already distinguishes truthful versus stale jobs;
  - still reports them as one blocking portfolio input instead of a bounded evidence-drift warrant.
- `argocd/applications/torghut/knative-service.yaml`
  - declares `TRADING_JANGAR_QUANT_HEALTH_URL` as the typed quant route;
  - live runtime still reports generic status-route sourcing, so source and runtime authority are diverging.

Architectural test gaps:

- no parity test proves live `/trading/status` and `/trading/health` surface the same typed quant-authority source the
  manifests and tests require;
- no regression proves forecast degradation or stale empirical jobs open only lane-local drift warrants;
- no regression proves opportunity-book ids remain stable across `/readyz`, status, and trading runtime paths for the
  same evaluation window.

### Database, schema, freshness, and consistency evidence

The database layer is healthy enough to support a richer profitability contract, but the freshness story is uneven.

- `/db-check`
  - proves schema head parity and lineage readiness;
  - still surfaces migration parent-fork warnings that should remain first-class evidence.
- typed Jangar quant health
  - proves the quant stack is not uniformly stale;
  - isolates ingestion lag as the bad stage while compute and materialization stay fresh.
- ClickHouse guardrails exporter
  - currently records repeated low-memory fallback usage;
  - does not currently publish the max-event freshness samples on the scrape I observed.
- empirical jobs
  - prove Torghut has truthful but stale promotion evidence;
  - that should block specific actions, not flatten every lane to the same answer.

Interpretation:

- Torghut can already see evidence drift, source drift, and schema drift;
- it does not yet compile those drifts into durable, budgeted trading decisions.

## Problem statement

Torghut still has six profitability-critical gaps:

1. one shared `live_submission_gate` still converts mixed evidence into one portfolio answer;
2. live runtime can drift away from the typed authority path that source control expects;
3. stale but truthful empirical evidence cannot currently be priced as a bounded repair input;
4. forecast degradation still lacks a first-class lane-local capital response;
5. schema lineage warnings remain visible but not economically actionable;
6. the runtime does not yet carry a replayable object that explains why one lane may still learn while another must
   stay blocked.

That is the wrong shape for the next six months. Torghut needs to preserve safety while buying option value from
unaffected lanes and bounded repair probes.

## Alternatives considered

### Option A: move final profitability authority into Jangar

Pros:

- one operator-owned authority plane;
- less Torghut-local compiler logic.

Cons:

- makes Torghut profitability depend directly on the same stale-freeze failure domain Jangar is repairing;
- reduces lane-local experimentation;
- makes a platform misprojection more expensive.

Decision: rejected.

### Option B: hard-fail closed until every evidence surface is green

Pros:

- simplest safety story;
- smallest architectural delta.

Cons:

- throws away profitable learning on unaffected lanes;
- prevents bounded repair probes exactly when they are most valuable;
- still does not solve source-versus-runtime authority drift.

Decision: rejected.

### Option C: opportunity books plus evidence-drift warrants

Pros:

- keeps final trading economics local to Torghut;
- converts mixed evidence into lane-local budgets instead of portfolio-wide paralysis;
- makes authority drift and freshness drift explicit and testable.

Cons:

- adds new additive tables and compilers;
- requires shadow parity before any capital effect.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile regime-scoped opportunity books from hypothesis state, typed Jangar recovery warrants, and
evidence-drift warrants. Final capital decisions will be lane-local and budgeted instead of portfolio-global and
opaque.

## Architecture

### 1. Opportunity books

Add additive persistence:

- `trading_opportunity_books`
  - `opportunity_book_id`
  - `hypothesis_id`
  - `lane_id`
  - `account_label`
  - `regime_key`
  - `session_key`
  - `jangar_recovery_warrant_id`
  - `lane_book_id`
  - `decision` (`observe`, `repair_probe`, `canary`, `live`, `quarantine`)
  - `capital_cap_bps`
  - `max_notional_usd`
  - `max_order_count`
  - `max_holding_minutes`
  - `expected_edge_bps`
  - `observed_edge_bps`
  - `slippage_budget_bps`
  - `reason_codes_json`
  - `book_digest`
  - `issued_at`
  - `expires_at`

Rules:

- an opportunity book is the final profitability authority object for one hypothesis, one regime, one session window,
  and one account;
- `/readyz`, `/trading/status`, and trading runtime decisions must all surface the same `opportunity_book_id` for the
  active window;
- a book may only enter `repair_probe`, `canary`, or `live` when the referenced Jangar recovery warrant is fresh.

### 2. Evidence-drift warrants

Add additive persistence:

- `trading_evidence_drift_warrants`
  - `evidence_drift_warrant_id`
  - `surface_kind` (`quant_projection_source`, `quant_ingestion`, `forecast`, `empirical_jobs`, `schema_lineage`,
    `clickhouse_freshness`, `market_context`)
  - `lane_scope_json`
  - `source_ref`
  - `source_url`
  - `state` (`shadow`, `open`, `closed`)
  - `max_staleness_seconds`
  - `observed_staleness_seconds`
  - `allowed_actions_json`
  - `blocked_actions_json`
  - `reason_codes_json`
  - `recovery_warrant_id`
  - `observed_at`
  - `expires_at`

Rules:

- any live `quant_evidence.source_url` that is not the typed quant-health route opens a `quant_projection_source`
  drift warrant immediately;
- truthful but stale empirical jobs open an `empirical_jobs` warrant that may still allow `repair_probe` on explicitly
  eligible lanes, but not `canary` or `live`;
- missing ClickHouse freshness samples or repeated low-memory fallback usage open a `clickhouse_freshness` warrant
  scoped only to lanes that require that surface.

### 3. Measurable hypotheses and guardrails

The current hypothesis registry already gives Torghut concrete guardrails. The new contract makes them economically
active:

- `H-CONT-01` continuation
  - may enter `repair_probe` only when typed quant compute/materialization remain fresh, the Jangar recovery warrant is
    healthy, and signal continuity remains within the existing continuation thresholds;
  - repair budget: `capital_cap_bps <= 5`, `max_order_count <= 3`, `max_holding_minutes <= 20`;
  - canary gate stays `min_sample_count_for_live_canary >= 40`, `post-cost expectancy >= 6bps`,
    `avg_abs_slippage_bps <= 12`.
- `H-MICRO-01` microstructure breakout
  - remains blocked whenever feature coverage, drift checks, or forecast evidence are degraded;
  - no repair-probe exception, because missing microstructure evidence destroys the edge thesis itself.
- `H-REV-01` event reversion
  - may remain in `shadow` but may not enter `repair_probe` when market-context freshness or empirical jobs are beyond
    the lane threshold;
  - canary gate stays `min_sample_count_for_live_canary >= 30`, `post-cost expectancy >= 8bps`.

### 4. Surface behavior

- `/trading/status`
  - becomes the main read path for `opportunity_book_id`, active drift warrants, and budget state;
  - no longer synthesizes one portfolio-wide answer without exposing the active books.
- `/trading/health`
  - remains conservative;
  - may still return degraded while one or more opportunity books stay in bounded `repair_probe`.
- `/readyz`
  - reports runtime readiness plus the active book digest for the current evaluation window;
  - must not hide source-drift or schema-lineage drift.
- empirical jobs and forecast status
  - become warrant sources, not final capital authorities by themselves.

## Validation gates

Engineer stage acceptance gates:

1. Add regression coverage proving the typed Jangar quant route is mandatory once opportunity-book shadow parity is
   enabled.
2. Add lane-local regressions proving forecast degradation blocks only forecast-dependent opportunities.
3. Add parity tests proving `/readyz`, `/trading/status`, and runtime decision code surface the same
   `opportunity_book_id` and active drift warrants for the same window.

Deployer stage acceptance gates:

1. `curl -sS 'http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/status'`
   must show typed quant authority, active opportunity-book ids, and explicit drift warrants.
2. `curl -sS 'http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/health'`
   may remain degraded, but only if the returned drift warrants explain the degradation and the allowed actions remain
   bounded.
3. `curl -sS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?...'`
   must agree with the recovery warrant cited by the active opportunity books.

## Rollout plan

1. Add the new tables and compilers in shadow mode only.
2. Emit opportunity-book ids and drift warrants on status surfaces while the current shared gate still controls live
   behavior.
3. Enable bounded `repair_probe` only for explicitly eligible continuation-style lanes after one full weekday of shadow
   parity.
4. Keep `canary` and `live` gated behind typed quant authority, fresh recovery warrants, and current empirical jobs.

## Rollback plan

If rollout regresses:

1. disable opportunity-book enforcement and keep the current shared gate as final authority;
2. retain the additive book and warrant records for auditability;
3. disable repair probes first, then fall back to `observe` while drift warrants continue to emit diagnostics.

## Risks and open questions

- over-eager repair probes could still waste budget if signal continuity thresholds are too loose;
- source-versus-runtime authority drift needs its own alerting, or operators will miss it until status surfaces look
  inconsistent again;
- the opportunity-book compiler must stay cheap enough that it does not recreate the same route-time bottleneck it is
  meant to replace.

## Handoff contract

Engineer handoff:

- implement the additive book and warrant tables and wire them into status, readiness, and trading runtime paths;
- add typed-authority parity tests and lane-local drift tests;
- keep the current shared gate in shadow until parity is proven.

Deployer handoff:

- verify active opportunity-book ids and drift-warrant ids on live status surfaces before promotion;
- refuse promotion if quant authority still points at the generic Jangar status route;
- allow bounded repair probes only after shadow parity proves the same lane decision across status and runtime.
