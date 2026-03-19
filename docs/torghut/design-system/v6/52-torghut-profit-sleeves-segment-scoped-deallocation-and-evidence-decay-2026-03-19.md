# 52. Torghut Profit Sleeves, Segment-Scoped Deallocation, and Evidence Decay (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Gideon Park (Torghut Traders Architecture)
Related mission: `codex/swarm-torghut-quant-discover`
Companion docs:

- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`

Extends:

- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`

## Executive summary

Torghut still has two profitability contradictions after the March 19 design pack:

1. capital can appear promotable from one surface while runtime evidence still says the system is in `shadow`; and
2. dependency degradation still arrives as one coarse Jangar decision, which either blocks too much or trusts stale
   evidence for too long.

Read-only evidence captured on `2026-03-19` shows:

- `GET /trading/status` reports `live_submission_gate.allowed=true` and `capital_stage="0.10x canary"` while the same
  payload reports `shadow_first.capital_stage="shadow"`, `promotion_eligible_total=0`, and
  `critical_toggle_parity.status="diverged"`;
- `GET /api/torghut/trading/control-plane/quant/health?account=paper&window=15m` reports
  `status="degraded"`, `latestMetricsCount=0`, and `stages=[]`;
- `GET /api/torghut/trading/control-plane/quant/alerts?account=paper&window=15m` shows open critical
  `metrics_pipeline_lag_seconds` alerts across `1m`, `5m`, `15m`, `1h`, `1d`, `5d`, and `20d`, plus open negative
  `sharpe_annualized` on `5d`;
- `GET /api/torghut/market-context/health?symbol=NVDA` reports `overallState="down"` with stale fundamentals and news,
  plus technicals and regime errors;
- options catalog and enricher pods still crash at import time on `password authentication failed for user
"torghut_app"`;
- historical simulation workflows still fail quickly on
  `simulation_runtime_lock_held:<run_id>:torghut-full-day-20260318-884bec35`.

The selected architecture replaces one-shot promotion thresholds with per-hypothesis **Profit Sleeves**. A sleeve owns
an expiring budget, required dependency segments, evidence windows, overlap caps, and automatic deallocation rules. A
hypothesis no longer promotes merely because one snapshot looks good, and it no longer inherits unrelated dependency
failures.

## Assessment snapshot

### Cluster health and runtime evidence

Read-only evidence captured on `2026-03-19`:

- `kubectl -n torghut get pods -o wide`
  - `torghut-options-catalog` and `torghut-options-enricher` are in `CrashLoopBackOff`
  - `torghut-options-ta` is in `ImagePullBackOff`
  - `torghut-ws-options` is repeatedly restarting
  - core runtime pods remain up, including `torghut-00153`, `torghut-forecast`, and `torghut-lean-runner`
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 40`
  - `torghut-00153` hit startup, readiness, and liveness failures before stabilizing
  - options pods continue in backoff and image-pull failure loops
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
  - `live_submission_gate.allowed=true`
  - `live_submission_gate.capital_stage="0.10x canary"`
  - `shadow_first.capital_stage="shadow"`
  - `critical_toggle_parity.status="diverged"`
  - `orders_submitted_total=0`
  - `orders_rejected_total=54`
  - `market_context.alert_active=true`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m'`
  - `status="degraded"`
  - `latestMetricsCount=0`
  - `stages=[]`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts?account=paper&window=15m'`
  - open critical pipeline-lag alerts across every tracked window
  - open negative-Sharpe alert on `5d`

Interpretation:

- the current gate still allows capital-stage optimism without fresh latest-store evidence;
- pipeline, market-context, options bootstrap, and simulation capacity should not all be collapsed into one generic
  readiness concept;
- profitability decisions need multi-window decay and typed deallocation, not one-shot threshold checks.

### Source architecture and test gaps

Current-branch seams that motivate this design:

- `services/torghut/app/main.py`
  - `_build_live_submission_gate_payload(...)` can still upgrade `shadow` to `0.10x canary` when `allowed=true`;
  - `_build_shadow_first_toggle_parity()` correctly reveals config drift, but the gate does not force a lower capital
    state from that drift alone.
- `services/torghut/app/trading/hypotheses.py`
  - consumes only a coarse `JangarDependencyQuorumStatus`;
  - ties promotion to one shared TCA summary and local TTL-based dependency fetches;
  - cannot express per-hypothesis segment dependencies or evidence expiry.
- `services/torghut/app/trading/autonomy/gates.py` and `services/torghut/app/trading/autonomy/lane.py`
  - implement thresholded gate progressions, but not per-hypothesis budget caps, overlap concentration limits, or
    multi-window automatic demotion.
- `services/jangar/src/server/torghut-quant-runtime.ts` and `services/jangar/src/server/torghut-quant-contract.ts`
  - open and resolve alerts, but do not persist `action_taken`, `capital_delta`, or `next_check_at`.
- `services/torghut/app/options_lane/catalog_service.py` and `.../enricher_service.py`
  - call `OptionsRepository(...).ensure_rate_bucket_defaults(...)` at module import time, so DB auth drift becomes a
    boot crash instead of a typed dependency segment.
- `services/torghut/scripts/start_historical_simulation.py`
  - still serializes many workflows behind one runtime lock, which makes empirical proof capacity too coarse.

Current missing tests:

- no regression proving `critical_toggle_parity="diverged"` keeps all sleeves at `observe` or `shadow`;
- no regression proving stale or unacknowledged Jangar segment evidence fails closed;
- no regression proving one degraded dependency segment deallocates only the hypotheses that require it;
- no regression proving repeated negative windows automatically demote capital stage;
- no regression proving quant alerts produce typed deallocation actions instead of observability-only warnings;
- no regression proving options bootstrap failure blocks only options-dependent sleeves.

### Database and data-quality evidence

Read-only evidence captured on `2026-03-19`:

- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
  - `schema_current=true`
  - current head `0024_simulation_runtime_context`
  - lineage warnings remain for parent forks
- `curl -fsS http://torghut.torghut.svc.cluster.local/metrics | rg 'execution_clean_ratio|alpha_readiness_promotion_eligible_total|market_context_alert_active'`
  - `torghut_trading_execution_clean_ratio 0.0`
  - `torghut_trading_alpha_readiness_promotion_eligible_total 0`
  - `torghut_trading_market_context_alert_active 1`
- `curl -fsS http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics | rg 'freshness_fallback_total'`
  - `ta_signals` fallback total `814`
  - `ta_microbars` fallback total `1676`
- options catalog/enricher logs show `password authentication failed for user "torghut_app"`
- historical simulation logs show `simulation_runtime_lock_held:sim-proof-884bec35-march18-refresh-20260319-080910:torghut-full-day-20260318-884bec35`

Interpretation:

- schema-current alone is not sufficient for profitable autonomy;
- data freshness, latest-store materialization, options bootstrap, and proof capacity must become explicit sleeve
  dependencies;
- the runtime needs an evidence-decay model, because positive evidence ages out while failure evidence accumulates.

## Problem statement

Torghut still lacks a durable answer to four profit-critical questions:

1. How much capital may each hypothesis hold right now?
2. Which dependency segments are required for that hypothesis, and which ones actually degraded?
3. How quickly should stale or negative evidence force deallocation?
4. Which alert breached, what action was taken, and when should the system re-evaluate capital?

Without those answers, capital control remains either too permissive or too coarse.

## Alternatives considered

### Option A: tighten the current threshold gates

Pros:

- smallest code delta
- directly addresses the currently visible contradictions

Cons:

- still uses one-shot thresholds
- still lacks per-hypothesis budget and deallocation objects
- still relies on coarse Jangar dependency truth

Decision: rejected.

### Option B: fail closed globally on any degraded dependency

Pros:

- safest short-term interpretation
- easy for operators to reason about

Cons:

- crushes unrelated profitable hypotheses because one segment is degraded
- does not improve profitability, only suppresses risk
- makes the options lane and collaboration disproportionately expensive failure domains

Decision: rejected.

### Option C: profit sleeves with evidence decay and segment-scoped deallocation

Pros:

- creates measurable, per-hypothesis capital objects
- lets healthy hypotheses continue when unrelated segments fail
- forces automatic downshifts on stale or negative evidence

Cons:

- requires new persistence, status, and alert-enforcement paths
- increases the amount of metadata operators must understand

Decision: selected.

## Decision

Torghut will allocate non-observe capital only through per-hypothesis **Profit Sleeves**.

Each sleeve binds:

- hypothesis id and strategy family
- current stage and max budget
- required Jangar dependency segments
- evidence windows and decay timers
- overlap caps by regime, symbol, and venue
- open alert-driven deallocation actions
- latest simulation-slot and schema-witness compatibility

Promotion becomes gradual, expiry-based, and segment-aware. Deallocation becomes an explicit state transition, not a
human interpretation of alert text.

## Architecture

### 1. Profit sleeve object

Every hypothesis receives a sleeve with these fields:

- `sleeve_id`
- `hypothesis_id`
- `stage` in `{observe, shadow, 0.10x canary, 0.25x canary, 0.50x live, 1.00x live, quarantine}`
- `budget_notional_cap`
- `required_segments[]`
- `optional_segments[]`
- `expires_at`
- `negative_window_streak`
- `last_positive_window_at`
- `open_deallocation_actions[]`
- `overlap_caps`
- `evidence_bundle_ref`

Sleeves are the only source of truth for non-shadow capital.

### 2. Segment-scoped dependency mapping

Each hypothesis manifest must resolve dependency capabilities to concrete Jangar segments.

Initial mapping:

- `H-CONT-01`
  - required: `control_runtime`, `watch_stream`, `signal_continuity`
  - optional: `market_data_context`
- `H-MICRO-01`
  - required: `feature_coverage`, `drift_governance`, `control_runtime`
  - optional: `collaboration_huly`
- `H-REV-01`
  - required: `market_data_context`, `evidence_authority`, `control_runtime`
  - optional: `empirical_jobs`

If `market_data_context` is degraded, only `H-REV-01` is forced to `shadow` or `observe`. Continuation and
microstructure sleeves may remain active if their own requirements are still healthy.

### 3. Evidence decay and automatic deallocation

Positive evidence ages out. Negative evidence accumulates faster.

Required sleeve rules:

- an `allow` dependency payload without fresh `expires_at` or rollout acknowledgement fails closed;
- three consecutive negative `5d` windows or one breached `1d` drawdown rule demote a sleeve by at least one stage;
- unresolved critical quant alerts immediately set `action_taken="deallocate_pending"` and cap the sleeve at `shadow`;
- `critical_toggle_parity="diverged"` forces all sleeves to at most `shadow` until the config mismatch is resolved;
- if latest-store metrics are empty, the sleeve cannot hold more than `observe` or `shadow`, regardless of historical
  positive evidence.

### 4. Quant alerts become capital actions

Extend quant alerts with:

- `action_taken`
- `capital_delta`
- `next_check_at`
- `required_recovery_windows`
- `linked_sleeve_ids[]`

Examples:

- open `metrics_pipeline_lag_seconds` critical alert
  - `action_taken = force_shadow`
  - `capital_delta = -all_non_shadow`
  - `next_check_at = now + 15m`
- open negative `sharpe_annualized` warning for `5d`
  - `action_taken = reduce_one_stage`
  - `required_recovery_windows = 3`

### 5. Overlap and concentration guardrails

Capital is not only per hypothesis. It is also limited by correlation and infrastructure exposure.

Initial sleeve guardrails:

- max one non-shadow sleeve per `(symbol, primary regime)` tuple;
- max `35%` of sleeve budget in one symbol family;
- max `50%` of live capital in hypotheses that depend on the same degraded-but-optional segment;
- options-dependent sleeves cannot exceed `observe` while options bootstrap or options TA segments are degraded.

### 6. Measurable hypothesis contracts

This architecture makes the existing hypotheses operationally measurable.

`H-CONT-01` continuation:

- canary entry requires `signal_lag_seconds <= 90`, no open control-runtime block, and `5d` post-cost expectancy `> 6`
  bps;
- deallocate one stage after `2` consecutive negative `1d` windows or any open critical pipeline-lag alert older than
  `15m`.

`H-MICRO-01` microstructure breakout:

- canary entry requires live feature coverage, drift checks present, and reject rate below the `15m` limit;
- force `shadow` if drift checks are missing for two consecutive windows or if symbol overlap caps are breached.

`H-REV-01` event reversion:

- canary entry requires `market_context_freshness_seconds <= 120`, fresh fundamentals/news or an approved degraded-mode
  override, and positive `5d` expectancy;
- force `observe` when market-context segments are stale, regime resolution errors recur, or alert-driven
  deallocation remains open past `next_check_at`.

## Validation gates

Engineer-stage acceptance:

1. `live_submission_gate` cannot return non-shadow capital while `promotion_eligible_total=0` or
   `critical_toggle_parity="diverged"`.
2. stale or lossy Jangar dependency truth fails closed per sleeve.
3. one degraded segment only deallocates sleeves that declare it as required.
4. negative evidence streaks demote sleeves automatically.
5. quant alerts carry `action_taken`, `capital_delta`, and `next_check_at`.
6. options bootstrap failure keeps only options-dependent sleeves in `observe` or `shadow`.

Suggested regression coverage:

- `services/torghut/tests/test_hypotheses.py`
- `services/torghut/tests/test_trading_scheduler_autonomy.py`
- `services/torghut/tests/test_trading_scheduler_safety.py`
- `services/jangar/src/server/__tests__/torghut-quant-runtime.test.ts`
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`

Deployer-stage acceptance:

1. dashboards expose sleeve stage, expiry, negative-window streak, and open deallocation action;
2. synthetic segment degradation deallocates only the matching sleeves;
3. recovering alerts require the configured recovery windows before capital is restored;
4. no canary or live sleeve is possible while config parity diverges.

## Rollout plan

1. add sleeve persistence and status payloads behind shadow writes only;
2. extend Jangar dependency payloads so Torghut can consume segments, expiry, and rollout acknowledgement;
3. wire quant alerts to emit typed deallocation actions before enforcing capital changes;
4. enable sleeve-based enforcement first for `observe/shadow` vs `0.10x canary`;
5. then enable automatic multi-stage demotion and overlap caps.

## Rollback plan

- disable sleeve enforcement while leaving sleeve rows and alert actions available for postmortem analysis;
- fall back to the current threshold-based gate only if sleeve logic causes false deallocations or excessive churn;
- keep segment-rich dependency payloads even if sleeve enforcement is rolled back, because they are diagnostic value
  on their own.

## Risks and tradeoffs

- evidence-decay rules must be calibrated carefully or they will churn capital too aggressively;
- overlap caps can reduce utilization before the system has enough independent hypotheses;
- typed deallocation actions require precise operator dashboards so intervention remains understandable;
- options and simulation segments must remain scoped, or they will become accidental global blockers again.

## Engineer and deployer handoff

Engineer contract:

- preserve backward compatibility long enough for dashboards and APIs to consume sleeve fields;
- add regression coverage for stale-dependency fail-closed logic and automatic demotion;
- do not treat alert strings as sufficient; emit typed capital actions.

Deployer contract:

- canary only after dashboards show fresh dependency provenance, fresh quant metrics, and no open forced-shadow
  actions;
- do not override sleeve deallocation without documenting which evidence bundle justified the override;
- if options or simulation infrastructure is degraded, keep unrelated sleeves eligible but keep options-dependent
  sleeves capped at `observe` or `shadow`.
