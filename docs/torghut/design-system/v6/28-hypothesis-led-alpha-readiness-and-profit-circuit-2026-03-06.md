# 28. Hypothesis-Led Alpha Readiness and Profit Circuit for `torghut` Quant Profitability (2026-03-06)

## Status

- Date: `2026-03-06`
- Maturity: `architecture decision + implementation contract`
- Scope: `torghut` live autonomy, alpha admission, execution quality, and promotion governance
- Owners: `torghut`, `jangar`, `agents`, `observability`
- Primary objective: convert a runtime-healthy but alpha-inert live system into a hypothesis-driven trading system that only scales capital when signal freshness, feature evidence, and post-cost profitability are all proven.

## Executive Summary

The current `torghut` deployment is healthy enough to stay online, but it is not operating as a trustworthy profit engine.

Read-only live evidence from `2026-03-06` shows:

- `/trading/status`: `enabled=true`, `autonomy_enabled=true`, `mode=live`, `running=true`, but `autonomy.runs_total=0`, `signals_total=0`, and `no_signal_streak=8`.
- `/trading/status`: `signal_continuity.alert_reason=cursor_ahead_of_stream`, `signal_lag_seconds~=27038`, `feature_batch_rows_total=0`, `drift_detection_checks_total=0`, `evidence_continuity_checks_total=0`.
- `/trading/status`: `tca.order_count=259`, `avg_abs_slippage_bps~=28.6612`, with the last computation at `2026-03-05T21:15:17Z`.
- Service logs repeatedly report `Signal continuity observed as expected staleness reason=cursor_tail_stable` and `Signal lag threshold exceeded outside market session; suppressing emergency stop`.
- `/db-check`: `ok=true`, `schema_current=true`, and both expected heads are present, so the blocking gap is not basic schema freshness.

This creates a dangerous operating shape:

1. the service can stay green while the alpha path produces no trusted signals;
2. the execution loop can still incur costs and slippage without a measurable profit thesis;
3. the drift and evidence guardrails already exist in source but are not part of a hard promotion contract.

This design extends the live hypothesis ledger architecture in `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md` with the runtime contract that decides whether a strategy lane is blocked, shadow-only, canary-live, or scaled-live.

## Implementation update (2026-03-07)

The runtime-truth slice proposed here is now materially implemented in source and persisted evidence:

- hypothesis-governance rows now persist observed metric windows, capital-allocation stages, and promotion decisions;
- `live_canary_observed` and `live_scale_observed` are derived from persisted runtime windows rather than prose-only
  review;
- the legal capital stages implemented in the proving lane are `shadow`, `0.10x canary`, `0.25x canary`, `0.50x live`,
  and `1.00x live`;
- dependency quorum, slippage budgets, continuity, and drift outcomes are now part of the recorded promotion path
  instead of remaining operator inference.

The proving set also stayed narrower than the illustrative `H-*` examples below. The end-to-end doc29 proof used
`legacy_macd_rsi` and `intraday_tsmom_v1` as canonical spec-backed seed strategies. The `H-CONT-01`, `H-REV-01`, and
`H-MICRO-01` examples remain forward-looking design templates for broader live hypothesis breadth.

## Problem Statement

The current runtime optimizes for service availability and deterministic safety, but profitability requires a different contract: every live lane must prove that it has current data, valid features, recent evidence continuity, bounded slippage, and positive post-cost expectancy before it consumes meaningful capital.

Today the gaps are structural rather than cosmetic:

- `services/torghut/app/trading/scheduler.py` already tracks `feature_batch_rows_total`, `drift_detection_checks_total`, `evidence_continuity_checks_total`, `signal_lag_seconds`, and `no_signal_streak`, but those values do not determine a hard lane state.
- `services/torghut/app/main.py` surfaces a useful control-plane contract, but the contract does not declare whether any alpha lane is actually trade-ready.
- `services/jangar/src/server/control-plane-status.ts` can report healthy status even when recent job failures and crash loops are visible elsewhere, which means dependency truth is not strict enough for capital promotion.
- The system measures execution quality through TCA, but there is no first-class link between slippage budgets and capital scaling.

## Objectives

1. Make alpha readiness explicit and machine-evaluable instead of inferred from partial health signals.
2. Attach every live trading decision to a declared, measurable hypothesis with entry criteria, expected edge, and rollback thresholds.
3. Prevent capital scale-up when data freshness, feature coverage, or evidence continuity are degraded even if the process itself is running.
4. Couple execution quality and realized post-cost outcomes to promotion and demotion decisions.
5. Reuse the Jangar resilience lane so upstream quota, rollout, and dependency degradation can automatically push Torghut back to shadow mode.

## Non-goals

- This document does not relax deterministic risk controls or emergency stop semantics.
- This document does not claim deterministic profitability for every session.
- This document does not require immediate introduction of new model families before the readiness and profit circuit exists.

## Alternatives Considered

### 1. Tune the existing live strategy in place

- Pros: fastest path to another rollout.
- Cons: still leaves no durable contract for why a strategy deserves capital; likely repeats the same blind spots with different thresholds.

### 2. Expand the feature/model stack first

- Pros: ambitious research surface and potentially higher upside.
- Cons: current evidence already shows the system lacks a reliable admission contract; expanding complexity first increases failure modes before the control plane can judge readiness.

### 3. Add a hypothesis-led readiness and profit circuit first (selected)

- Pros: makes profitability testable, ties promotion to post-cost evidence, and turns current freshness/drift/evidence signals into enforceable state.
- Cons: requires new manifest/config surfaces, new status payloads, and stricter deployer gates before capital can be scaled.

## Selected Architecture

### 1. Introduce a versioned hypothesis registry

Each autonomous or operator-promoted lane must reference a versioned hypothesis manifest stored in source control and loaded by `torghut` at startup.

The manifest contract should include at least:

- `hypothesis_id`
- `lane_id`
- `strategy_family`
- `market_regimes`
- `required_feature_sets`
- `required_dependency_capabilities`
- `expected_gross_edge_bps`
- `max_allowed_slippage_bps`
- `min_sample_count_for_live_canary`
- `min_sample_count_for_scale_up`
- `max_rolling_drawdown_bps`
- `rollback_triggers`
- `promotion_gates`

The registry becomes the source of truth for whether a decision is part of:

- `blocked`
- `shadow`
- `canary_live`
- `scaled_live`

No lane is allowed to skip directly from design to scaled live operation.

### 2. Compile alpha readiness from live runtime signals

Add an alpha readiness compiler inside the scheduler/control-plane path that converts existing runtime metrics into a strict lane-state decision.

The readiness compiler must evaluate:

- signal continuity:
  - `signal_lag_seconds`
  - `no_signal_streak`
  - `signal_continuity_alert_reason`
- feature quality:
  - `feature_batch_rows_total`
  - feature freshness and required columns per hypothesis
- evidence continuity:
  - recent `evidence_continuity_checks_total`
  - `last_evidence_continuity_report`
- drift governance:
  - recent drift checks and active drift action
- execution quality:
  - rolling TCA, realized spread/slippage, reject mix
- dependency quorum:
  - Jangar control-plane capabilities and market-context freshness

The compiler should produce a per-hypothesis state object:

- `state`: `blocked | shadow | canary_live | scaled_live`
- `reasons`: atomic blocking or degrading reasons
- `last_verified_at`
- `capital_multiplier`
- `promotion_eligible`
- `rollback_required`

If `feature_batch_rows_total == 0`, `evidence_continuity_checks_total == 0`, or `drift_detection_checks_total == 0` for the relevant lookback window, the lane cannot be `canary_live` or `scaled_live`.

### 3. Add a profit circuit that gates capital by post-cost evidence

Add a profit circuit controller on top of the readiness compiler. The controller must use realized performance and TCA to determine capital stage.

Capital stages:

1. `shadow`
2. `0.10x canary`
3. `0.25x canary`
4. `0.50x live`
5. `1.00x live`

Promotion requires all of:

- readiness compiler state is healthy for the hypothesis;
- rolling realized expectancy after costs is positive;
- rolling average absolute slippage is within hypothesis budget;
- reject mix does not show dependency or policy path regressions;
- market-session evidence count exceeds the hypothesis minimum sample count.

Automatic demotion is triggered by any of:

- rolling expectancy after costs below zero for the configured window;
- average absolute slippage above hypothesis budget for two consecutive windows;
- continuity alert becomes actionable during market session;
- Jangar dependency quorum returns `delay` or `block`;
- drift governance returns `degrade`, `abstain`, or `fail` for the active route.

### 4. Split the system into shadow evidence and capital-consuming lanes

Today the runtime can be "live" while the alpha engine is effectively inert. The new design separates:

- `shadow evidence lane`: always captures candidate trades, features, and post-trade counterfactual outcomes;
- `capital lane`: allowed to place live risk only when the readiness compiler and profit circuit both approve.

This separation allows Torghut to keep learning when live capital is blocked, instead of conflating operational uptime with trading readiness.

### 5. Reuse Jangar admission quorum as a dependency gate

The Jangar design in `docs/agents/designs/jangar-control-plane-admission-quorum-and-rollout-circuit-breaker-2026-03-06.md` should become an upstream dependency contract for Torghut.

Torghut must consume dependency state as:

- `allow`: normal readiness evaluation may continue.
- `delay`: shadow-only mode; live capital promotion blocked.
- `block`: emergency demotion to `shadow` and cancellation of promotion attempts.

This is required because current evidence shows provider quota exhaustion and agent-provider configuration errors can occur while high-level status remains misleadingly healthy.

## Initial Hypothesis Set

The first implementation should not attempt unlimited strategy breadth. Start with three explicit hypotheses:

### `H-CONT-01`

- Description: regime-aligned intraday continuation on liquid symbols using the existing signal feed plus TCA-aware execution policy.
- Initial state: `shadow`
- Entry contract: `signal_lag_seconds <= 90` during market hours, fresh universe, feature rows present, evidence continuity checked in the last 30 minutes.
- Promotion contract: `>= 40` market-session samples, post-cost expectancy `> 6 bps`, average absolute slippage `<= 12 bps`.
- Rollback triggers: expectancy `<= 0`, slippage `> 15 bps`, or continuity alert becomes actionable.

### `H-REV-01`

- Description: event reversion after a fresh market-context shock with confirmation from Jangar.
- Initial state: `shadow`
- Entry contract: `market-context` freshness `<= 120s`, dependency quorum `allow`, and no missing repository or provider metadata.
- Promotion contract: `>= 30` samples, post-cost expectancy `> 8 bps`, and false-positive rate below the configured threshold.
- Rollback triggers: market-context freshness breach, dependency quorum `delay` or `block`, or repeated stale context incidents.

### `H-MICRO-01`

- Description: microstructure-informed breakout lane with adaptive execution and a tighter slippage budget.
- Initial state: `blocked` until features exist
- Entry contract: order-book or liquidity features present with `>= 95%` coverage, drift governance active, and shadow counterfactual logs complete.
- Promotion contract: `>= 60` samples, post-cost expectancy `> 10 bps`, average absolute slippage `<= 8 bps`.
- Rollback triggers: feature coverage drop, drift gate `degrade` or `fail`, or slippage above budget.

The architecture is intentionally ambitious: it preserves the current live continuation path as one candidate, adds an event-driven profit hypothesis, and reserves a higher-upside microstructure lane that cannot leave `blocked` until its data contract exists.

## Implementation Scope

### `torghut`

Required code paths:

- `services/torghut/app/config.py`
  - define hypothesis manifest path, readiness windows, and profit circuit thresholds.
- `services/torghut/app/trading/scheduler.py`
  - compile readiness state, enforce stage transitions, and publish per-hypothesis status.
- `services/torghut/app/trading/ingest.py`
  - expose freshness and coverage diagnostics required by the readiness compiler.
- `services/torghut/app/trading/tca.py`
  - provide rolling slippage/expectancy inputs aligned to hypothesis windows.
- `services/torghut/app/main.py`
  - expose `hypotheses`, `readiness`, `capital_stage`, and `promotion_blockers` in `/trading/status`, `/trading/health`, and `/metrics`.
- `services/torghut/tests/`
  - add regression coverage for promotion, demotion, and shadow-only enforcement.

### `jangar`

Required code paths:

- `services/jangar/src/server/control-plane-status.ts`
  - emit dependency quorum state that reflects recent rollout failures, crash loops, provider throttles, and disabled controllers truthfully.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - replace the current "healthy on workflow lookup failure" expectation with explicit degraded behavior when evidence is incomplete or stale.

### Config and artifact surfaces

Add source-controlled manifests for each hypothesis, stored alongside other trading runtime configuration, so deployers can diff the exact business logic being promoted.

## Validation and Acceptance Gates

### Engineer handoff gates

The engineer stage is complete only when all are true:

1. `torghut` exposes a per-hypothesis readiness payload in `/trading/status`.
2. A hypothesis without fresh features, evidence continuity, and drift checks is forced to `shadow` or `blocked`.
3. The capital multiplier is derived from realized post-cost metrics rather than a static environment flag.
4. Unit and integration tests cover:
   - readiness compiler state transitions,
   - Jangar dependency quorum ingestion,
   - profit circuit promotion and demotion,
   - hypothesis manifest validation,
   - shadow-only behavior for missing feature coverage.
5. The implementation includes a reproducible query or report for per-hypothesis expectancy, slippage, and drawdown windows.

### Deployer handoff gates

The deployer stage is complete only when all are true:

1. Jangar dependency quorum is `allow` for the required capabilities for one full market session before any capital promotion.
2. `H-CONT-01` remains in `shadow` until:
   - `signal_lag_seconds <= 90` during market hours for the promotion window,
   - `feature_batch_rows_total > 0`,
   - `drift_detection_checks_total > 0`,
   - `evidence_continuity_checks_total > 0`.
3. No hypothesis is promoted above `0.25x canary` without documented evidence that post-cost expectancy stayed positive for the configured sample window.
4. Any continuity alert, quota degradation, or slippage budget breach triggers immediate demotion to `shadow` and review before re-promotion.
5. Rollout notes record the hypothesis IDs, capital stage changes, sample counts, and the exact rollback condition that would reverse the promotion.

## Rollout Plan

### Phase 0: observability and manifest introduction

- Add hypothesis manifests, readiness compiler outputs, and metrics without changing live capital allocation.
- Keep all hypotheses in `shadow` or `blocked`.

### Phase 1: shadow evidence proving

- Run `H-CONT-01` and `H-REV-01` in shadow for at least one full trading week.
- Record per-hypothesis signal counts, expectancy, slippage, and blocker reasons.

### Phase 2: constrained canary

- Promote only `H-CONT-01` to `0.10x` then `0.25x` canary if all promotion gates hold.
- Keep `H-REV-01` shadow-only until Jangar market-context jobs and dependency quorum stop showing metadata/configuration failures.

### Phase 3: scaled capital

- Only hypotheses with repeated positive post-cost evidence and bounded slippage can graduate to `0.50x` and `1.00x`.
- `H-MICRO-01` stays `blocked` until its feature coverage contract is implemented and validated.

## Rollback Plan

Rollback is operationally simple:

- demote any hypothesis to `shadow`;
- set global live capital multiplier to zero if dependency quorum is `block`;
- preserve shadow evidence collection during rollback to avoid losing learning windows;
- revert the hypothesis manifest version if the issue is contract/configuration induced rather than market-regime induced.

The deployer should never need to disable the entire service merely because a single hypothesis fails readiness or profit gates.

## Risks and Open Questions

- The current live environment already shows a mismatch between service uptime and trading readiness; if the new readiness payload is not adopted as the promotion truth, operators may continue to over-trust the old status.
- `H-REV-01` depends on Jangar market-context reliability, and recent agent logs show template jobs failing due to missing repository metadata. That dependency must be corrected before event-driven lanes can consume capital.
- `H-MICRO-01` is intentionally blocked by missing feature coverage; treating it as live-ready early would recreate the same "healthy but unproven" pattern at higher complexity.
- The first implementation must choose windows carefully so it does not overfit recent low-signal periods; all thresholds should be backed by forward-only evaluation and revisited after the first shadow week.

## Relationship to Existing Documents

This document extends, not replaces:

- `08-profitability-research-validation-execution-governance-system.md`
- `15-live-execution-quality-and-profitability-recovery-plan-2026-03-04.md`
- `27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
- `19-jangar-symbol-dependency-freshness-and-readiness-guard.md`
- `22-trading-readiness-dependency-freshness-cache-2026-03-04.md`
- `26-database-migration-lineage-and-readiness-contract-2026-03-05.md`

The new contribution is the missing profit architecture layer: a formal contract that binds alpha hypotheses, dependency truth, feature freshness, and post-cost outcomes into a single promotion system.
