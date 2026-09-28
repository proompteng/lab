# 39. Freshness Ledger and Hypothesis Proof Mesh for Torghut Quant (2026-03-14)

## Status

- Date: `2026-03-14`
- Maturity: `architecture decision + implementation contract`
- Scope: `services/jangar/src/server/{control-plane-status.ts,torghut-quant-metrics.ts,torghut-quant-runtime.ts,torghut-market-context.ts}`, `services/torghut/app/{main.py,trading/hypotheses.py,trading/autonomy/**}`, `services/torghut/scripts/run_empirical_promotion_jobs.py`, `argocd/applications/{jangar,torghut}/**`, and operator-facing quant health/readiness surfaces
- Depends on:
  - `docs/torghut/design-system/v6/28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
  - `docs/torghut/design-system/v6/31-proven-autonomous-quant-llm-torghut-trading-system-2026-03-07.md`
  - `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
  - `docs/runbooks/torghut-quant-control-plane.md`
- Primary objective: remove freshness and promotion brittleness from the Jangar control plane and replace aggregate,
  zero-heavy readiness accounting with hypothesis-scoped, evidence-backed proof bundles that can actually support
  profitable promotion decisions

## Why this document exists

The current Torghut runtime is safer than the current Torghut quant control plane.

That is the opposite of what an operator needs. On `2026-03-14`, the live runtime reported:

- `GET http://torghut.torghut.svc.cluster.local/trading/health`
  - `status=ok`
  - scheduler `running=true`
  - dependencies `postgres/clickhouse/alpaca=true`
  - alpha readiness `promotion_eligible_total=0`
  - dependency quorum `decision=delay`
  - dependency reason `watch_reliability_degraded`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health`
  - `status=degraded`
  - `latestMetricsCount=504`
  - `metricsPipelineLagSeconds=1`
  - short-window ingestion lag `56416` seconds
  - long-window ingestion lag `1728000` seconds
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - all required job families were `missing`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=SPY`
  - providers were healthy
  - all domains were still `missing`
  - overall state was `degraded`
- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - schema was current
  - lineage remained within tolerance
  - parent-fork warnings were still present

The live logs and cluster state made the control-plane bottleneck explicit:

- `kubectl -n jangar logs jangar-564dd876bf-bzc8m -c app --tail=120`
  repeatedly reported `Latest ta_signals freshness query failed ... MEMORY_LIMIT_EXCEEDED` for both the metadata path
  and the exact `max(event_ts)` fallback.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  showed one replica returning `nan` freshness gauges and cumulative fallback counters of `769` and `1121`.
- `kubectl -n torghut get events --sort-by=.metadata.creationTimestamp | tail -n 40`
  showed fresh Knative/Flink churn and transient `InternalError` / probe failures during rollout.
- `kubectl -n jangar get events --sort-by=.metadata.creationTimestamp | tail -n 30`
  showed `ErrorNoBackup` on `cluster/jangar-db-restore`.

This is not a small tuning issue. The present architecture still discovers freshness by asking stressed systems to prove
their own freshness with expensive reads. That inflates delay signals, produces false cross-lane coupling, and leaves
Torghut with almost no truthful per-hypothesis evidence even when the runtime process itself is healthy.

## Problem statement

The current design has four linked weaknesses.

### 1. Freshness is still query-derived instead of producer-authored

`services/jangar/src/server/torghut-quant-metrics.ts` computes `metricsPipelineLagSeconds` from:

- the latest TA signal timestamp,
- the latest market-context timestamp,
- the latest execution timestamp.

That would be acceptable if those inputs were cheap, bounded, and authoritative. They are not. The current TA freshness
path in `queryLatestTaSignalFreshness(...)` first reads ClickHouse metadata and then falls back to `SELECT max(event_ts)
FROM ta_signals`. When both paths exceed memory, Jangar preserves stale cache instead of authoritative freshness. The
control plane still degrades, but it cannot explain the real component boundary cleanly.

### 2. Dependency quorum over-couples rollout/watch noise to capital readiness

`services/jangar/src/server/control-plane-status.ts` adds `watch_reliability_degraded` as a dependency-quorum delay
reason. `services/torghut/app/trading/hypotheses.py` then turns `delay` into `jangar_dependency_delay`, which forces
rollback-required alpha readiness across all hypotheses even if the underlying runtime dependencies are green.

That is the correct fail-closed posture for now, but it is architecturally too coarse:

- a watch stream can wobble without invalidating the last known good TA/materialization state,
- a single control-plane delay reason blocks every hypothesis equally,
- rollout noise and evidence noise are not separated.

### 3. Hypothesis readiness still depends on aggregate counters that default to zero

`compile_hypothesis_runtime_statuses(...)` currently derives readiness from process-level counters like:

- `feature_batch_rows_total`,
- `drift_detection_checks_total`,
- `evidence_continuity_checks_total`,
- `signal_lag_seconds`,
- `market_context_status.last_freshness_seconds`.

Those counters are valuable, but they are not a proof system. They reset with process state, collapse multiple feature
families into one integer, and give the operator no persisted explanation for which component blocked which hypothesis.

### 4. The profitable promotion path is still missing recurring empirical authority

`/trading/empirical-jobs` was fully missing on `2026-03-14`, so the March 9 empirical-authority contract is still not
producing recurring operator truth. The result is predictable:

- no promotable hypothesis,
- no fresh post-cost evidence windows,
- no truthful distinction between "runtime up" and "strategy ready".

## Non-goals

- weakening Torghut's fail-closed promotion posture
- letting Jangar become the sole authority for live capital
- replacing the March 9 empirical promotion manifest and job-family contract
- treating market-context provider health as equivalent to market-context bundle authority
- making profitability a promise instead of an evidence standard

## Alternatives considered

### Option A. Tune the current polling architecture

Do only the following:

- raise ClickHouse limits,
- reduce Jangar polling cadence,
- add more caches,
- soften `watch_reliability_degraded`.

Benefits:

- fastest patch
- minimal schema work
- little rollout complexity

Why this is rejected:

- it does not remove the control-plane dependency on hot queries,
- it does not create hypothesis-scoped proof artifacts,
- it still leaves provider health and bundle authority conflated,
- it fixes symptoms without creating a durable promotion substrate.

### Option B. Centralize all readiness and promotion authority inside Jangar

Let Jangar own:

- freshness truth,
- hypothesis truth,
- promotion truth,
- empirical truth.

Benefits:

- one operator surface
- simpler dashboards

Why this is rejected:

- it makes Torghut more dependent on an external serving layer for capital authority,
- it weakens the deterministic runtime boundary,
- it increases blast radius when the control plane degrades.

### Option C. Chosen: Producer-authored freshness ledger plus Torghut hypothesis proof mesh

This design keeps deterministic trade authority inside Torghut while moving freshness discovery away from expensive
derived scans.

The split is:

- Jangar owns durable freshness and dependency-quorum serving,
- Torghut owns hypothesis proof bundles and capital readiness,
- empirical job authority remains a Torghut truth source but is scheduled and surfaced through the same ledgered system.

## Decision

Adopt a two-layer contract:

1. a Jangar-owned `torghut.quant-freshness-ledger.v1` that records producer-authored component freshness, health, and
   evidence references without requiring heavy data-plane scans in the hot path;
2. a Torghut-owned `torghut.hypothesis-proof-bundle.v1` that turns alpha readiness from aggregate counters into
   persisted, hypothesis-scoped proof windows.

Promotion remains fail-closed and deterministic, but the evidence model becomes granular enough to support profitable
decisions instead of blanket "all zero" state.

## Architecture

### 1. Freshness ledger

Jangar will store component observations in a dedicated control-plane ledger. The initial table set should be:

- `torghut_quant_component_observations`
- `torghut_quant_component_rollups`

Each observation row must include:

- `component_type`
  - `ta_signals`
  - `ta_microbars`
  - `ws_desired_symbols`
  - `market_context_bundle`
  - `market_context_news`
  - `market_context_fundamentals`
  - `forecast_registry`
  - `lean_authority`
  - `empirical_jobs`
  - `simulation_runtime_ready`
  - `universe_sync`
- `component_key`
  - hypothesis family, strategy family, symbol, or account-scoped key as appropriate
- `observed_at`
- `as_of`
- `freshness_seconds`
- `quality_score`
- `status`
  - `healthy`
  - `degraded`
  - `blocked`
  - `unknown`
- `source`
  - producer identity
  - replica or shard
  - code version
- `reason_codes`
- `evidence_refs`
  - artifact refs, trace ids, or rollup ids

Producer responsibilities:

- TA exporter writes bounded freshness observations instead of forcing Jangar to compute `max(event_ts)` itself.
- Market-context batch writes domain-level bundle observations when the actual bundle lands, not just when providers
  respond.
- Empirical job orchestration writes per-family freshness rows after persistence succeeds.
- Universe/symbol sync writes successful desired-symbol resolution events instead of making watch reliability the only
  proxy.

Consumer responsibilities:

- Jangar dependency quorum reads rollups, not raw hot-path scans.
- `watch_reliability_degraded` remains observable, but it only delays capital when ledger freshness also crosses its
  tolerance or when last-good rollups expire.
- per-replica `nan` freshness becomes a component degradation, not an automatic whole-lane failure, when quorum still
  exists across healthy replicas.

### 2. Hypothesis proof mesh

Torghut will persist one proof bundle per hypothesis per evidence window. The initial table set should be:

- `hypothesis_proof_windows`
- `hypothesis_dependency_snapshots`

Each proof bundle must record:

- `hypothesis_id`
- `window_start`
- `window_end`
- `signal_continuity`
  - lag
  - streak
  - actionable vs expected staleness
- `feature_coverage`
  - required feature sets
  - rows/materializations present
  - source freshness refs
- `market_context_authority`
  - bundle status
  - domain states
  - degraded-last-good eligibility
- `empirical_authority`
  - fresh job families
  - missing families
  - artifact refs
- `execution_quality`
  - route coverage
  - fallback ratio
  - slippage
  - reject ratios
- `profitability_budget`
  - sample count
  - post-cost expectancy
  - max drawdown
- `dependency_quorum_snapshot`
  - exact Jangar decision and reason list used for this bundle

`services/torghut/app/trading/hypotheses.py` should then read the latest proof bundle for each hypothesis instead of
deriving readiness solely from live process counters. The process counters remain useful telemetry, but they stop being
the only promotion truth.

### 3. Market-context authority becomes materialization-aware

The March 14 state showed provider health green while domain health was fully missing. That means the current system can
prove external API reachability without proving internal decision context availability.

The new contract is:

- provider health is operational telemetry only,
- bundle materialization is the authority source,
- domain completeness is stored in both the freshness ledger and the proof bundle,
- degraded-last-good mode is permitted only with explicit TTLs and proof-bundle lineage.

### 4. Empirical authority becomes recurring, not episodic

The March 9 contract remains correct, but it now plugs into the same proof mesh:

- empirical job families write freshness-ledger observations,
- the latest truthful job-family refs are attached to hypothesis proof bundles,
- no hypothesis becomes canary-eligible without fresh required job families,
- recurring prove-and-promote automation is measured by whether those bundles keep refreshing, not by whether a single
  one-off replay once passed.

### 5. Control-plane status becomes evidence-segmented

Jangar control-plane output must separate:

- runtime compute health,
- data freshness health,
- evidence authority health,
- rollout/watch health.

This prevents the present situation where `metricsPipelineLagSeconds=1` and `status=degraded` coexist without telling
the operator whether the real blocker is:

- missing upstream observations,
- stale proof bundles,
- watch-stream noise,
- or a real runtime defect.

## Implementation contract

### Wave 1. Freshness ledger dual-write

Engineer stage must:

- add Jangar tables for observation and rollup storage;
- add producer emitters for TA freshness, market-context bundle completion, empirical-job completion, and universe sync;
- keep existing query-derived freshness in read-only comparison mode;
- add explicit `component_type` / `component_key` indexes;
- ensure migration lineage remains single-head and does not increase branch tolerance requirements beyond the current
  `/db-check` warning baseline.

Acceptance gates:

- Jangar can render dependency quorum from ledger reads without issuing global `max(event_ts)` scans;
- control-plane status includes a comparison field showing legacy vs ledger freshness agreement;
- Jangar logs no longer emit repeated `MEMORY_LIMIT_EXCEEDED` from the quant freshness path during steady state.

### Wave 2. Hypothesis proof mesh dual-write

Engineer stage must:

- add Torghut tables for proof bundles and dependency snapshots;
- write proof bundles every runtime evidence window;
- attach empirical-job refs and market-context bundle refs;
- make `/trading/status` and `/trading/health` expose proof-bundle freshness and lineage.

Acceptance gates:

- alpha readiness reasons are backed by persisted proof bundles;
- `feature_rows_missing`, `market_context_stale`, and `jangar_dependency_delay` are explainable from stored bundle
  fields without log archaeology;
- at least one hypothesis can remain observable even when another hypothesis is blocked by missing feature families.

### Wave 3. Read-path cutover

Engineer and deployer stages must:

- cut Jangar dependency quorum to ledger-first mode behind a feature flag;
- cut Torghut alpha readiness to proof-bundle-first mode behind a feature flag;
- keep legacy counters visible for one full market session as shadow comparison;
- promote only after comparison drift stays within agreed tolerance.

Acceptance gates:

- Jangar quant health no longer degrades from freshness-query memory errors alone;
- Torghut `/trading/health` and Jangar quant health agree on the same blocking surface category;
- empirical jobs refresh on schedule and attach to proof bundles.

## Validation plan

Required automated coverage:

- Jangar tests for ledger-backed dependency quorum:
  - `watch_reliability_degraded` only delays promotion when ledger freshness is stale or absent
  - mixed replica states treat `nan` as degraded component evidence, not automatic total failure
- Jangar tests for bounded freshness sources:
  - no hot-path fallback to full-table `max(event_ts)` scans after cutover
  - cache fallback never masks absent ledger writes beyond configured last-good TTL
- Torghut tests for proof-bundle-backed hypothesis readiness:
  - continuation/reversion/microstructure hypotheses can block for different reasons in the same runtime window
  - missing empirical-job refs block promotion even when live counters are otherwise green
  - degraded-last-good market context expires on schedule
- migration tests:
  - new Jangar and Torghut migrations keep current head signatures valid
  - no new lineage forks beyond the documented tolerated parents

Required live validation:

- `GET /api/torghut/trading/control-plane/quant/health`
  exposes ledger freshness metadata and source provenance
- `GET /trading/status`
  exposes proof-bundle freshness, lineage refs, and per-hypothesis evidence age
- `GET /trading/empirical-jobs`
  remains the canonical job-family view and agrees with proof-bundle refs
- `GET /db-check`
  remains `schema_current=true`

## Rollout plan

1. Deploy Wave 1 with dual-write only. Do not change admission or promotion behavior yet.
2. Observe one full regular US session with:
   - legacy query freshness still enabled,
   - ledger writes enabled,
   - comparison telemetry exported.
3. Enable ledger-first dependency quorum in shadow mode and confirm no additional false delays.
4. Deploy Wave 2 proof-bundle writes with legacy readiness reasons still exported beside bundle-backed reasons.
5. Observe one additional regular US session.
6. Enable proof-bundle-backed alpha readiness for shadow/canary evaluation.
7. Resume recurring empirical prove-and-promote automation only after bundles refresh truthfully.

## Rollback plan

Rollback is configuration-first, not schema-destructive.

Rollback switches:

- disable Jangar ledger-first read path and return to legacy freshness reads;
- disable Torghut proof-bundle-backed readiness and fall back to existing aggregate counters;
- keep dual-written tables intact for forensics;
- pause recurring empirical prove-and-promote scheduling if bundle freshness diverges from job-family truth.

Hard rollback triggers:

- ledger freshness disagrees with legacy freshness on control-plane blocking decisions for more than one market hour;
- proof bundles mark a hypothesis promotable while empirical-job status remains missing or blocked;
- market-context bundle authority reports healthy while domain materialization remains absent;
- migration lineage or backup validation fails before or during rollout.

## Risks

- dual-write drift between producers and serving tables
- excess cardinality if `component_key` is allowed to explode per symbol without retention policy
- over-trusting last-good rollups and hiding genuine outages
- pushing too much promotion logic into Jangar instead of keeping Torghut deterministic
- rollout confusion if legacy and new reason codes are not shown side by side during shadow mode
- Huly/transactor collaboration outages slowing operational communication while implementation continues

## Engineer handoff

Engineer stage is complete only when all of the following are true:

1. Jangar has durable freshness-ledger tables, emitters, and rollups behind feature flags.
2. Torghut has durable hypothesis proof-bundle tables and read/write paths behind feature flags.
3. Jangar quant health exposes ledger provenance and no longer depends on full-table freshness scans in the hot path.
4. Torghut readiness exposes proof-bundle lineage and no longer relies on process-zero counters alone.
5. Tests cover mixed-replica freshness, per-hypothesis blocking divergence, and empirical-job absence.

## Deployer handoff

Deployer stage is complete only when all of the following are true:

1. Wave 1 dual-write has run for at least one regular US session with no new control-plane memory-limit storms.
2. Jangar dependency quorum shadow comparison shows no unexplained divergence from legacy semantics.
3. Torghut proof bundles refresh through at least one regular US session and link to fresh empirical jobs.
4. `/db-check` stays current and migration lineage warnings do not increase.
5. Rollback toggles are documented in GitOps before cutover flags are enabled.

## Final recommendation

The next architecturally correct move is not another patch to polling thresholds.

The next move is to stop discovering truth by re-scanning stressed systems and to start persisting truth at the moment
producers know it.

That gives Jangar a resilient control-plane substrate and gives Torghut the only thing that can honestly support
profitable promotion: hypothesis-scoped, fresh, reconstructable proof.
