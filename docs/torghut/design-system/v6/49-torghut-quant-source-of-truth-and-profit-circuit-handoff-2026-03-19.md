# Torghut Quant Source-of-Truth and Profit-Circuit Handoff (2026-03-19)

## Summary

This document captures the March 19 baseline handoff that led to the current Torghut-local contract.
The current canonical source-of-truth is:

- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`

Keep this document as the March 19 evidence baseline, and use the newer Torghut document as the active handoff
contract inside the v6 pack.

## Why this supersedes the March 16 Torghut plan docs

The March 16 plan/discover documents were directionally correct, but the March 19 live state exposes four harder facts:

1. quant compute/materialization can remain healthy while ingestion is stale;
2. market context can be `down` even when symbols and TA freshness are still present;
3. options-lane failures are dominated by bootstrap/auth/image problems, not by market logic;
4. scheduler-side live promotion semantics are still weaker than the richer control-plane status semantics.

That means Torghut cannot keep using one shared "ready for profitability" interpretation.
It needs lane-local readiness plus one shared gating surface that both the scheduler and status APIs consume.

## Live Torghut evidence snapshot

Read-only evidence observed on `2026-03-19`:

- `torghut-options-catalog` and `torghut-options-enricher` crash with
  `password authentication failed for user "torghut_app"`.
- `torghut-options-ta` is `ImagePullBackOff`.
- `GET /api/torghut/trading/control-plane/quant/health?...`
  - `status=degraded`
  - `missingUpdateAlarm=true`
  - ingestion stages `lagSeconds=300`
- `GET /api/torghut/trading/control-plane/quant/snapshot?...`
  - `metrics_pipeline_lag_seconds=300`
  - `ta_freshness_seconds=4`
  - `context_freshness_seconds=32`
  - most profitability metrics remain `insufficient_data`
- `GET /api/torghut/trading/control-plane/quant/alerts`
  - open critical lag alerts across short and long windows
  - open negative Sharpe warning
- `GET /api/torghut/market-context/health`
  - `overallState=down`
  - technicals/regime `error`
  - fundamentals/news stale

Conclusion:

- profitability must be guarded per lane and per strategy;
- market context, quant ingestion, and options data cannot be collapsed into one boolean;
- the system must fail closed for promotion while still allowing unaffected evidence collection paths to run.

## Torghut-specific design decisions

### 1) One readiness contract for status and scheduler

`/trading/status` and the live scheduler must import the same decision function for:

- dependency quorum,
- empirical-job readiness,
- DSPy readiness,
- data freshness,
- continuity,
- live-promotion entitlement.

No code path may submit live orders if the shared contract returns anything other than `allow`.

### 2) Hypothesis-local profitability windows

Each profitability record must be keyed by:

- `hypothesis_id`
- `candidate_id`
- `strategy_id`
- `account`
- `window`
- `capital_state`

This prevents one matched hypothesis from inheriting another hypothesis's proof window or completion state.

### 3) Continuity is not just dependency quorum

Persist and evaluate continuity dimensions independently:

- `dependency_quorum_ok`
- `signal_continuity_ok`
- `evidence_continuity_ok`
- `data_freshness_continuity_ok`

`continuity_ok` becomes a derived field, never the only stored one.

### 4) Options lane becomes a gated subsystem

Before any options strategy leaves `observe`, Torghut must prove:

- image can be pulled,
- DB auth succeeds,
- required schema exists,
- rate-limit buckets were seeded,
- readiness endpoint shows a fresh bootstrap heartbeat.

Any failure yields an explicit readiness reason such as:

- `options_image_unavailable`
- `options_db_auth_invalid`
- `options_schema_missing`
- `options_bootstrap_stale`

### 5) Capital-state semantics are standardized

Torghut uses the same states defined by the source-of-truth architecture:

- `observe`
- `canary`
- `live`
- `scale`
- `quarantine`

Promotion rules:

- `observe -> canary`: two consecutive complete evidence windows and no critical freshness or continuity breach.
- `canary -> live`: positive guardrail pass plus market-context and ingestion readiness.
- `live -> scale`: profitability and continuity remain green across the configured multi-window horizon.
- any repeated critical breach forces `quarantine`.

## Engineer handoff

Engineer acceptance requires:

1. shared readiness function wired into both scheduler and status API;
2. hypothesis-local evidence persistence and query paths;
3. explicit continuity subfields persisted and tested;
4. options-lane bootstrap state published as readiness, not inferred from pod crashes;
5. regression tests added for:
   - scheduler/status parity,
   - multi-hypothesis candidate isolation,
   - continuity failure independent of dependency quorum,
   - options bootstrap failures.

## Deployer handoff

Deployer acceptance requires:

1. no promoted strategy while `market_context.overallState=down`;
2. no `scale` transition while quant lag alerts remain open;
3. proof that options capital stays at `observe` when bootstrap/auth/image is red;
4. one forced rollback from `canary` or `live` to `observe` / `quarantine` with persisted evidence.

## References

- `docs/agents/designs/49-jangar-control-plane-execution-truth-spine-and-torghut-profit-circuit-2026-03-19.md`
- `docs/torghut/design-system/v6/46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`
- `docs/torghut/design-system/v6/47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
- `docs/torghut/design-system/v6/48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`
