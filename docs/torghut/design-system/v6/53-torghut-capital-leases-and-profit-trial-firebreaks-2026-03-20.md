# 53. Torghut Capital Leases and Profit-Trial Firebreaks (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impact:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`

Extends:

- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`

## Executive summary

The decision is to make Torghut allocate non-shadow capital only through durable **Capital Leases** backed by Jangar
admission receipts and profit-trial evidence. Scheduler truth, status truth, and deployer truth must all read the same
lease, not independently re-derive promotion eligibility.

The reason is visible in the live system today:

- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns `live_submission_gate.allowed=true`
  - returns `capital_stage="0.10x canary"`
  - returns `critical_toggle_parity.status="diverged"`
  - returns `promotion_eligible_total=0`
  - returns all hypotheses in `shadow`
- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - also reports the live gate as healthy and canary-capable
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - reports `overallState="down"`
  - reports stale fundamentals and news
  - reports technicals and regime errors
- `kubectl logs -n torghut torghut-options-catalog-...`
  - shows `password authentication failed for user "torghut_app"`
- `kubectl describe pod -n torghut torghut-options-ta-...`
  - confirms `ImagePullBackOff`
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - shows elevated freshness fallback counts for `ta_signals` and `ta_microbars`

The tradeoff is that Torghut will need more explicit persistence, more lease expiry handling, and stricter
profitability admission. That is the correct trade: profitability cannot be improved by letting contradictory live
gates persist.

## Assessment snapshot

### Runtime and cluster evidence

Evidence captured on `2026-03-20`:

- `kubectl get pods -n torghut -o wide`
  - core Torghut revision is `Running`
  - forecast readiness is degraded
  - options catalog and enricher are in `CrashLoopBackOff`
  - options TA is in `ImagePullBackOff`
  - options WS continues to restart
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -n 80`
  - confirms recent liveness, readiness, restart, and image-pull failures
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - reports `live_submission_gate.allowed=true`
  - reports `configured_live_promotion=true`
  - reports `promotion_eligible_total=0`
  - reports `critical_toggle_parity.status="diverged"`
  - reports `forecast_service.status="degraded"`
  - reports `signal_lag_seconds=36282`
- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - reports live gate `ok=true` and `capital_stage="0.10x canary"`
  - reports schema current and dependencies healthy enough at the service layer

Interpretation:

- Torghut currently has enough data to know it should be conservative;
- the status and readiness surfaces still permit local optimism;
- profitability needs a lease object that expires and deallocates without depending on human interpretation.

### Source architecture and high-risk modules

Current-branch seams:

- `services/torghut/app/trading/submission_council.py`
  - centralizes gate construction, but still returns an ephemeral payload rather than a persisted lease;
  - it reduces market-context truth to freshness and still allows aggregate stage inflation behavior;
  - local route consumers can still drift from runtime or deployment state.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - builds its own gate in-process before decisions and execution.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` re-render live-capital truth from current state rather than from one durable
    promotion object.
- `services/torghut/app/trading/hypotheses.py`
  - captures hypothesis-local readiness, but dependency truth is still coarse and cache-driven;
  - reduces promotion identity to aggregate totals instead of durable per-hypothesis capital decisions.
- `services/torghut/app/trading/completion.py`
  - still aggregates proof windows by candidate too loosely, which can mix multiple hypotheses that share a candidate
    lineage.
- `services/torghut/app/options_lane/catalog_service.py`
  - import-time DB access means bootstrap failure cannot be consumed as a typed trading firebreak.
- `services/torghut/app/options_lane/enricher_service.py`
  - has the same failure mode.
- `argocd/applications/torghut/knative-service.yaml`
  - still treats `/healthz` as service readiness without enforcing profitability-ready capital state or typed options
    firebreak visibility.

Missing tests:

- no regression proving `live_submission_gate.allowed` cannot be true when there is no valid capital lease;
- no regression proving route, scheduler, and deployer all read the same capital decision;
- no regression proving market-context `down`, alert-active, or domain-error states block lease issuance when a
  hypothesis requires them;
- no regression proving options bootstrap failure only deallocates options trials;
- no regression proving stale Jangar promotion receipts force lease expiry;
- no regression proving contradictory toggle parity or missing quant evidence demotes capital to `observe`.
- no regression proving proof windows remain isolated by hypothesis, account, and window even when candidates are
  shared.

### Database, schema, and data evidence

Evidence captured on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - `schema_current=true`
  - expected and current head are `0024_simulation_runtime_context`
  - lineage warnings remain
- `GET http://torghut.torghut.svc.cluster.local/metrics`
  - `torghut_trading_alpha_readiness_promotion_eligible_total 0`
  - `torghut_trading_execution_clean_ratio 1.0`
  - `torghut_trading_feature_quality_rejections_total 4`
  - `torghut_trading_feature_quality_cursor_commit_blocked_total{reason="feature_staleness_exceeds_budget"} 4`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - `bundleQualityScore=0.4525`
  - `overallState="down"`
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - elevated fallback totals remain active

Interpretation:

- schema current is necessary but insufficient;
- market context, feature freshness, and bootstrap validity must all become first-class lease conditions;
- clean execution ratio alone cannot justify capital when the promotion lease is absent.

## Problem statement

Torghut still lacks one durable answer to the question that matters most: "how much capital is this hypothesis allowed
to hold right now, and why?"

Today the system still allows these contradictions:

1. live gate truth can disagree with hypothesis readiness truth;
2. status routes can say `allowed=true` while promotion eligibility remains zero;
3. options-lane failures appear as pod churn rather than typed profitability firebreaks;
4. market-context and quant evidence can be stale without a durable capital deallocation object;
5. deployer-stage validation still depends on interpreting multiple surfaces rather than one lease.

## Alternatives considered

### Option A: keep the submission council and retune thresholds

Pros:

- smallest implementation delta
- preserves current APIs

Cons:

- still leaves the final promotion decision ephemeral
- still relies on multiple surfaces staying in sync
- does not create a durable deallocation contract

Decision: rejected.

### Option B: fail closed globally on any degraded Torghut dependency

Pros:

- simple and safe
- easy to explain

Cons:

- blocks unrelated profitable lanes
- turns options bootstrap incidents into portfolio-wide freezes
- reduces strategic option value

Decision: rejected.

### Option C: capital leases with profit-trial firebreaks

Pros:

- one durable capital truth object
- hypothesis-scoped deallocation rather than global panic
- explicit expiry, rollout, and rollback semantics
- natural bridge between Jangar authority and Torghut profitability

Cons:

- requires additive persistence and explicit lease management
- requires engineer and deployer workflows to validate new artifacts

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will allocate non-shadow capital only through **Capital Leases** issued from fresh Jangar admission receipts,
fresh profit-trial evidence, and typed bootstrap firebreak status.

## Architecture

### 1. Capital lease ledger

Add additive Torghut persistence:

- `capital_leases`
  - key: `{lease_id, hypothesis_id, account, venue}`
  - fields:
    - `lease_state` in `{observe, shadow, canary, live, quarantine}`
    - `notional_cap`
    - `strategy_id`
    - `account`
    - `window`
    - `issued_at`
    - `expires_at`
    - `jangar_receipt_id`
    - `profit_trial_bundle_id`
    - `required_firebreaks`
    - `continuity_dimensions`
    - `reason_codes`
    - `lease_epoch`
- `capital_lease_events`
  - immutable audit log for issue, renew, expire, deallocate, quarantine, and rollback transitions
- `profit_trial_windows`
  - one row per hypothesis, window, and evidence bundle
  - stores expectancy, slippage, reject ratios, feature-quality blockers, market-context authority, regime metadata,
    and continuity dimensions keyed by `strategy_id`, `account`, `hypothesis_id`, and `window`
- `bootstrap_firebreaks`
  - one row per bootstrap domain such as `options_catalog`, `options_enricher`, `options_ta`, `market_context`,
    `quant_latest_store`

Only `capital_leases` may authorize non-shadow capital.

### 2. One lease-backed live gate

The following paths must read the same lease row:

- `/readyz`
- `/trading/status`
- `TradingPipeline._live_submission_gate()`
- future deployer verification scripts

If no current lease exists, the result is:

- `allowed=false`
- `capital_state="observe"`
- `reason_codes=["capital_lease_missing"]`

Local reconstruction may still exist for debugging, but it may not publish a more permissive answer than the lease.

### 3. Market-context and proof identity are mandatory lease inputs

Lease issuance must consume more than freshness:

- market-context overall state
- domain-level error and stale states
- alert-active state
- last blocking reason
- quant latest-store stage list
- hypothesis/account/window identity

Hard rule:

- if a hypothesis requires market context, `overallState in {"down", "degraded"}` or `alert_active=true` blocks lease
  issuance unless an explicit degraded-last-good lease policy exists for that hypothesis and the retained bundle is
  still within its expiry window.

### 4. Profit-trial bundles and measurable hypotheses

This document defines three measurable next-wave profit trials:

- `H-CONT-LQ-02`
  - strategy family: liquid continuation
  - required inputs:
    - fresh Jangar control-plane readiness receipt
    - fresh quant evidence receipt
    - healthy signal continuity
  - promotion gates:
    - post-cost expectancy `>= 4bps` across the last 3 market sessions
    - average absolute slippage `<= 8bps`
    - feature-quality blocked batches `= 0` in the trailing session
    - no open `critical_toggle_parity` divergence
- `H-REV-EVT-02`
  - strategy family: event reversion
  - required inputs:
    - fresh Jangar promotion-authority receipt
    - market-context freshness `<= 180s`
    - market-context quality score `>= 0.70`
    - quant evidence receipt with non-empty latest-store stages
  - promotion gates:
    - post-cost expectancy `>= 6bps`
    - negative Sharpe warning absent over `5d`
    - no `market_context_stale` or `quant_pipeline_stages_missing` reason in the current receipt bundle
- `H-OPT-IV-01`
  - strategy family: options implied-volatility dislocation
  - required inputs:
    - all options bootstrap firebreaks healthy for `24h`
    - options TA image available
    - options DB auth valid
    - fresh Jangar promotion-authority receipt with `options_bootstrap` subject healthy
  - promotion gates:
    - post-cost expectancy `>= 12bps`
    - reject ratio `<= 0.05`
    - no image-pull or DB-auth bootstrap firebreak events in the trailing day

These are not merely research ideas. They are lease issuance contracts.

### 5. Profit-trial firebreaks

Firebreaks are typed blockers with scope:

- `market_context`
- `quant_latest_store`
- `feature_quality`
- `options_catalog`
- `options_enricher`
- `options_ta`
- `options_ws`
- `forecast_authority`

Rules:

- if a firebreak is required by a hypothesis and is not healthy, the lease expires or is denied;
- unrelated hypotheses remain in their current lease state if their required firebreaks stay healthy;
- options firebreaks may never silently collapse into generic `degraded`.
- completion proof windows may never be shared across hypotheses merely because the candidate id matches.

### 6. Automatic deallocation and expiry

Capital leases must decay automatically:

- missing or expired Jangar receipt:
  - immediate demotion to `observe`
- stale quant evidence:
  - immediate demotion to `observe`
- negative `5d` Sharpe on an active canary or live lease:
  - demote one stage and open a deallocation event
- repeated feature-quality cursor-commit blocks:
  - prevent lease renewal until cleared
- options bootstrap firebreak open:
  - quarantine options trials only

### 7. Failure-mode reduction

This design reduces concrete failure modes:

1. contradictory live gate truth becomes impossible without a detectable lease mismatch;
2. deployer-stage validation gets one canonical object to trust;
3. options failures stop contaminating unrelated equity hypotheses;
4. market-context and quant staleness automatically deallocate capital instead of waiting for human interpretation;
5. profitability becomes measurable through reusable trial bundles rather than one-off status snapshots.

## Validation gates

Engineer-stage acceptance gates:

1. Lease issuance tests prove `allowed=false` when `promotion_eligible_total=0`, when the Jangar receipt is missing, or
   when required firebreaks are unhealthy.
2. Route parity tests prove `/readyz`, `/trading/status`, and the scheduler read the same lease row.
3. Hypothesis tests prove `H-OPT-IV-01` deallocates on options bootstrap failures while non-options hypotheses remain
   evaluable.
4. Expiry tests prove stale receipts or quant evidence force `observe`.
5. Completion-trace tests prove shared candidates cannot leak profitability evidence across hypotheses or accounts.

Suggested validation commands:

- `pytest services/torghut/app/tests -k "submission_council or capital_lease or hypotheses"`
- `pytest services/torghut/app/tests -k "options or market_context or quant"`

Deployer-stage acceptance gates:

1. `live_submission_gate.allowed` is false unless a current capital lease exists.
2. `capital_state` and lease state match across `/readyz` and `/trading/status`.
3. options firebreak status is visible before any options trial is promoted.
4. lease expiry and rollback reasons are visible in status payloads and audit rows.

Read-only validation examples:

- `curl -fsS http://torghut.torghut.svc.cluster.local/readyz | jq .`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.live_submission_gate'`
- `curl -fsS "http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA" | jq .`

## Rollout plan

1. Add lease, profit-trial, and firebreak tables plus status rendering.
2. Start shadow-writing lease decisions while continuing to publish current status.
3. Switch `/readyz`, `/trading/status`, and scheduler gating to lease-backed enforcement.
4. Introduce hypothesis-specific promotion and deallocation automation after parity is proven.

## Rollback plan

If lease enforcement blocks unexpectedly:

1. disable lease enforcement and keep shadow issuance active;
2. preserve lease and firebreak audit writes;
3. revert only the enforcement switch, not the data model or evidence collection.

Rollback success means capital is again governed by the prior path, but the evidence needed to fix the issue remains
available.

## Risks and open questions

- Lease expiry that is too aggressive can create operational churn.
- Lease expiry that is too relaxed recreates stale capital optimism.
- Trial metrics must stay inexpensive enough to compute per renewal.
- Options firebreak scope must remain precise or operators will reintroduce whole-system freeze behavior by habit.

## Handoff contract

Engineer handoff:

- Implement capital leases, firebreak persistence, route parity, and scheduler parity.
- Do not permit any status surface to bypass the lease once enforcement is enabled.
- Treat missing Jangar receipt freshness as a hard lease-renewal blocker.
- Add regression tests for every contradiction cited here.

Deployer handoff:

- Before claiming promotion readiness, verify:
  - current capital lease exists,
  - receipt id is fresh,
  - required firebreaks are healthy,
  - the hypothesis-specific trial bundle satisfies its measurable gates.
- If `/readyz` and `/trading/status` disagree on lease or capital state, stop rollout and treat it as a lease-parity
  incident.

This architecture does not optimize for convenient canary claims. It optimizes for profitable capital only when the
evidence bundle is current, scoped, and durable.
