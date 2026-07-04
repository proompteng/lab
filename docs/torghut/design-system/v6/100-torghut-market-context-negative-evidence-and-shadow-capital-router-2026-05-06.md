# 100. Torghut Market Context Negative Evidence And Shadow Capital Router (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

Torghut should add a **market-context negative-evidence ledger and shadow capital router** before any broader capital
reentry work.

The current live state is appropriately conservative. Torghut is serving, the database schema is current, quant metrics
are updating, and broker connectivity is healthy. But live submission is disabled, capital is shadow, no hypothesis is
promotion eligible, market-context health is down, and quant health omits scoped account/window stage proof unless the
caller supplies that scope. The profitable architecture move is not to loosen capital gates. It is to turn missing and
error market context into priced negative evidence, rank the zero-notional repairs that can restore it, and route only
shadow capital through evidence-complete lanes.

The tradeoff is slower time to paper/live experiments. I accept that because a strategy without current market context
and scoped execution proof is not an experiment; it is unpriced exposure.

## Evidence Snapshot

All evidence for this pass was read-only.

### Plan-Lane Refresh (2026-05-06T00:25Z)

I rechecked Torghut from the required Jangar plan lane after the first version of this document merged. The decision
remains the same: market-context negative evidence plus a shadow-capital router. The new evidence makes the profit path
narrower and clearer. Torghut is operationally serving and schema-current, but profitability evidence is not yet
trade-ready, and the options lane is reporting a ready route without useful catalog data.

Read-only evidence from this refresh:

- Active live and sim revisions recovered to ready: `torghut-00225` and `torghut-sim-00306` were both `1/1`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, one current head, one expected head,
  lineage ready, and the known parent-fork warnings.
- Torghut `/readyz` and `/trading/health` returned HTTP 503 `status=degraded`, but the dependency details were specific:
  Postgres, ClickHouse, Alpaca, and schema were OK; live submission was blocked by `simple_submit_disabled`; capital stage
  was `shadow`; empirical jobs were degraded; DSPy live runtime was not active; quant health was not configured as a
  required blocker.
- Alpha readiness still had three hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
  This means capital reentry is not merely waiting on a deployer toggle.
- `/trading/empirical-jobs` reported `ready=false`, `status=degraded`, `authority=blocked`, candidate
  `intraday_tsmom_v1@prod`, dataset snapshot `torghut-full-day-20260318-884bec35`, and four stale completed jobs with S3
  artifact refs: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- `/trading/profitability/runtime` reported schema `torghut.runtime-profitability.v1`; the 72-hour window had 8 decisions,
  all rejected across AAPL, AMD, INTC, and NVDA, with 0 executions and 0 TCA samples.
- `torghut-options-catalog` `/healthz` returned `ready=true`, `status=ok`, `last_success_ts=null`, `last_error=null`, and
  `symbols=0`. A ready route with an empty catalog cannot be used as market-context proof.
- ClickHouse guardrail metrics had both replicas up, free-disk ratios around 0.97, no read-only replicated tables, fresh TA
  timestamps, and nonzero historical low-memory/fallback counters (`ta_signals=1`, `ta_microbars=186`). The router should
  price these counters as route cost evidence instead of treating ClickHouse as a binary pass.

Plan-lane consequence:

- `torghut_observe` can remain allowed from serving/schema/route evidence.
- `torghut_repair` should rank the four stale empirical jobs first because each names a dataset snapshot, candidate, and
  artifact refs. The repair dividend must include route cost and a falsification check, not just expected freshness gain.
- `torghut_paper_capital` and `torghut_live_capital` stay blocked until empirical jobs are fresh or explicitly waived by a
  current proof escrow, scoped account/window proof exists, execution count is nonzero, TCA samples are nonzero, and live
  submission is no longer blocked by `simple_submit_disabled`.
- Options-market work is repair-only until the catalog route can prove a non-empty symbol set with a fresh success
  timestamp.

- Torghut namespace workloads were broadly up: active live and sim revisions were `1/1`, options catalog/enricher/TA
  services were running, ClickHouse pods were running, and `torghut-db-1` was running.
- Torghut `/db-check` returned `ok=true`, current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, one current head, and
  lineage-ready state with known parent-fork warnings.
- Torghut `/readyz` returned `status=degraded`: Postgres, ClickHouse, Alpaca, and schema were OK; live submission was
  blocked by `simple_submit_disabled`; capital stage was `shadow`.
- Alpha readiness reported three hypotheses, zero promotion eligible, and three rollback required. Dependency quorum
  blocked on `empirical_jobs_degraded`.
- Jangar quant health returned `ok=true`, latest metrics count `3780`, latest update within the current second, and no
  metrics lag. It also returned `runtimeEnabled=false` and `stageScopeOmitted=true` because account/window are required
  for scoped pipeline-health proof.
- Jangar market-context health returned `overallState=down`: technicals and regime were `error`, fundamentals and news
  were `missing`, provider configuration for fundamentals/news was false, and ClickHouse ingestion reported
  `CH_HOST is not configured`.
- The Jangar companion status route is healthy enough to consume Torghut proof, but its current dependency quorum can
  report healthy while market-context health is down. Torghut must therefore publish typed context proof, not rely on a
  coarse route-level status.

## Problem

Torghut currently knows enough to avoid live capital, but it does not turn market-context absence into a ranked repair
and shadow-capital routing contract.

Four gaps matter:

1. **Missing context is not a first-class negative asset.** Fundamentals and news can be missing, technicals and regime
   can error, and that evidence is visible but not priced by hypothesis or repair value.
2. **Quant metrics freshness is not stage proof.** A fresh latest-metrics store with `stageScopeOmitted=true` cannot
   prove a specific account/window/hypothesis lane is safe.
3. **Shadow capital lacks an evidence router.** Capital is correctly in shadow, but shadow experiments still need typed
   proof of context completeness, execution realism, route cost, and falsification triggers.
4. **Jangar cannot rank Torghut repair from route OK alone.** The control plane needs scoped negative evidence and repair
   dividends, not just `/readyz` degraded or quant health OK.

## Alternatives Considered

### Option A: Treat Market Context As Informational Only

Keep capital blocked by existing live-submission and empirical-job gates, but do not make market context a dedicated
proof ledger.

Pros:

- Lowest implementation cost.
- Avoids adding another proof object.
- Current gates already prevent live capital.

Cons:

- Does not rank which context repair matters most for profitability.
- Lets shadow experiments run with unknown context completeness.
- Forces Jangar to infer repair value from coarse health routes.

Decision: reject. Informational context is insufficient for a profit-seeking autonomous system.

### Option B: Block All Torghut Work Until Market Context Is Healthy

Fail closed on observe, repair, shadow, paper, and live capital whenever market context is down.

Pros:

- Simple and safe for capital.
- Easy to explain in deployment gates.
- Prevents accidental reliance on stale context.

Cons:

- Blocks the repair work needed to restore context.
- Turns an evidence gap into a platform freeze.
- Does not distinguish low-cost repair from risky capital.

Decision: reject. Capital should fail closed, but repair must remain possible and bounded.

### Option C: Market-Context Negative Evidence Ledger And Shadow Capital Router

Publish typed negative context evidence, rank repairs by expected proof lift and profit value, and route shadow capital
only through lanes with complete scoped proof.

Pros:

- Converts missing/error context into measurable repair candidates.
- Gives Jangar an action-class proof feed for `torghut_repair`, `torghut_paper_capital`, and `torghut_live_capital`.
- Keeps live capital closed while still allowing zero-notional repair.
- Forces scoped account/window proof before shadow or paper experiments are treated as meaningful.

Cons:

- Requires new proof schemas and route tests.
- Needs careful calibration so missing low-value context does not block unrelated repair.
- Adds another freshness clock that Jangar must reconcile.

Decision: select Option C.

## Chosen Architecture

### MarketContextNegativeEvidenceLedger

Torghut emits one ledger snapshot per symbol universe and proof window:

```text
market_context_negative_evidence
  ledger_id
  generated_at
  fresh_until
  universe_ref
  symbol_scope
  domain_states
  provider_states
  ingestion_states
  hypothesis_impacts
  repair_candidates
  evidence_refs
```

Each domain state carries `domain`, `state`, `freshness_seconds`, `max_freshness_seconds`, `quality_score`,
`risk_flags`, and `affected_hypotheses`. Provider and ingestion states must name whether the provider is unconfigured,
unreachable, stale, or returning low-quality data.

### ScopedQuantStageProof

Quant health must separate route freshness from scoped stage proof:

```text
scoped_quant_stage_proof
  proof_id
  generated_at
  fresh_until
  account
  window
  strategy_or_hypothesis_ref
  latest_metrics_count
  max_stage_lag_seconds
  stage_health
  omitted_scope
  evidence_refs
```

When `omitted_scope=true`, the proof can support `torghut_observe` only. It cannot support paper or live capital.

### ShadowCapitalRouter

The router maps hypotheses to action decisions:

```text
shadow_capital_route
  route_id
  hypothesis_ref
  account
  window
  action_class
  decision
  required_context_domains
  negative_evidence_refs
  quant_stage_proof_ref
  repair_candidate_ref
  expected_profit_evidence_lift
  rollback_trigger
```

Allowed decisions are:

- `torghut_observe`: allowed with route-level health and current schema.
- `torghut_repair`: allowed when a repair candidate names expected context/profit proof lift and bounded route cost.
- `torghut_paper_capital`: allowed only with scoped quant stage proof, market-context domains required by the hypothesis,
  nonzero execution realism, and no rollback-required hypothesis state.
- `torghut_live_capital`: blocked until all paper-capital gates are satisfied plus live submission is enabled and Jangar
  observed-action authority allows live capital.

### Repair Dividend

Market-context repair dividend is:

```text
expected_profit_evidence_lift
  + expected_capital_unlock_value
  - route_cost
  - stale_context_risk_cost
  - falsification_risk_cost
```

The dividend ranks zero-notional repair only. It is not permission to trade.

## Implementation Scope

Engineer stage:

- Add a deterministic ledger builder over the existing market-context health output.
- Add scoped quant stage proof output that refuses to promote unscoped `stageScopeOmitted=true` into capital proof.
- Add a shadow capital router that maps context domains and quant proof to action classes.
- Add tests for the current degraded state: technicals/regime error, fundamentals/news missing, ClickHouse ingestion
  unconfigured, quant route healthy but scoped stage omitted, and capital remaining blocked.
- Expose a low-cost route for Jangar consumption that returns ledger digest, top negative evidence, top repair
  candidates, and capital decisions without forcing the heavy status path.

Deployer stage:

- Verify the route answers within the declared route budget and does not require broker-trading permissions.
- Verify `torghut_observe` remains allowed, `torghut_repair` is ranked, and paper/live capital remain blocked under the
  current evidence.
- Verify Jangar observed-action authority consumes only scoped proof for paper/live capital.
- Under the plan-lane evidence above, verify the first shadow route classifies the four stale empirical jobs as repair
  candidates, treats options catalog `ready=true` plus `symbols=0` as negative evidence, and blocks both paper and live
  capital.

## Validation Gates

- Unit tests prove missing fundamentals/news and error technicals/regime create negative evidence with affected
  hypotheses.
- Unit tests prove `stageScopeOmitted=true` cannot satisfy paper or live capital proof.
- Unit tests prove options catalog `ready=true` with `last_success_ts=null` and `symbols=0` cannot satisfy options context
  proof.
- Unit tests prove a 72-hour runtime window with 8 rejected decisions, 0 executions, and 0 TCA samples blocks paper/live
  capital even when schema and broker connectivity are healthy.
- Unit tests prove a positive repair dividend can open `torghut_repair` while `torghut_live_capital` remains blocked.
- Runtime validation samples `/readyz`, `/db-check`, quant health with and without account/window, market-context health,
  and the new router route.
- Rollout validation confirms Jangar authority receipts cite Torghut ledger/proof IDs before allowing any Torghut repair
  or capital class.

## Rollout

1. Ship the ledger and scoped quant proof in shadow mode.
2. Publish the shadow capital route and compare it with existing readiness and profit-proof escrow decisions.
3. Allow Jangar to consume the route for `torghut_observe` and `torghut_repair` only.
4. Enable paper-capital decisions only after scoped quant proof is present for the active account/window and market
   context domains are healthy or explicitly waived by current evidence.
5. Do not enable live-capital decisions until live submission is enabled, execution/TCA samples are nonzero, and Jangar
   observed-action authority allows `torghut_live_capital`.

## Rollback

Disable Jangar consumption of the shadow capital router and fall back to existing Torghut `/readyz`, empirical-job, and
profit-proof escrow gates. Keep live capital blocked. If the ledger route is noisy or slow, keep it read-only for
diagnostics and remove it from action-class decisions until route budget and proof quality recover.

## Risks

- Context proof can become too conservative if every missing domain blocks every hypothesis. The router must map domains
  to affected hypotheses, not apply global punishment.
- Repair dividends can become optimistic without measured route cost. Route budget must be part of every candidate.
- Shadow capital can become a backdoor for risk if it is not tied to scoped account/window proof. Treat unscoped proof as
  observe-only.
- Jangar and Torghut clocks can drift. Every route decision must include `generated_at`, `fresh_until`, and a digest.

## Handoff

The next Torghut engineer should implement the market-context ledger first, then scoped quant proof, then the shadow
capital router. The first deployer gate is current-state parity: under today’s evidence, observe is allowed, repair is
ranked, paper/live capital are blocked, and Jangar can cite the ledger digest in observed-action authority without
calling privileged database or broker APIs.
