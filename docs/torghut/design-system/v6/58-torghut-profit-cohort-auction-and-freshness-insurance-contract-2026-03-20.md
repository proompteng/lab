# 58. Torghut Profit Cohort Auction and Freshness Insurance Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`

Extends:

- `57-torghut-profit-clock-cutover-and-regime-auction-contract-2026-03-20.md`
- `56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`

## Executive summary

The decision is to move Torghut from route-time gating to durable **Profit Cohorts** bound to Jangar authority
sessions, then let a bounded **Auction** allocate capital while a quantified **Freshness Insurance** contract preserves
limited opportunity during partial upstream outages.

The reason is concrete in the live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns HTTP `503`
  - reports `postgres`, `clickhouse`, `alpaca`, and schema checks as healthy
  - reports `empirical_jobs.ok=false`
  - reports `quant_evidence.detail="quant_health_fetch_failed"`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns HTTP `200`
  - reports build `v0.566.0-10-g998ddff37`
  - reports revision `torghut-00156`
  - reports `promotion_eligible_total=0`
  - reports `quant_evidence.source_url` still pointing at the generic Jangar control-plane status route
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200`
  - reports `latestMetricsCount=36`
  - reports `metricsPipelineLagSeconds=2`
  - reports `ingestion` lag `86962` seconds while `materialization` lag is only `10` seconds
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - returns HTTP `200`
  - reports `overallState="down"`
  - reports `bundleFreshnessSeconds=369974`
  - reports `bundleQualityScore=0.4525`
  - reports `technicals` and `regime` in `error`
- `kubectl get pods -n torghut -o wide`
  - shows live and simulation Torghut pods healthy
  - shows both forecast and forecast-sim pods `0/1 Running`
- `kubectl logs -n torghut torghut-forecast-7fb7db5cf6-6gsl6 --tail=120`
  - shows repeated `GET /healthz 200`
  - shows repeated `GET /readyz 503`
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - reports `torghut_clickhouse_guardrails_last_scrape_success 0`
  - reports elevated freshness fallback counters for `ta_signals` and `ta_microbars`

The tradeoff is more additive state, a more explicit auction model, and stricter limits on degraded operation. I am
keeping that trade because the current system blocks safely but too coarsely: it still cannot tell us which lanes are
good enough to keep earning when upstream authority is mixed rather than uniformly green.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Torghut
  profitability and Jangar resilience

This artifact succeeds when:

1. every non-observe capital decision cites one `profit_cohort_id` and one `authority_session_id`;
2. healthy lanes can retain or gain limited capital during partial upstream outages only through bounded freshness
   insurance, never through silent optimistic fallback;
3. opportunity-cost and counterfactual evidence become replayable first-class inputs to the allocator;
4. engineer and deployer handoff gates define how to validate, roll out, and roll back the new economics without
   widening blast radius.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Torghut is not uniformly unhealthy. Its authority inputs are mixed.

- the live runtime, simulation runtime, lean runner, TA, and ClickHouse pods are serving;
- both forecast lanes are currently unready after a fresh rollout;
- forecast logs show `healthz` succeeding while `readyz` continues to fail;
- the main runtime blocks because upstream truth is contradictory, not because core storage or broker access is down.

Interpretation:

- the portfolio should not flatten all lanes into one global shadow answer;
- the runtime needs a durable local object that records what was known, what was stale, and what limited capital was
  still allowed;
- profitable degradation must be explicit and bounded.

### Source architecture and high-risk modules

The source tree already contains the raw parts for the next step, but they are still too route-driven.

- `services/torghut/app/trading/scheduler/runtime.py`
  - builds account pipelines around one shared mutable `TradingState`;
  - still serializes trading, reconcile, autonomy, and evidence work through one main loop.
- `services/torghut/app/trading/scheduler/state.py`
  - keeps lane-sensitive `last_*`, market-context, universe, and autonomy fields in one process-local state bag;
  - does not yet provide lane-scoped durable truth.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - commits the ingest cursor even when authoritative universe resolution blocks run-context creation;
  - can therefore burn replay opportunity during upstream authority outages.
- `services/torghut/app/trading/submission_council.py`
  - still resolves quant authority from three possible URLs, including generic control-plane status and market-context
    fallbacks.
- `services/torghut/app/trading/hypotheses.py`
  - loads dependency quorum from the broad Jangar status route and turns upstream ambiguity into coarse hypothesis
    reasons.
- `services/torghut/app/trading/portfolio.py`
  - already has deterministic budgeting, fragility, and regime multipliers;
  - does not yet score opportunity cost, freshness debt, or authority session quality into allocations.
- `services/torghut/app/main.py`
  - already exposes runtime profitability evidence and db-check status;
  - separately reconstructs gate truth for `/trading/status` instead of reading one durable profitability object.
- `argocd/applications/torghut/knative-service.yaml`
  - still sets only `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
  - does not explicitly set `TRADING_JANGAR_QUANT_HEALTH_URL`.

### Database, schema, freshness, and consistency evidence

The database layer is healthy enough for additive persistence.

- `GET /db-check`
  - reports current head `0025_widen_lean_shadow_parity_status`
  - reports `schema_current=true`
  - reports lineage warnings from two historical parent forks, but no active divergence
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py`
  - already provides durable tables for hypotheses, metric windows, capital allocations, and promotion decisions
- `docs/torghut/postgres-table-reference.md`
  - already documents shadow and execution evidence surfaces such as `lean_execution_shadow_events`
- direct SQL execution is blocked by RBAC:
  - `kubectl auth can-i create pods/exec -n torghut` -> `no`

Interpretation:

- Torghut should add narrow additive tables for cohorts, counterfactual evidence, and insurance budgets;
- the problem is authority and freshness composition, not missing baseline storage;
- the architecture should reuse existing runtime profitability and shadow evidence rather than inventing a parallel
  telemetry stack.

## Problem statement

Torghut still has six profitability-critical gaps:

1. it can still treat the wrong Jangar endpoint as usable quant authority;
2. it has no durable object that explains why one lane should keep or lose capital under mixed upstream health;
3. lane-local architecture still collapses into one shared mutable runtime state bag;
4. forecast, market-context, quant freshness, and empirical readiness are reduced to coarse block reasons instead of a
   scored opportunity model;
5. the allocator does not yet use counterfactual or opportunity-cost evidence when scarce capital must be rationed;
6. there is no bounded degraded-mode contract that preserves upside without hiding real data debt;
7. scheduler, readiness, status, and deploy validation still cannot prove they are looking at the same profitability
   decision.

That is protective, but it is not capital-efficient.

## Alternatives considered

### Option A: finish the explicit quant URL cutover and keep the existing gate model

Summary:

- set the explicit quant-health URL everywhere;
- remove permissive fallbacks;
- keep final capital allocation global and gate-based.

Pros:

- smallest implementation delta;
- immediately removes one wrong authority path.

Cons:

- does not tell us which lanes deserve capital under partial outage;
- keeps profitability decisions tied to route-time reduction;
- provides no durable degraded-mode budget.

Decision: rejected.

### Option B: move final capital allocation into Jangar

Summary:

- Jangar would decide lane-level capital eligibility and rollout;
- Torghut would mainly execute.

Pros:

- one place to inspect platform and trading state.

Cons:

- couples platform authority to trading economics;
- increases Jangar blast radius;
- slows future research iteration and hypothesis-local autonomy.

Decision: rejected.

### Option C: profit cohorts, opportunity auction, and freshness insurance

Summary:

- Torghut binds to Jangar authority sessions;
- it settles local trading evidence into durable profit cohorts;
- the allocator uses a deterministic auction over those cohorts, with a bounded insurance budget for partial upstream
  degradation.

Pros:

- makes mixed health actionable rather than merely blocked;
- creates replayable economics tied to one authority session;
- preserves separation between Jangar platform truth and Torghut capital decisions;
- turns degraded-mode operation into an explicit, auditable contract.

Cons:

- adds additive persistence and a more sophisticated allocator;
- requires A/B replay validation before any live capital effect;
- makes guardrails stricter and therefore more visible.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle authority-session-bound profit cohorts, then allocate capital through a deterministic opportunity
auction with explicit freshness insurance budgets instead of route-time optimism.

## Architecture

### 1. Profit cohort persistence

Add additive Torghut tables:

- `profit_cohort_windows`
  - `profit_cohort_id`
  - `authority_session_id`
  - `account`
  - `hypothesis_id`
  - `lane_id`
  - `regime_label`
  - `capital_stage`
  - `window_started_at`
  - `window_ended_at`
  - `realized_pnl_bps`
  - `counterfactual_pnl_bps`
  - `opportunity_cost_bps`
  - `freshness_debt_bps`
  - `forecast_health_score`
  - `quant_ingestion_lag_seconds`
  - `market_context_domain_states_json`
  - `decision`
  - `decision_reason_codes_json`
  - `fresh_until`
- `counterfactual_execution_ledger`
  - `decision_trace_id`
  - `authority_session_id`
  - `hypothesis_id`
  - `lane_id`
  - `symbol`
  - `route`
  - `entered_at`
  - `realized_return_bps`
  - `counterfactual_return_bps`
  - `miss_reason`

Rules:

- a profit cohort is the only object allowed to tell scheduler, readiness, or status whether a lane may leave `observe`;
- every cohort must reference the exact Jangar authority session it consumed;
- counterfactual outcomes must be preserved even when the lane was blocked or shadow-only.
- lane-local truth must be reconstructable from persisted cohort rows rather than one shared process-local state bag.

### 2. Auction model

Add:

- `capital_auction_rounds_v3`
  - `auction_round_id`
  - `authority_session_id`
  - `account`
  - `regime_label`
  - `entered_at`
  - `entrants_json`
  - `winning_cohort_ids_json`
  - `capital_budget_notional`
  - `allocation_json`
  - `decision_reason_codes_json`

Baseline score shape:

- positive inputs:
  - realized cohort edge
  - counterfactual edge
  - forecast quality
  - recent execution stability
- negative inputs:
  - freshness debt
  - quant ingestion lag
  - market-context domain loss
  - fragility and drawdown penalties

The exact formula is implementation detail, but the contract is not: the allocator must be deterministic, auditable,
and reconstructable from one cohort row plus one authority session.

### 3. Freshness insurance

Add:

- `freshness_insurance_budgets`
  - `insurance_budget_id`
  - `authority_session_id`
  - `lane_id`
  - `regime_label`
  - `allowed_domain_losses_json`
  - `max_freshness_debt_bps`
  - `remaining_debt_bps`
  - `cap_stage_ceiling`
  - `issued_at`
  - `expires_at`
  - `revoked_at`
  - `revocation_reason`

Rules:

- insurance is only valid for partial dependency loss, never for missing quant authority or unrecoverable regime/TA
  failures;
- insurance cannot lift a lane above its configured ceiling, and the initial ceiling is `0.10x canary`;
- every debt spend must be observable in the cohort row and reducible over time.

### 4. Measurable trading hypotheses

Hypothesis H1: authority-session-bound cohorts reduce false global shadow time.

- target:
  - increase eligible canary minutes for healthy lanes by `>= 20%` versus the March 20 baseline;
- guardrail:
  - no increase in quant-authority or market-context contract violations.

Hypothesis H2: bounded freshness insurance preserves upside during partial data loss.

- target:
  - retain at least `60%` of baseline shadow opportunity on lanes whose missing inputs are explicitly insured;
- guardrail:
  - no insured lane may exceed the configured debt ceiling or stage ceiling.

Hypothesis H3: opportunity-cost-aware auctions outperform stage-only allocation.

- target:
  - improve top-quartile realized or counterfactual cohort edge by `>= 10%` in replay over the current stage-only
    allocator;
- guardrail:
  - maximum drawdown and fragility metrics must stay within current production envelopes.

### 5. Acceptance gates

Engineer acceptance gates:

1. `scheduler`, `/readyz`, `/trading/status`, and the allocator all surface the same `profit_cohort_id` and
   `authority_session_id` for the active capital decision.
2. A lane may spend freshness insurance only when its missing domains match the budget contract and quant authority is
   still valid.
3. Generic Jangar status URLs are rejected as typed quant-health authority once the cohort contract is enabled.
4. Lane-local cohort state remains isolated across accounts and lanes even when one lane loses universe or market
   authority.
5. Replay tests compare the baseline allocator to the cohort auction and quantify H1-H3 deltas before live effect.

Deployer acceptance gates:

1. Initial rollout remains shadow-only with dual-written cohorts and auctions until replay parity is clean.
2. Canary capital may only be enabled for cohorts with a fresh authority session and no open insurance-budget
   violations.
3. Any revoked session or insurance budget forces the affected lanes back to `observe` within one reconcile interval.
4. Rollback restores the previous allocator while preserving cohort, auction, and insurance history for forensics.

## Rollout plan

Phase 0: additive shadow write

- add the cohort, counterfactual, insurance, and auction tables;
- dual-write cohort rows with no capital effect;
- keep the current allocator authoritative.

Phase 1: shadow auction and replay

- run the new auction alongside the old allocator;
- compare H1-H3 metrics in replay and bounded live shadow windows;
- require explicit quant-health binding before proceeding.

Phase 2: insured canary

- allow only capped canary allocation from cohort winners;
- enable freshness insurance for the smallest eligible lane set;
- keep automatic rollback on session or insurance revocation.

Phase 3: primary cohort auction

- make the cohort auction the authoritative non-observe allocator;
- retain legacy summaries for a short compare window only;
- continue writing counterfactual evidence for future tuning.

## Rollback plan

If the new allocator or insurance contract causes false positives or bad capital moves:

1. disable auction enforcement and return to the previous stage-based allocator;
2. set all insurance budgets to revoked while preserving cohort history;
3. continue dual-writing cohorts and counterfactual rows for diagnosis;
4. resume rollout only after replay evidence shows the regression is closed.

## Risks and open questions

- Poorly tuned insurance budgets could hide genuine data debt. Mitigation: initial low ceilings and explicit revocation.
- Counterfactual scoring can be gamed by noisy shadow samples. Mitigation: minimum evidence volume and volatility-aware
  weighting.
- The live runtime must not depend on unavailable forecast paths for insured operation. Mitigation: insurance never
  substitutes for missing quant authority and starts with the smallest cohort set.

## Handoff to engineer

1. Implement additive cohort, counterfactual, insurance, and auction persistence tied to `authority_session_id`.
2. Replace final capital decisions with deterministic auction reads over profit cohorts while keeping dual-write shadow
   mode first.
3. Remove permissive typed quant-health fallback and make insured degraded mode explicit in scheduler and status paths.
4. Add replay and regression coverage for cohort scoring, insurance ceilings, and lane-local rollback.

## Handoff to deployer

1. Do not enable canary capital for the new allocator until replay evidence for H1-H3 is attached to the rollout.
2. Treat any session revocation, insurance revocation, or quant-authority mismatch as an immediate lane-local rollback
   trigger.
3. Verify that active capital decisions cite the same `profit_cohort_id` in readiness, trading status, and rollout
   evidence before promotion.
4. Keep the previous allocator callable until one full trading session completes without guardrail breach.
