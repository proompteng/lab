# 73. Torghut Profit Evidence Clock and Capital Veto Contract (2026-05-05)

Status: Ready for implementation

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Executive Summary

The decision is to make live capital depend on a **Profit Evidence Clock**. A Torghut route can be alive, its database
schema can be current, and Alpaca can be reachable, but non-observe capital must still be blocked when the Jangar
control-plane clock is unknown, required market-context domains are stale, or hypotheses are rollback-required.

The live evidence on `2026-05-05` supports this directly:

- `GET /healthz` returned `ok`;
- `GET /db-check` returned `ok=true`, expected Alembic head `0029_whitepaper_embedding_dimension_4096`, and
  `schema_graph_lineage_ready=true`;
- `GET /trading/health` returned Postgres and ClickHouse `ok=true`, Alpaca `broker_ok`, and
  `live_submission_gate.allowed=true`;
- the same response reported `dependency_quorum.decision="unknown"`, `hypotheses_total=3`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`;
- `GET /readyz` returned HTTP `503`;
- `GET /trading/status` returned HTTP `504`;
- Jangar market-context health for `NVDA` reported degraded state with stale technicals, fundamentals, news, and
  regime domains;
- the Torghut namespace had a simulation revision in `ImagePullBackOff` from a platform-manifest mismatch.

I am not treating this as a simple readiness bug. The system is telling us that connectivity and schema are healthy
while profitability authority is not. That is exactly why Torghut needs a capital veto that is stricter than liveness.

## Success Criteria

This contract is done when:

1. `/readyz`, `/trading/health`, `/trading/status`, the scheduler, and Jangar quant-health routes use the same
   lane-local capital decision;
2. non-observe capital requires a fresh Jangar evidence-clock summary from the companion Jangar contract;
3. any hypothesis with `rollback_required=true` or no promotion eligibility is capped at observe or shadow;
4. stale market-context domains block only strategies that depend on those domains, rather than poisoning unrelated
   lanes;
5. every capital decision records the hypothesis id, account, lane, data clock ids, profit window, decision, expiry,
   and rollback reason;
6. deployer rollback can return all lanes to observe without deleting evidence.

## Current State Evidence

### Cluster and Rollout

- Live Torghut serving pod `torghut-00201` became ready after the prior `torghut-00200` revision failed.
- `torghut-sim-00280` had one ready pod and one `ImagePullBackOff` pod because the image digest did not have a matching
  platform manifest on one node.
- ClickHouse, Keeper, Torghut Postgres, TA task managers, websocket forwarder, guardrails exporters, and the live
  Torghut pod were running.
- Read-only access could not list deployments or Knative Services in the namespace, so rollout verification must use
  namespaced pod/events evidence plus Torghut and Jangar typed status routes unless deployer credentials provide more.

### Source Architecture

Important source surfaces:

- `services/torghut/app/trading/autonomy/evidence.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/discovery/promotion_contract.py`
- `services/torghut/app/trading/feature_quality.py`
- `services/torghut/app/trading/market_context.py`
- `services/torghut/app/trading/execution_policy.py`
- `services/jangar/src/server/torghut-quant-metrics.ts`
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`

Torghut already has the ingredients for profit authority: hypotheses, replay evidence, policy checks, feature quality,
runtime closure, execution policy, and Jangar integration. The gap is composition. The same live system can say
`capital_stage="live"` while dependency quorum is unknown and all hypotheses require rollback. That is a policy
composition failure, not a lack of raw signals.

Test coverage is broad under `services/torghut/tests`, including policy, profitability, feature quality, scheduler,
autonomy, execution, and readiness checks. The missing tests are cross-route parity tests and capital-veto tests for
the exact contradiction observed here.

### Database, Schema, and Freshness

Schema health is acceptable:

- current Alembic head: `0029_whitepaper_embedding_dimension_4096`;
- expected Alembic head: `0029_whitepaper_embedding_dimension_4096`;
- lineage ready: `true`;
- duplicate revisions: none;
- orphan parents: none.

Schema warnings remain relevant:

- parent forks were reported around `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`;
- account-scope checks were bypassed because multi-account trading is disabled.

Freshness is not acceptable for live-capital inference:

- market-context bundle freshness was over twelve hours for technicals/regime and much older for fundamentals/news;
- domain states for technicals, fundamentals, news, and regime were stale;
- `promotion_eligible_total=0`;
- `rollback_required_total=3`;
- Jangar dependency quorum was unknown because status fetch failed from Torghut's point of view.

## Problem Statement

Torghut still has a route-time optimism gap. Health endpoints prove connectivity, schema lineage, and broker reachability,
but live-capital language can survive stale market data, unknown Jangar dependency quorum, and non-promotable
hypotheses.

That gap creates three expensive failure modes:

1. a live submission path can remain apparently allowed while no hypothesis is eligible for promotion;
2. stale market context can be treated as a generic warning rather than a lane-specific capital veto;
3. simulation or execution rollout failures can be separated from capital decisions, even when the affected strategy
   depends on that execution lane.

## Alternatives Considered

### Option A: Freeze All Live Capital on Any Unknown Dependency

Make any unknown Jangar status, stale data domain, or rollout warning force all lanes into observe.

Pros:

- safest immediate operational posture;
- simple to implement;
- easy to explain during incidents.

Cons:

- prevents useful shadow and probe evidence collection;
- collapses independent lanes into one global answer;
- makes stale-but-unrelated domains block strategies that do not depend on them;
- reduces profitability by overusing global freezes.

Decision: rejected as the long-term architecture.

### Option B: Focus Only on New Autoresearch Profit Generation

Continue building the whitepaper autoresearch and strategy-factory loop, then revisit live-capital controls after new
candidates are stronger.

Pros:

- improves upside;
- builds on the v6.71 `$500/day` portfolio-candidate program;
- avoids blocking research velocity.

Cons:

- does not prevent new profitable candidates from entering the same weak capital gate;
- lets live-capital contradiction persist;
- treats profitability as strategy discovery only, not execution discipline.

Decision: rejected for this stage.

### Option C: Add Lane-Local Profit Evidence Clocks and Capital Vetoes

Each hypothesis/account/lane receives a durable clock that composes Jangar authority, market-data freshness, feature
quality, replay/profit evidence, execution readiness, schema health, and policy state. Capital movement consumes the
clock decision.

Pros:

- preserves shadow/probe learning without allowing unsafe live promotion;
- lets unrelated lanes continue when a stale domain does not affect them;
- makes profit authority auditable and replayable;
- integrates directly with the Jangar Evidence Clock Arbiter.

Cons:

- requires a stricter policy model and route parity work;
- needs careful defaults for missing or stale clocks;
- may temporarily reduce live opportunity until evidence quality improves.

Decision: selected.

## Decision

Implement Profit Evidence Clocks and use them as the only authority for non-observe capital.

The capital decision vocabulary is:

- `observe`: no live order placement; evidence collection only;
- `shadow`: simulated or paper-only behavior with no production capital;
- `probe`: small, explicitly leased capital for freshness or execution repair experiments;
- `live`: bounded live capital for hypotheses with fresh evidence and no rollback blockers;
- `scale`: expanded capital after multiple fresh profit windows;
- `quarantine`: forced deallocation because a required clock expired, contradicted, or falsified the hypothesis.

## Target Model

Add or project the following durable contract:

```text
torghut_profit_evidence_clocks
  clock_id
  hypothesis_id
  account
  lane
  strategy_family
  jangar_clock_id
  market_context_clock_ids
  feature_quality_clock_ids
  execution_clock_id
  schema_clock_id
  profit_window_id
  observed_at
  fresh_until
  decision                  # observe, shadow, probe, live, scale, quarantine
  max_capital_stage
  promotion_eligible
  rollback_required
  reason_codes
  evidence_digest

torghut_capital_vetoes
  veto_id
  clock_id
  requested_stage
  allowed_stage
  reason_codes
  evaluated_at
  expires_at
```

Required clock inputs:

- Jangar evidence-clock summary from `/api/agents/control-plane/status?namespace=agents`;
- Torghut schema lineage and migration head from `/db-check`;
- market-context freshness by domain and symbol universe;
- ClickHouse/TA freshness for strategies that require technicals or regime;
- hypothesis state, promotion eligibility, and rollback state;
- replay/profit window evidence including post-cost PnL, drawdown, capacity, and staleness;
- execution readiness including image/revision health and TCA readiness;
- broker/account status and account-scope mode.

## Measurable Trading Hypotheses

This architecture must produce measurable profitability experiments, not only safer operations.

### H1: Freshness-Gated Market Context Improves Post-Cost Selection

Hypothesis: strategies that require technicals, news, or regime produce better post-cost outcomes when entries are
blocked after domain freshness expiry and reopened only after fresh domain clocks return.

Measurement:

- compare replay and paper windows with and without domain-specific freshness vetoes;
- target: higher median post-cost PnL per trade and lower worst-day loss after costs;
- guardrail: no lane can claim improvement if trade count falls below the minimum sample threshold.

### H2: Jangar Authority Unknown Should Allow Shadow Learning but Not Live Capital

Hypothesis: unknown Jangar control-plane state is still useful for simulation and shadow evidence, but it should reduce
expected live profitability because execution coordination is not provable.

Measurement:

- run matched shadow windows when Jangar clock is `allow` versus `unknown` or `delay`;
- target: no live capital allocation during unknown windows, while preserving shadow data collection;
- guardrail: promotion from an unknown window is invalid unless replayed against a fresh `allow` clock.

### H3: Execution-Revision Failures Are Profit-Relevant, Not Only Deployment-Relevant

Hypothesis: image/platform mismatch and revision readiness failures correlate with worse execution quality or missed
opportunity in affected lanes.

Measurement:

- record execution clock state alongside simulated and paper TCA;
- target: quarantine or observe affected lanes when revision or platform clocks are stale or failed;
- guardrail: a strategy cannot scale if its execution lane had unresolved ImagePullBackOff, readiness, or TCA clocks
  during the evidence window.

## Implementation Scope

Engineer stage should implement five slices.

1. Capital-decision parity.
   - Factor one shared `resolve_capital_decision(...)` used by `/readyz`, `/trading/health`, `/trading/status`, the
     scheduler, and Jangar-facing health routes.
   - Add tests for the current contradiction: live submission cannot be `live` when
     `promotion_eligible_total=0` and `rollback_required_total>0`.

2. Jangar clock consumption.
   - Consume the companion Jangar evidence-clock summary.
   - Treat missing or unknown Jangar promotion clocks as `observe` or `shadow`, never `live` or `scale`.

3. Domain-scoped freshness.
   - Convert market-context freshness into lane requirements.
   - Block only strategies that require stale domains.
   - Preserve unrelated shadow/probe lanes when safe.

4. Durable evidence clocks.
   - Persist or project clock ids, expiry, digest, decision, and reason codes.
   - Add retention and summary routes for operator audit.

5. Profit experiments.
   - Run H1, H2, and H3 as replay or paper windows.
   - Store post-cost outcomes and falsification events in the evidence ledger.

## Validation Gates

Local validation:

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && uv run --frozen pytest tests/test_verify_quant_readiness.py tests/test_trading_scheduler_safety.py tests/test_feature_quality.py`
- `bun --cwd services/jangar run test -- src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`

Required new tests:

- capital decision clamps to observe/shadow when Jangar promotion clock is unknown;
- live is impossible when all hypotheses are rollback-required;
- stale domain clocks block only dependent lanes;
- `/readyz`, `/trading/health`, `/trading/status`, scheduler, and Jangar quant health return the same capital decision
  id for a shared fixture;
- execution-revision failures create a capital veto for affected lanes.

Cluster validation:

- `GET /db-check` remains `ok=true`;
- `GET /readyz` names the same capital decision id as `/trading/health`;
- `GET /trading/status` responds within the configured SLO and names the same decision id;
- Jangar market-context health for the traded universe is fresh for required domains;
- Jangar control-plane status returns an `allow` promotion clock before live or scale;
- no affected execution lane has unresolved `ImagePullBackOff` or readiness failures.

Profit validation:

- every promoted hypothesis has at least one fresh profit window after costs;
- all promoted windows cite data, Jangar, schema, and execution clock ids;
- promotion evidence includes drawdown, capacity, slippage/TCA, active-day ratio, and worst-day loss;
- a stale or contradicted clock creates a falsification event and deallocates the lane before the next order.

## Rollout Plan

1. Implement parity in advisory mode and log differences between existing route answers and the new shared decision.
2. Enable evidence-clock projection for observe/shadow only.
3. Clamp live/scale to observe when Jangar promotion clock is missing or unknown.
4. Enable domain-scoped freshness vetoes for technicals and regime first, then fundamentals/news.
5. Enable execution-revision vetoes for affected lanes.
6. Allow live or scale only after the three measurable hypotheses have replay or paper evidence and all validation
   gates pass.

## Rollback Plan

- Set the capital decision mode back to advisory while preserving evidence writes.
- Force all lanes to observe with one operator flag if route parity fails.
- Keep schema and clock rows; do not delete evidence during rollback.
- Disable only the newest veto class if a domain-scoped veto is too broad.
- Re-run `/db-check`, `/trading/health`, `/trading/status`, and Jangar quant health after rollback to prove route
  parity returned.

## Risks and Open Questions

- The first live rollout may reduce order count because stale domains and unknown Jangar clocks become hard blockers.
  That is acceptable if shadow evidence continues.
- Multi-account checks are currently bypassed when multi-account trading is disabled. The clock schema must include
  `account` from the start so enabling multi-account later is not a migration surprise.
- Parent-fork lineage warnings are not blockers today, but they should remain visible in schema clocks because they can
  hide future migration ambiguity.
- Profit windows must avoid expensive raw queries. Use existing replay bundles, summarized ClickHouse views, and bounded
  query firebreaks from the prior v6 contracts.

## Handoff to Engineer

Start with route parity and capital-decision tests. The first acceptance gate is not a new strategy; it is making the
current contradiction impossible: no route may say live capital is allowed when dependency quorum is unknown and all
hypotheses are rollback-required.

## Handoff to Deployer

Deploy advisory mode first. Do not allow live or scale capital until `/readyz`, `/trading/health`, `/trading/status`,
and Jangar quant health cite the same capital decision id and Jangar promotion clocks are fresh.
