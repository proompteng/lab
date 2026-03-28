# 53. Torghut Kafka-Retention Bootstrap and Archive-Backed Profitability Proof (2026-03-27)

## Status

- Date: `2026-03-27`
- Maturity: `implementation contract`
- Scope: `services/torghut/scripts/{start_historical_simulation.py,generate_historical_profitability_manifests.py,analyze_historical_simulation.py}`, `services/torghut/app/trading/{evaluation.py,completion.py,empirical_jobs.py}`, `services/torghut/app/models/entities.py`, `argocd/applications/torghut/**`, and Torghut/Jangar promotion evidence handoff
- Depends on:
  - `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`
  - `docs/torghut/design-system/v1/historical-dataset-simulation.md`
  - `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
  - `docs/torghut/design-system/v6/05-evaluation-benchmark-and-contamination-control-standard.md`
  - `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
  - `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
  - `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
  - `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- Implementation status: `Not started`
- Primary objective: turn retained Kafka topic windows plus existing historical-simulation machinery into a durable internal profitability-proof system that can honestly certify or reject `>= $250` average net P&L per trading day on current capital

## Executive summary

The current Torghut profitability contradiction is not "there is no internal data."

The current contradiction is:

1. high-value recent data still exists in Kafka, but it expires quickly;
2. Torghut already has a bounded historical simulation engine, but not a recurring archive-and-proof control loop;
3. retained simulation databases and one-off runs exist, but the canonical proof registries remain almost empty; and
4. the system therefore cannot yet distinguish "recent replay is possible" from "promotion-grade profitability has been proven."

Observed live state on `2026-03-27`:

- Kafka topic retention:
  - `torghut.trades.v1`: `7d`, `delete`, `3` partitions
  - `torghut.quotes.v1`: `7d`, `delete`, `3` partitions
  - `torghut.bars.1m.v1`: `30d`, `delete`, `3` partitions
  - `torghut.status.v1`: `7d`, `compact,delete`, `3` partitions
  - `torghut.ta.bars.1s.v1`: `14d`, `delete`, `1` partition
  - `torghut.ta.signals.v1`: `14d`, `delete`, `1` partition
  - `torghut.ta.status.v1`: `7d`, `compact,delete`, `1` partition
  - `torghut.trade-updates.v1`: `7d`, `delete`, `3` partitions
- Conservative replay-grade internal surface assessment:
  - `ta_signals`: `697,566` rows where `source='ta'` and `window_size='PT1S'`, `10` trading days, `2026-03-16` through `2026-03-27`, `12` symbols
  - `ta_microbars`: `13` trading days retained
  - `trade_decisions`: `11` retained trading dates
  - `position_snapshots`: `14` retained trading dates
  - `executions`: `2` retained trading dates
  - options ClickHouse tables have no retained proof-grade partitions
- ClickHouse active parts:
  - `ta_microbars`: `13` partitions, `2026-03-11` through `2026-03-27`, `892,974` rows
  - `ta_signals`: `10` partitions, `2026-03-16` through `2026-03-27`, `847,873` rows
- Postgres retained day coverage:
  - `trade_decisions`: `11` trading dates, `2026-03-12` through `2026-03-27`
  - `position_snapshots`: `14` trading dates, `2026-03-11` through `2026-03-27`
  - `executions`: `2` trading dates, `2026-03-14` and `2026-03-27`
  - `execution_order_events`: `0` retained dates
- Canonical proof/control tables:
  - `lean_backtest_runs`: `0`
  - `vnext_empirical_job_runs`: `16` rows
  - `vnext_dataset_snapshots`: `0`
  - `vnext_promotion_decisions`: `0`
  - `simulation_run_progress`: `0`
- Isolated simulation databases already exist: `43` `torghut_sim_*` databases in CNPG, proving prior replay activity happened, but without a canonical registry proving profitability authority.

Conclusion:

- The user is correct that Kafka contains important missing information.
- Kafka retention is enough to bootstrap an internal archive now.
- Kafka retention alone is not enough to support a truthful `>= $250/day` promotion claim.
- The missing system is a **retention-to-archive profitability proof pipeline**.

This document defines that system.

## Relationship to the `>= $250/day` internal-data program

This document preserves the previously defined `Torghut >= $250/Day Internal-Data Profitability Program`.

It does **not** replace that plan with a Kafka-only shortcut.

The preserved commitments remain:

- a daily internal archive pipeline over Torghut-owned surfaces;
- daily inventory contracts:
  - `market_day_inventory.json`
  - `execution_day_inventory.json`
  - `replay_day_manifest.json`
- fail-closed `data_sufficiency` status with `insufficient_history`;
- research-grade and promotion-grade walk-forward proof windows;
- required artifacts:
  - `trial-ledger.json`
  - `statistical-validity-report.json`
  - `profitability-certificate.json`
- v1 proof portfolio scope:
  - long-only
  - US equities
  - intraday
  - three sleeves
- hard historical and paper profitability gates for the `>= $250/day` target;
- capped live rollout only after historical and paper proof succeed.

What changes in this document is narrower:

- Kafka retention becomes the bounded bootstrap source that lets Torghut capture expiring recent history;
- archive bundles remain the durable proof surface;
- ClickHouse/Postgres day surfaces remain part of the archived evidence contract rather than being replaced.

## Non-goals

- claiming that the current Torghut sleeve family is already profitable enough;
- using external market-data vendors or non-repo proof stores;
- treating TA-derived topics as the only authoritative replay source for equities;
- allowing live capital promotion directly from one-off local replays;
- replacing the existing Jangar-issued promotion certificate model.

## Problem statement

Torghut currently lacks an authoritative answer to five profit-critical questions:

1. Which recent trading days are still fully reconstructable from Kafka source topics before retention expires?
2. Which days have enough execution and runtime evidence to count toward profitability proof rather than replay-only diagnosis?
3. Where is the immutable internal replay bundle for each day, and how is its lineage tied to candidate, runtime, and artifact hashes?
4. How does Torghut fail closed when historical depth is insufficient for a `>= $250/day` claim?
5. How does Torghut move from recent-window bootstrap to durable historical OOS proof without inventing a second architecture?

Until those are answered, any profitability target is vulnerable to:

- retention expiry,
- ad hoc day selection,
- repeated tuning on the same short window,
- missing trial accounting,
- paper/live promotion from insufficient history.

## Alternatives considered

### Option A: use current ClickHouse/Postgres surfaces only

Pros:

- smallest implementation delta
- no new archive workflow

Cons:

- current retained depth is too short
- executions and order events are sparse
- current ClickHouse headroom is too low for heavy ad hoc aggregates
- does not recover expiring Kafka source history

Decision: rejected.

### Option B: treat Kafka retention itself as the profitability archive

Pros:

- recent history is real and internal
- source fidelity is strong for replay while retention remains

Cons:

- retention expiry destroys proof depth
- no immutable per-day lineage bundle
- no deterministic artifact bundle for later audit
- cannot support promotion-grade reproducibility

Decision: rejected.

### Option C: Kafka-retention bootstrap plus archive-backed proof

Pros:

- immediately captures recent internal history before it expires
- reuses the existing historical simulation engine and manifest flow
- creates durable per-day replay bundles and proof artifacts
- supports fail-closed sufficiency gates and later promotion authority

Cons:

- requires a new recurring archival control loop
- requires explicit trial-ledger and statistical-validity artifacts
- delays strong profitability claims until enough archived depth exists

Decision: selected.

## Decision

Adopt a two-layer internal-data system:

1. **Kafka retention layer** is the bounded recent-history bootstrap source for equities.
2. **Archive-backed replay bundles** are the durable source of truth for profitability proof, historical OOS validation, and promotion authority.

For the equities lane:

- authoritative full-fidelity replay input comes from source topics `trades`, `quotes`, `bars`, and `status`, matching `EQUITY_SIMULATION_LANE.replay_roles`;
- TA topics remain derived, useful for coverage and bootstrap diagnosis, but not sufficient as the sole long-horizon proof source;
- every retained trading day must be converted before expiry into an immutable replay bundle with deterministic lineage, daily inventory contracts, and proof artifacts.

Promotion authority for `>= $250/day` is blocked unless the archive-backed proof system says otherwise.

## Target profitability contract

The proof target in this document is:

- `profit_target_daily_net_usd = 250`
- measured as average **net** P&L per trading day
- on **current capital**, not on scaled capital
- after modeled execution cost
- validated on historical OOS test folds and then paper trading

This is an aggressive target on the current account base. The architecture therefore assumes:

- multiple sleeves rather than one tuned sleeve,
- rejection and execution defects must be pushed left,
- historical proof must be multiple-testing-aware,
- paper proof must confirm that the historical signal survives operational reality.

## Canonical data-source hierarchy

### 1. Nearline replay source of truth

For the equities lane, the canonical nearline replay source is:

- `torghut.trades.v1`
- `torghut.quotes.v1`
- `torghut.bars.1m.v1`
- `torghut.status.v1`

These match the replay roles already encoded in:

- `services/torghut/scripts/simulation_lane_contracts.py`

Rules:

- `trades` and `quotes` are the hard limit for full-fidelity equity replay and expire at `7d`.
- `bars.1m` has `30d` retention and may support coarse diagnostics, but it is not enough to reconstruct the full equity replay lane once `trades` and `quotes` expire.
- `ta.bars.1s` and `ta.signals` are derived and expire at `14d`; they are useful for bootstrap inspection, coverage checks, and replay verification, but not as the sole long-horizon proof surface.

### 2. Durable proof source of truth

The canonical durable proof source is a per-trading-day archive bundle consisting of:

- bounded Kafka source dump
- ClickHouse day-scope exports or summaries for `ta_signals` and `ta_microbars`
- Postgres day-scope exports or summaries for `trade_decisions`, `executions`, `position_snapshots`, and `execution_order_events`
- existing empirical-job artifacts when present
- replay manifest
- run manifest
- simulation/post-run analysis report
- inventory contracts
- dataset snapshot row
- empirical-job and promotion artifacts that point back to the dataset snapshot

These bundles must be immutable once published.

## Architecture

### 1. Daily archive coordinator

Add a recurring archive coordinator that runs after each trading day and before Kafka source retention expires.

Primary responsibilities:

1. identify the latest completed New York trading day;
2. inspect Kafka source-topic availability and offsets for the target window;
3. snapshot the existing day surfaces from ClickHouse, Postgres, and empirical-job rows;
4. generate or reuse a deterministic historical simulation manifest;
5. run a bounded full-day replay into isolated simulation surfaces;
6. emit inventory contracts and immutable artifacts;
7. register the day as archive-ready, partial, or insufficient;
8. accumulate archive depth until historical proof becomes eligible.

Canonical runtime building blocks to reuse:

- `services/torghut/scripts/generate_historical_profitability_manifests.py`
- `services/torghut/scripts/start_historical_simulation.py`
- `services/torghut/scripts/analyze_historical_simulation.py`
- `docs/torghut/rollouts/historical-simulation-playbook.md`

### 2. Day inventory contracts

Every archived trading day must produce three first-class JSON contracts.

#### `market_day_inventory.json`

Purpose: declare whether a day is replayable from market-data history.

Required fields:

- `schema_version`
- `trading_day`
- `window.start`
- `window.end`
- `lane`
- `source_topics[]`
- `source_topic_retention_ms_by_topic`
- `source_offsets`
- `source_records_by_topic`
- `symbols`
- `clickhouse_coverage`
- `clickhouse_day_exports`
- `replayable_market_day`
- `missing_topics[]`
- `missing_partitions[]`
- `missing_symbols[]`
- `reconstruction_source_provenance`
- `observed_at`

#### `execution_day_inventory.json`

Purpose: declare whether a day has enough runtime/execution evidence to count toward profitability proof.

Required fields:

- `schema_version`
- `trading_day`
- `candidate_scope`
- `trade_decisions_present`
- `executions_present`
- `execution_order_events_present`
- `position_snapshots_present`
- `postgres_day_exports`
- `empirical_artifact_refs`
- `rejections_by_reason`
- `broker_failures_by_reason`
- `execution_day_eligible`
- `missing_execution_surfaces[]`
- `observed_at`

#### `replay_day_manifest.json`

Purpose: bind the immutable replay bundle to the exact lineage used for proof.

Required fields:

- `schema_version`
- `run_id`
- `dataset_id`
- `dataset_snapshot_ref`
- `candidate_id`
- `baseline_candidate_id`
- `trading_day`
- `window`
- `source_dump_ref`
- `source_dump_sha256`
- `run_manifest_ref`
- `analysis_report_ref`
- `simulation_database`
- `runtime_version_refs`
- `model_refs`
- `strategy_spec_ref`
- `artifact_bundle_sha256`
- `archive_status`

### 3. Durable dataset registration

Every archive-ready day must write one `vnext_dataset_snapshots` row.

Canonical contract:

- `run_id`: simulation or archive coordinator run id
- `candidate_id`: optional during raw-day archival, required for proof-window registration
- `dataset_id`: deterministic day bundle id
- `source`: `historical_market_replay`
- `dataset_version`: digest or day-bundle lineage version
- `dataset_from` / `dataset_to`: exact UTC bounds
- `artifact_ref`: immutable bundle root
- `payload_json`: inventory summaries, hashes, and sufficiency metadata

Important rule:

- the existence of simulation databases alone does not count as durable history;
- only days with a persisted dataset snapshot row and immutable artifact ref count toward proof depth.

### 4. Data sufficiency gate

Add a mandatory `data_sufficiency` section to the profitability evidence path.

Minimum required fields:

- `market_days_available`
- `execution_days_available`
- `replay_ready_market_days`
- `proof_eligible_days`
- `symbol_coverage`
- `missing_days`
- `source_provenance`
- `retention_risk_days_remaining`
- `status`
- `blockers[]`

Status enum:

- `insufficient_history`
- `research_only`
- `historical_ready`
- `paper_ready`

Hard rules:

- no profitability certificate above `insufficient_history` unless `>= 20` archived replayable market days exist;
- no promotion-grade historical proof unless `>= 60` archived replayable market days exist;
- no paper promotion claim unless `>= 20` paper/runtime execution days exist;
- any missing lineage, missing archive refs, or mismatched dataset snapshot refs forces `insufficient_history`.

### 5. Profitability proof engine

Extend the current walk-forward/evaluation path into an archive-backed proof engine.

Required properties:

- forward-only daily folds
- one trading-day embargo
- deterministic fold manifests
- full trial ledger for every searched candidate
- deterministic artifact hashes
- explicit after-cost P&L accounting

Phased proof windows:

#### Research-grade bootstrap

- starts once `>= 20` archived replayable market days exist
- purpose: eliminate broken sleeves and confirm harness truthfulness
- output status may be at most `research_only`

#### Promotion-grade historical proof

- starts once `>= 60` archived replayable market days exist
- canonical fold policy: rolling `40/10/10` trading-day train/validation/test with `1` day embargo
- only test folds count toward promotion claims

Required artifacts:

- `trial-ledger.json`
- `statistical-validity-report.json`
- `profitability-certificate.json`
- `walkforward-results.json`

### 6. Statistical-validity contract

The proof engine must stop treating repeated short-window tuning as enough.

Required gates for a candidate to become `historical_proven`:

- OOS average daily net P&L on test folds `>= $250`
- OOS median daily net P&L on test folds `>= $125`
- profitable-day ratio `>= 60%`
- after-cost net P&L positive
- `PBO <= 0.20`
- `DSR > 0`
- Reality Check p-value `< 0.05`
- no incomplete trial ledger

The trial ledger must record all searched candidates, including rejected ones, with:

- `candidate_id`
- `sleeve_id`
- `parameter_hash`
- `search_batch_id`
- `dataset_snapshot_refs`
- `selection_status`
- `selection_reason`
- `metrics_summary`

This contract preserves the original plan rule that the current March history is bootstrap and harness-validation material only.

### 7. Sleeve portfolio design

To pursue the `>= $250/day` target on current capital, v1 proof scope is:

- US equities
- long-only
- intraday only

Initial proof portfolio contains three sleeve families:

- `momentum_pullback_long`
- `breakout_continuation_long`
- `mean_reversion_rebound_long`

Each sleeve must emit:

- `sleeve_id`
- `candidate_id`
- `data_lineage_id`
- `proof_window_id`

The design intentionally excludes shorting in v1 proof because:

- current live rejection history is dominated by short-related failures;
- options retained history is not yet present in proof-grade form;
- long-only proof removes an avoidable failure class while the archive-and-proof system is being built.

### 8. Push-left rejection and execution controls

Profitability proof is invalid if a large share of candidate behavior dies inside broker or runtime defects.

Before any proof claim can count, the runtime must push these causes left:

- no flat-to-short order creation in the v1 proof portfolio;
- enforce qty and price increments before order submission;
- enforce symbol eligibility before order creation;
- enforce participation and exposure caps before order creation;
- classify broker-submit failures into retryable vs structural;
- record structural submission failures in day inventory and trial ledger.

Execution realism requirements:

- arrival-price benchmark
- partial-fill modeling
- modeled latency buckets
- simulated-vs-paper divergence report
- slippage and rejection summaries included in `profitability-certificate.json`

### 9. Profitability certificate states

Define a Torghut-local profitability certificate artifact that feeds, but does not replace, Jangar-issued promotion certificates.

Status enum:

- `insufficient_history`
- `research_only`
- `historical_proven`
- `paper_proven`
- `live_capped`
- `live_full`

Mandatory fields:

- `status`
- `candidate_id`
- `sleeve_ids`
- `profit_target_daily_net_usd`
- `data_sufficiency`
- `proof_window`
- `trial_count`
- `promotion_blockers`
- `historical_metrics`
- `paper_metrics`
- `execution_realism_summary`
- `dataset_snapshot_refs`
- `artifact_refs`
- `generated_at`

Rules:

- `historical_proven` requires the historical proof gate to pass.
- `paper_proven` requires the historical proof gate and paper gate to pass on the same lineage.
- `live_capped` and `live_full` remain subordinate to the March 19 certificate/firebreak architecture and require fresh Jangar-issued promotion certificates.

### 10. Paper and live rollout gates

Historical proof alone is not enough.

Paper gate:

- `20` consecutive trading days
- average daily net P&L `>= $250`
- median daily net P&L `>= $150`
- at least `12` profitable days
- no more than `3` consecutive losing days
- max paper drawdown `<= $1,500`
- rejection rate `< 2%`
- average absolute slippage `<= 20 bps`
- p95 absolute slippage `<= 35 bps`

Live rollout:

1. `live_capped` at `25%` target notional for `5` trading days
2. `live_capped` at `50%` target notional for `10` trading days
3. `live_full` only if live-vs-paper drift, drawdown, and slippage remain within policy

Fail-closed rule:

- any certificate read failure, dataset lineage mismatch, or segment-health blocker forces `observe`

## Implementation boundary

### Reuse and extend

These surfaces remain canonical and must be extended rather than bypassed:

- `services/torghut/scripts/start_historical_simulation.py`
- `services/torghut/scripts/generate_historical_profitability_manifests.py`
- `services/torghut/scripts/analyze_historical_simulation.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/torghut/app/trading/completion.py`
- `services/torghut/app/models/entities.py`

### Add

Add the following first-class scripts:

- `services/torghut/scripts/archive_recent_kafka_trading_days.py`
  - daily archive coordinator
  - generates day inventory contracts
  - writes dataset snapshot rows
- `services/torghut/scripts/run_archive_backed_profitability_proof.py`
  - deterministic walk-forward runner
  - emits trial ledger, statistical validity, and profitability certificate artifacts
- `services/torghut/scripts/summarize_profitability_archive_state.py`
  - operator-readable archive sufficiency summary

### Persistence changes

Do not invent a parallel proof registry unless the existing surfaces are insufficient.

Default design:

- `vnext_dataset_snapshots` becomes the durable day-bundle registry
- `vnext_empirical_job_runs` remains the authoritative empirical artifact registry
- `vnext_promotion_decisions` stores profitability proof decisions and their artifact refs
- new artifact families live in object storage and are referenced by the rows above

The archive bundle for each day must therefore contain both:

- source replay lineage from Kafka, and
- retained Torghut day surfaces from ClickHouse/Postgres/empirical rows

so that the original internal-data archive plan remains intact.

If a new table is later required, it must exist only to normalize day inventory summaries or trial-ledger metadata that cannot be stored sanely in `payload_json`.

## Rollout sequence

### Phase 0: bootstrap from current retained history

- use the existing Kafka retention window immediately
- archive the existing ClickHouse/Postgres/empirical day surfaces for the same windows
- archive every replayable day still recoverable from retained source topics
- use current March history for harness verification and research-only elimination
- do not issue profitability claims above `research_only`

### Phase 1: recurring archive loop

- run daily after each completed trading day
- create immutable day bundles before source retention expires
- keep day inventory and dataset snapshot registry current

### Phase 2: archive-backed research proof

- begin once `>= 20` replayable archived days exist
- eliminate broken sleeves and rejected execution paths
- produce research-only profitability certificates

### Phase 3: promotion-grade historical proof

- begin once `>= 60` replayable archived days exist
- run the `40/10/10` embargoed walk-forward program
- promote only candidates that pass historical gates

### Phase 4: paper proof

- run `20` consecutive trading days on the archived-lineage candidate
- require the paper gate to pass

### Phase 5: capped live rollout

- rely on the existing certificate/firebreak architecture
- permit only capped live states until drift remains within policy

## Testing and verification contract

### Unit tests

- data-sufficiency calculation
- trading-day completeness and missing-day detection
- day inventory contract validation
- deterministic bundle hash generation
- fold generation with embargo
- trial-ledger completeness
- PBO, DSR, and Reality Check calculations
- rejection push-left enforcement

### Integration tests

- archive coordinator can convert a retained Kafka day into a dataset snapshot plus artifact bundle
- replay reproducibility from archived bundle artifacts
- historical proof hard-fails on insufficient history
- historical proof rejects candidates below `$250/day`
- profitability certificate blocks on missing lineage or missing dataset snapshot refs
- paper proof aggregation over `20` days
- Jangar/Torghut certificate handoff preserves fail-closed behavior

### Acceptance scenarios

- current March-only archive depth resolves to `insufficient_history` or `research_only`, never `historical_proven`
- a positive candidate below `$250/day` fails
- a candidate with positive P&L but failed statistical validity fails
- a candidate with historical proof but failed paper proof does not promote
- live rollout halts automatically when drift, drawdown, or slippage breaches

## Operator guidance

Use this document when the question is:

- "Can Kafka still save enough recent history to build a real proof program?"
- "What counts as internal replayable history?"
- "When is Torghut allowed to claim `>= $250/day`?"
- "What must exist before Jangar can issue a non-observe promotion certificate?"

Do not use this document to justify:

- one-off manual replay success as promotion proof;
- configuration-only profitability tuning on a single recent week;
- promotion from ClickHouse/Postgres fragments without archived lineage bundles.

## Assumptions and defaults

- triple-digit profitability means `>= $250` average **net** P&L per trading day;
- no new external vendor or data source is introduced;
- internal historical proof is blocked today by retention-to-archive depth, not by a missing scoring formula;
- the first milestone is not "claim profitability";
- the first milestone is "build internal archival and proof machinery so profitability can be proven honestly."

## References

- `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`
- `docs/torghut/design-system/v1/historical-dataset-simulation.md`
- `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
- `docs/torghut/rollouts/historical-simulation-playbook.md`
- `services/torghut/scripts/simulation_lane_contracts.py`
- `services/torghut/scripts/generate_historical_profitability_manifests.py`
- `services/torghut/scripts/start_historical_simulation.py`
- `services/torghut/scripts/analyze_historical_simulation.py`
- `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
