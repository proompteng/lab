# 56. Torghut Profit Clocks and Capital Allocation Auction (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`

Extends:

- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`

## Executive summary

The decision is to move Torghut from coarse gate payloads to durable **Profit Clocks** that feed a lane-aware
**Capital Allocation Auction** over the existing portfolio allocator. Jangar remains the issuer of typed capability
authority; Torghut remains the owner of hypothesis-level capital decisions.

The reason is concrete in the current live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns HTTP `503`
  - reports `schema_current=true`
  - reports `live_submission_gate.ok=false`
  - reports `quant_evidence.ok=false`
  - reports `quant_evidence.reason="quant_health_fetch_failed"`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns HTTP `200`
  - reports `active_capital_stage="shadow"`
  - reports `promotion_eligible_total=0`
  - reports `blocked_reasons` including `dependency_quorum_block`, `quant_health_fetch_failed`, and
    `empirical_jobs_not_ready`
  - still reports the quant-evidence source URL as `http://jangar.../api/agents/control-plane/status?...`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200`
  - reports `latestMetricsCount=36`
  - reports `metricsPipelineLagSeconds=5`
  - reports `maxStageLagSeconds=83911`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - returns HTTP `200`
  - reports `overallState="down"`
  - reports `bundleQualityScore=0.4525`
  - reports stale fundamentals and news plus technicals and regime errors
- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - reports `schema_current=true`
  - reports migration lineage warnings
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - reports one replica `up=0`
  - reports `last_scrape_success 0`
  - reports elevated freshness fallback counters
- `kubectl get pods -n torghut -o wide`
  - shows the core Torghut revision `Running`
  - shows both forecast pods not ready
  - shows the options plane outside the healthy core path

The tradeoff is stricter binding, more persistence, and explicit auction semantics. I am keeping that trade because
the current system is safe enough to block but not rigorous enough to decide how much capital healthy lanes deserve
when the rest of the portfolio is mixed.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. scheduler, `/readyz`, `/trading/status`, and submission logs share one durable `profit_clock_id`;
2. live-capital and canary-capital decisions are allocated through a lane-aware auction rather than one coarse global
   gate payload;
3. typed Jangar capability subjects are mandatory inputs for capital eligibility, with no generic fallback;
4. the design defines measurable profitability hypotheses, explicit guardrails, and testable rollout and rollback
   gates.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The current runtime is healthier than the earlier March states, but its capital truth is still too coarse.

- the core Torghut service is running and can answer `/trading/status`;
- readiness still fails closed, which is correct, but the failure is assembled from mixed local and upstream facts
  rather than one durable settled record;
- forecast remains degraded:
  - forecast pods repeatedly fail readiness with HTTP `503`
  - `empirical_jobs.status="degraded"` in `/readyz`
- quant evidence is available from Jangar through the typed endpoint but is not being consumed correctly by the live
  Torghut path;
- market-context and ClickHouse freshness are materially degraded.

Interpretation:

- Torghut has enough evidence to be selective;
- it still lacks the durable, lane-aware object that says which hypotheses may bid for capital right now and why.

### Source architecture and high-risk modules

The source tree shows why the current answer is still too coarse.

- `services/torghut/app/trading/submission_council.py`
  - centralizes gate evaluation;
  - `resolve_quant_health_url()` still falls back from `TRADING_JANGAR_QUANT_HEALTH_URL` to
    `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
  - gate truth is still emitted as an ephemeral payload rather than a durable settled object.
- `services/torghut/app/trading/hypotheses.py`
  - compiles per-hypothesis readiness;
  - drops most typed upstream provenance after reducing it to `decision`, `reasons`, and `message`.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - consumes in-process gate answers and `load_quant_evidence_status(...)`;
  - does not yet require a durable settlement or auction outcome id.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` reconstruct live gate truth independently of the scheduler path.
- `services/torghut/app/trading/portfolio.py`
  - already has deterministic budget and fragility logic;
  - does not yet price lane capability freshness or profit-clock confidence into its budget multipliers.

Current regression gaps:

- no regression proves generic control-plane status cannot satisfy typed quant-evidence authority;
- no regression proves scheduler, `/readyz`, and `/trading/status` share one durable `profit_clock_id`;
- no regression proves lane-local degradation can reduce capital for one lane without forcing the whole portfolio to
  shadow when shared safety rails remain healthy;
- no regression proves capital bids expire automatically when the required capability subjects become stale.

### Database, schema, freshness, and consistency evidence

Torghut already has enough persistence to support additive auction and profit-clock state.

- `/db-check` confirms the active head is `0025_widen_lean_shadow_parity_status`;
- lineage warnings remain for forked parents, so schema-current does not imply schema-simple;
- existing governance tables already include:
  - `strategy_hypotheses`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`
- direct SQL access is RBAC-forbidden for this worker;
- data freshness is mixed:
  - Jangar market-context is down
  - Jangar quant ingestion lag is very large even while latest metric materialization remains current
  - ClickHouse guardrail scrape success is currently `0`

Interpretation:

- Torghut does not need a wholesale schema reset;
- it needs a durable capital-decision object that binds existing persistence to fresh capability truth.

## Problem statement

Torghut still has five profitability-critical gaps:

1. it computes gate truth repeatedly instead of settling one durable profit-clock record;
2. it can still treat the wrong Jangar endpoint as a valid upstream authority surface;
3. its portfolio allocator does not know which lanes have fresh capability leases and which only have stale or
   degraded evidence;
4. scheduler, readiness, and status paths can still drift because they do not share one settled decision id;
5. healthy lanes cannot compete for limited canary or live capital under mixed portfolio conditions because the system
   still collapses too much truth into one answer.

That keeps the system conservative, but it also keeps profitability too dependent on coarse all-or-nothing control.

## Alternatives considered

### Option A: patch the existing submission council and keep one global gate

Summary:

- remove the obvious fallback bug;
- add more blocking reasons and counters to the current live gate payload.

Pros:

- smallest implementation delta;
- easy to explain.

Cons:

- preserves ephemeral truth;
- keeps route and scheduler drift possible;
- still cannot express how much capital a healthy lane deserves under mixed conditions.

Decision: rejected.

### Option B: move final capital decisions into Jangar

Summary:

- Jangar would emit final capital eligibility for each hypothesis and lane;
- Torghut would only execute those answers.

Pros:

- one top-level authority system;
- simpler operator story.

Cons:

- couples Jangar to Torghut-local strategy, confidence, and portfolio semantics;
- increases blast radius for infrastructure control-plane errors;
- slows future experimentation because every profit-model change becomes a Jangar change.

Decision: rejected.

### Option C: profit clocks plus capital allocation auction

Summary:

- Jangar emits typed authority capsules;
- Torghut settles those plus local evidence into durable profit clocks;
- the portfolio allocator runs a lane-aware auction over those clocks.

Pros:

- preserves clean ownership boundaries;
- turns wrong-endpoint usage into a structural contract violation;
- lets healthy lanes compete for capital without erasing shared safety rails;
- provides one durable id for scheduler, readiness, and status.

Cons:

- adds persistence and auction logic;
- requires staged cutover because existing gates dual-read during rollout;
- makes guardrail semantics stricter and more explicit.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle lane-local profit clocks from typed Jangar authority capsules and local trading evidence, then use
those clocks to drive a deterministic capital allocation auction over the existing portfolio allocator.

## Architecture

### 1. Profit-clock ledger

Add additive Torghut persistence:

- `profit_clock_snapshots`
  - `profit_clock_id`
  - `hypothesis_id`
  - `lane_id`
  - `strategy_id`
  - `account`
  - `capital_state` (`observe`, `canary`, `live`, `scale`, `quarantine`)
  - `confidence_score`
  - `expected_edge_bps`
  - `drawdown_guardrail_state`
  - `quant_capsule_subject`
  - `market_context_capsule_subject`
  - `required_capsule_digest`
  - `status` (`eligible`, `hold`, `block`, `expired`)
  - `observed_at`
  - `fresh_until`
  - `reasons_json`
  - `evidence_refs_json`
- `capital_auction_rounds`
  - `auction_round_id`
  - `account`
  - `started_at`
  - `finished_at`
  - `shared_guardrail_state`
  - `budget_notional`
  - `budget_multiplier`
  - `capacity_multiplier`
  - `winner_count`
  - `digest`
- `capital_auction_bids`
  - `auction_round_id`
  - `profit_clock_id`
  - `hypothesis_id`
  - `lane_id`
  - `requested_notional`
  - `awarded_notional`
  - `bid_score`
  - `decision`
  - `decision_reasons_json`

Rules:

- a profit clock is the only object allowed to tell the scheduler or status routes whether a hypothesis may leave
  observe mode;
- the clock expires when any required capsule subject or local evidence window exceeds its freshness budget;
- every auction round references the exact digest of upstream capability capsules it consumed.

### 2. Typed capability intake only

Torghut must stop inferring type from URL shape.

Required contract changes:

- `TRADING_JANGAR_QUANT_HEALTH_URL`
  - mandatory for quant-evidence authority once cutover is enabled;
  - may not fall back to `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`.
- `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`
  - valid only for coarse control-plane summary surfaces, never for quant evidence.
- market-context and options capability
  - must bind to explicit capsule subjects and digests, not route-local best effort.

Implementation consequence:

- `submission_council.py`, `scheduler/pipeline.py`, and `main.py` all consume the same typed upstream contract;
- a missing typed endpoint becomes `hold` or `block`, never silent substitution.

### 3. Capital allocation auction

Build on `services/torghut/app/trading/portfolio.py` instead of replacing it.

Auction inputs:

- profit-clock status and freshness;
- hypothesis confidence and expected edge;
- current fragility state and budget multipliers;
- lane capability requirements;
- shared market and execution guardrails;
- current account and symbol concentration usage.

Auction rules:

- only `eligible` clocks may bid;
- `observe` clocks cannot bid for live notional;
- `canary` and `live` bids are clipped by:
  - portfolio fragility,
  - current budget multipliers,
  - required capsule freshness,
  - lane-specific options or market-context capability state;
- if shared safety rails are blocked, the auction returns zero live awards and the portfolio remains in observe mode;
- if only lane-local capability is degraded, unaffected lanes may still win canary capital.

Initial scoring function:

- `bid_score = confidence_score * expected_edge_bps * freshness_factor * guardrail_factor * continuity_factor`

where:

- `freshness_factor` falls quickly when quant ingestion or market-context evidence ages;
- `guardrail_factor` is zero when a hard guardrail is breached;
- `continuity_factor` rewards stable recent windows and penalizes repeated falsification or deallocation.

### 4. Shared projection id

Require the same ids everywhere:

- scheduler decisions reference `profit_clock_id` and `auction_round_id`;
- `/readyz` returns the active `auction_round_id` and the highest-severity clock status;
- `/trading/status` returns the same ids plus per-lane winners and losers;
- audit logs and promotion evidence reference the same ids.

This is the key anti-drift invariant: no route or runtime path may emit a capital answer without naming the settled
clock and auction round that produced it.

### 5. Measurable trading hypotheses

The architecture must improve profitability, not just correctness.

Hypothesis H1: lane-local auctions increase useful capital utilization.

- Claim:
  healthy lanes can keep canary or live capital during mixed portfolio degradation without violating shared safety
  rails.
- Measure:
  `live_or_canary_capital_minutes / eligible_minutes` increases by at least `30%` over the current global-gate
  baseline for the same account and risk budget.
- Guardrail:
  zero shared safety rail breaches and no increase in portfolio drawdown beyond the configured cap.

Hypothesis H2: typed quant-health binding removes false upstream ambiguity.

- Claim:
  removing the generic Jangar fallback drives `quant_health_fetch_failed` caused by wrong-endpoint substitution to
  zero after cutover.
- Measure:
  post-cutover production windows show `0` generic-fallback quant authority resolutions and `0` route-shape-based
  misbindings.
- Guardrail:
  a missing typed endpoint must hold or block capital, never silently substitute.

Hypothesis H3: lane-local deallocation improves profit quality under stale-data events.

- Claim:
  explicit deallocation of only the affected lanes cuts portfolio-wide shadow time by at least `50%` during mixed
  dependency incidents without increasing slippage or drawdown failures.
- Measure:
  portfolio shadow minutes attributable to lane-local incidents drop by at least `50%`.
- Guardrail:
  slippage budget breaches and drawdown-triggered rollbacks do not rise above the current baseline.

### 6. Implementation scope

Engineer scope:

- `services/torghut/app/trading/submission_council.py`
  - remove generic quant-health fallback under the new binding contract;
  - settle profit-clock rows instead of only emitting ephemeral payloads.
- `services/torghut/app/trading/hypotheses.py`
  - preserve typed upstream capability provenance in runtime statuses.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - consume profit clocks and auction rounds rather than local ad hoc gate truth.
- `services/torghut/app/main.py`
  - expose `profit_clock_id` and `auction_round_id` in `/readyz` and `/trading/status`.
- `services/torghut/app/trading/portfolio.py`
  - accept auction- and lane-derived budget multipliers rather than only coarse runtime state.
- `services/torghut/tests/test_submission_council.py`
- `services/torghut/tests/test_trading_api.py`
- `services/torghut/tests/test_trading_pipeline.py`
  - add regression coverage for typed-binding enforcement, clock expiry, and auction parity.

Deployer scope:

- verify the typed quant-health binding is configured before enabling auction-derived capital movement;
- verify the same `profit_clock_id` and `auction_round_id` appear in readiness, trading status, and scheduler logs;
- verify lane-local degradation behaves as expected by intentionally observing forecast or options degradation with the
  rest of the portfolio still constrained but not globally misclassified.

### 7. Validation gates

Engineering gates:

1. generic control-plane status cannot satisfy typed quant-evidence authority once the cutover flag is on;
2. scheduler, `/readyz`, and `/trading/status` share one `profit_clock_id` for the same window;
3. auction rounds are deterministic for a fixed set of clocks and capability inputs;
4. a stale or blocked required capsule expires the corresponding clock and removes it from the auction.

Deployment gates:

1. typed Jangar capability subjects are reachable and fresh;
2. at least one canary auction round completes with expected ids and no contract drift;
3. portfolio allocator outputs reflect auction-derived multipliers;
4. no non-observe capital is awarded when shared safety rails are blocked.

### 8. Rollout plan

1. Add profit-clock and auction tables in additive migrations.
2. Dual-write clocks while the old live gate remains the decision authority.
3. Expose `profit_clock_id` and `auction_round_id` in status routes.
4. Turn on typed-binding enforcement for quant-health.
5. Shift scheduler capital decisions to auction winners.
6. Remove the old generic-fallback capital path once the ids and results stay stable through rollout windows.

### 9. Rollback plan

Rollback is staged and non-destructive.

- keep profit-clock and auction tables additive;
- if auction scoring regresses, revert to the previous allocator input path while continuing to write clock rows for
  diagnosis;
- if typed-binding enforcement causes unexpected holds, revert to dual-read mode temporarily but keep the fallback
  visible in telemetry;
- do not delete historical clock or auction rows during rollback.

## Risks and open questions

- Auction scoring can become too complex and hard to reason about.
  - Mitigation: start with a deterministic, simple scoring function and preserve raw inputs in every round.
- Lane-local auctions can hide a shared safety problem if shared subjects are misclassified.
  - Mitigation: shared safety rails remain hard vetoes before any lane bids are evaluated.
- Stricter typed-binding enforcement may initially increase `hold` states.
  - Mitigation: staged rollout and explicit telemetry on missing typed inputs.

## Handoff contract for engineer and deployer

Engineer acceptance gates:

1. New profit-clock and auction tables are additive only.
2. `submission_council.py`, scheduler, `/readyz`, and `/trading/status` share one `profit_clock_id`.
3. Generic control-plane fallback is disallowed for typed quant-health authority under the cutover flag.
4. Regression tests cover:
   - typed-binding enforcement,
   - clock expiry on stale upstream capsules,
   - auction determinism,
   - lane-local degradation without improper portfolio-wide live awards.

Deployer acceptance gates:

1. Typed Jangar capability subjects are fresh and discoverable before enabling auction-driven capital.
2. Status routes and scheduler logs expose matching `profit_clock_id` and `auction_round_id`.
3. A forecast or options degradation event reduces only the affected lanes unless shared safety rails are blocked.
4. Rollback remains a configuration or code revert, never destructive data cleanup.
