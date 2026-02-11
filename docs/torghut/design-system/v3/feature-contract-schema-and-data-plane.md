# Feature Contract, Schema Evolution, and Data Plane

## Objective
Create a canonical feature contract that guarantees online/offline parity, safe schema evolution, and measurable data
quality for strategy plugins.

## Current Data Opportunity
Torghut already ingests rich TA payloads from Dorvud/Flink into ClickHouse, but current feature extraction in
`services/torghut/app/trading/features.py` consumes a narrow subset.

## Canonical `FeatureVectorV3` Contract

### Identity and ordering fields
- `event_ts`
- `symbol`
- `timeframe`
- `seq`
- `source`
- `feature_schema_version`

### Price and trend fields
- `price`
- `ema12`
- `ema26`
- `macd`
- `macd_signal`
- `macd_hist`
- `vwap_session`
- `vwap_w5m`

### Oscillator and volatility fields
- `rsi14`
- `boll_mid`
- `boll_upper`
- `boll_lower`
- `vol_realized_w60s`

### Microstructure and quality fields
- `imbalance_spread`
- `spread`
- `signal_quality_flag`
- `staleness_ms`

## Mapping Boundaries in Code
- Raw ingest and cursor ordering: `services/torghut/app/trading/ingest.py`
- Feature extraction boundary: `services/torghut/app/trading/features.py`
- Source schema baseline: `docs/torghut/schemas/ta-signals.avsc`

## Schema Evolution Policy
- minor version: additive fields only.
- major version: breaking rename/removal with migration plan.
- every strategy declares minimum compatible schema version.
- mixed-version operation allowed during rollout via dual-write/dual-read window.

## Data Quality Gates (Runtime)
Per ingest batch enforce:
- monotonic progression by `(event_ts, symbol, seq)`.
- null-rate threshold for required fields (`<1%` target, configurable hard-stop).
- staleness ceiling (hard reject when stale beyond configured budget).
- duplicate event ratio threshold.

If any hard threshold fails:
- reject batch,
- mark cycle degraded,
- emit alert and skip strategy evaluation.

## Online/Offline Parity Controls
Nightly parity process:
- sample online events,
- rebuild features offline using the same canonical mapper,
- compare hashes and numeric drift,
- fail report on drift beyond tolerance.

Required artifacts:
- parity report JSON,
- top-drift field table,
- failing symbol/time windows.

## Storage and Retention Constraints
Observed retention notes:
- signals TTL currently constrains replay horizon.
- microbars TTL differs from signals.

Design requirement:
- define minimum retention window for research/promotion evidence,
- block promotion if required replay horizon unavailable.

## Observability
Metrics:
- `feature_batch_rows_total`
- `feature_null_rate{field}`
- `feature_staleness_ms_p95`
- `feature_duplicate_ratio`
- `feature_schema_mismatch_total`
- `feature_parity_drift_total`

SLOs:
- required field null-rate < 1% daily.
- p95 staleness within configured budget.
- parity drift incidents = 0 for promoted strategies.

## Migration Plan
Phase 1:
- introduce `FeatureVectorV3` model and mapper tests.

Phase 2:
- run dual extraction (`legacy` + `v3`) in shadow.

Phase 3:
- switch strategy runtime to `v3` schema.

Phase 4:
- deprecate legacy extractor and remove dead mapping logic.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-feature-contract-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `taSchemaPath`
  - `outputPath`
- Expected execution:
  - implement canonical feature model and mapper,
  - add ingest/data quality gates,
  - add parity job and reports,
  - wire alerts.
- Expected artifacts:
  - updated `features.py` and related modules,
  - parity job script,
  - tests for schema/mapping quality gates.
- Exit criteria:
  - parity checks pass for sampled windows,
  - schema mismatch fails closed,
  - strategies consume only declared features.
