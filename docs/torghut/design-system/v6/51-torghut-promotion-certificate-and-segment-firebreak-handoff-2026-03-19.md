# 51. Torghut Promotion Certificate and Segment Firebreak Handoff (2026-03-19)

## Summary

This document turns the March 19 live contradictions into Torghut-specific engineer and deployer scope.

The current canonical source-of-truth is:

- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`

Use this Torghut document as the local handoff contract for the v6 pack.

## Live evidence that drives this handoff

Read-only evidence observed on `2026-03-19`:

- `GET /trading/status`
  - build `v0.564.0-263-g54971ed88`
  - `live_submission_gate.allowed = true`
  - `capital_stage = "0.10x canary"`
  - `promotion_eligible_total = 0`
- `GET /trading/health`
  - `alpha_readiness.state_totals = {"shadow": 3}`
  - `promotion_eligible_total = 0`
  - `live_submission_gate.allowed = true`
- `GET /readyz`
  - `live_submission_gate.allowed = true`
  - `capital_stage = "0.10x canary"`
- `GET /db-check`
  - `schema_current = true`
  - current head = `0024_simulation_runtime_context`
- `GET /api/torghut/trading/control-plane/quant/health?account=paper&window=15m`
  - `status = degraded`
  - `latestMetricsUpdatedAt = null`
  - `latestMetricsCount = 0`
  - `emptyLatestStoreAlarm = true`
  - `stages = []`
- `GET /api/torghut/trading/control-plane/quant/alerts?state=open`
  - open critical `metrics_pipeline_lag_seconds` alerts across short and long windows
  - open negative `sharpe_annualized` warning
- `GET /api/torghut/market-context/health?symbol=AAPL`
  - `overallState = degraded`
  - `technicals` and `regime` are `ok`
  - `fundamentals` and `news` are stale
- `kubectl -n torghut get pods -o wide`
  - `torghut-options-catalog` and `torghut-options-enricher` in `CrashLoopBackOff`
  - `torghut-options-ta` in `ImagePullBackOff`
  - `torghut-ws-options` repeatedly failing readiness
- options-lane logs
  - catalog and enricher fail with `password authentication failed for user "torghut_app"`
  - websocket forwarder cannot fetch desired symbols and falls back to `503 /readyz`

Conclusion:

- Torghut cannot continue to derive capital permission from a local boolean gate.
- Empty or stale quant evidence must be a hard blocker for promotion.
- Options-lane incidents must become segment-local firebreaks rather than vague background errors.

## Decision

Adopt two Torghut-local rules:

1. a non-observe capital state is valid only when a fresh Jangar-issued promotion certificate exists for the exact
   `{hypothesis_id, candidate_id, strategy_id, account, window, capital_state}` tuple;
2. every hypothesis declares its dependency segments, so segment failure demotes only the affected hypotheses.

## Torghut-specific architecture changes

### 1. One shared capital gate

The following paths must stop making independent promotion decisions:

- `/trading/status`
- `/trading/health`
- `/readyz`
- the live trading scheduler in `services/torghut/app/trading/scheduler/pipeline.py`

All of them must consume one shared certificate reader and emit the same payload:

- `certificate_id`
- `capital_state`
- `issued_at`
- `expires_at`
- `reason_codes`
- `segment_summary`
- `quant_health_ref`
- `market_context_ref`

If no valid certificate exists, the result is `observe`.

### 2. Segment firebreak mapping

Add explicit segment mapping to each live hypothesis manifest.

Minimum segment set:

- `market-context`
- `ta-core`
- `options-data.catalog`
- `options-data.enricher`
- `options-data.ws`
- `options-data.ta`
- `execution`
- `empirical`
- `llm-review`

Rules:

- options hypotheses require the full `options-data.*` set
- non-options hypotheses must not be demoted by options-only failures
- stale or `down` required market-context domains block `canary`, `live`, and `scale` for any hypothesis that
  consumes context
- `execution` failure blocks all live capital, because it is a shared deterministic safety boundary

### 3. Options-lane bootstrap reasons become first-class

Torghut must stop inferring options readiness from pod churn alone. Publish explicit reasons through status and the
certificate evaluator:

- `options_db_auth_invalid`
- `options_image_unavailable`
- `options_bootstrap_stale`
- `options_symbol_feed_unavailable`
- `options_schema_missing`

The options lane is allowed to keep collecting diagnostics while these reasons are active, but its dependent hypotheses
must remain in `observe`.

### 4. Quant evidence becomes certificate input, not advisory context

Promotion certificates must treat the following as mandatory blockers for non-observe capital:

- `latestMetricsCount == 0`
- `emptyLatestStoreAlarm == true`
- missing or empty quant snapshot for the requested window
- open critical lag alert for the evaluated strategy/account/window
- stale or `down` market-context domains in the mapped dependency set

This closes the current gap where Torghut can report `ready` while Jangar quant health is degraded and empty.

### 5. Hypothesis windows need stronger identity and continuity fields

Persist evidence windows with:

- `hypothesis_id`
- `candidate_id`
- `strategy_id`
- `account`
- `window`
- `capital_state`
- `dependency_quorum_ok`
- `signal_continuity_ok`
- `evidence_continuity_ok`
- `data_freshness_continuity_ok`

`continuity_ok` becomes a derived projection rather than the only stored continuity field.

This is required for:

- proving exactly which segment broke a certificate,
- preventing one hypothesis from inheriting another hypothesis's proof window,
- replaying rollback conditions after a capital demotion.

## Measurable trading hypotheses

Engineer and deployer stages must evaluate the architecture against three measurable hypotheses:

1. Options-sensitive hypotheses can only outperform the baseline when `options-data.*`, `ta-core`, and
   `market-context` are all fresh.
   - acceptance: two consecutive windows with positive post-cost expectancy and no critical lag alert
2. Baseline non-options hypotheses remain promotable during options outages.
   - acceptance: no forced demotion when only `options-data.*` is degraded
3. Certificate expiry demotes stale capital fast enough to prevent silent live drift.
   - target: demotion to `observe` within one certificate window, not later than `60s`

## Engineer handoff

Engineer acceptance requires:

1. one shared certificate read path used by scheduler and status APIs
2. hypothesis manifests extended with segment dependencies
3. options bootstrap reason taxonomy emitted through Torghut status
4. quant health and snapshot inputs wired directly into certificate evaluation
5. persistence updated to store the stronger hypothesis window identity and continuity subfields

Minimum regression coverage:

- scheduler/status parity on `allowed`, `reason`, and `capital_state`
- `promotion_eligible_total = 0` yields `observe`
- `latestMetricsCount = 0` and `emptyLatestStoreAlarm = true` yield `observe`
- options-only segment failures demote only options-mapped hypotheses
- continuity subfields survive import, query, and completion flows

## Deployer handoff

Deployer acceptance requires:

1. no strategy enters `canary`, `live`, or `scale` without a fresh certificate
2. one shadow drill where options DB auth is intentionally broken and only options-dependent hypotheses demote
3. one shadow drill where quant metrics stop updating and all affected certificates expire to `observe`
4. one rollback drill from `canary` to `observe` or `quarantine` with the exact evidence bundle recorded

## Rollout

1. land segment-aware status and certificate reads in advisory mode
2. compare old Torghut live gate with certificate results for one full trading week
3. enforce certificates for `canary` transitions first
4. enforce certificates for `live` and `scale` once mismatch rate is zero

## Rollback

- if certificate reads fail, force all strategies to `observe`
- preserve segment reasons and window evidence for replay
- do not re-enable a permissive scheduler-only canary path

## References

- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/torghut/design-system/v6/49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
