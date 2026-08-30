# 180. Torghut Dependency-Priced Capital Frontier And Session Reentry (2026-05-08)

Status: Accepted for engineer and deployer handoff

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


## Decision

I am selecting a **dependency-priced capital frontier with session reentry** for Torghut.

The current Torghut system can observe and compute. It cannot safely promote capital. On 2026-05-08 at 03:11Z,
`/healthz` returned HTTP 200, while `/readyz` and `/trading/health` returned HTTP 503 with `status=degraded`.
Postgres, ClickHouse, Alpaca, database lineage, universe, empirical jobs, and scheduler state were healthy. The capital
surface was correctly held: `live_submission_gate.allowed=false` because `simple_submit_disabled`, proof floor was
`repair_only`, capital state was `zero_notional`, alpha readiness had 3 hypotheses, 0 promotion-eligible hypotheses,
and 3 rollback-required hypotheses.

The new evidence changes the next design step. Earlier work focused on route-yield repair. Route repair is still
necessary, but it is not sufficient when Jangar itself can be in a zero-pod brownout and account/window quant health
returns `degraded` with `latestMetricsCount=0`. Market context was also degraded: bundle freshness was about
2309 seconds, technicals and regime were stale by hours, and news exceeded the 300 second freshness target. Direct
database reads showed 147623 trade decisions, 13778 executions, 13775 TCA rows, 24 completed empirical runs, and a
ClickHouse cursor at `2026-05-07T20:55:01Z`. TCA was recomputed at `2026-05-08T02:42Z`, but executions themselves
last updated on `2026-04-03`, and hypothesis windows ended at `2026-05-06T18:01Z`.

The decision is to price every capital decision by dependency state before route yield. Torghut should not ask "which
symbol has the best repair candidate?" first. It should ask "which dependency-priced action is admissible this
session?" The frontier assigns a cost to Jangar availability, scoped quant latest-store health, market context,
empirical evidence, alpha readiness, route/TCA proof, and submission toggles. It then returns the highest action that
can run without violating capital guardrails: observe, zero-notional repair, paper shadow sample, paper probe, live
micro, or live scale.

The tradeoff is that even a promising symbol like AAPL stays below paper capital when Jangar is unavailable, quant
latest-store evidence is empty, or alpha rollback is active. I accept that. Profitability comes from paying for the
right evidence in the right order, not from promoting the least-bad route while dependency truth is unsettled.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster Evidence

- Torghut live revision `torghut-00292` and sim revision `torghut-sim-00391` were running.
- Torghut deploys were under active churn: old live and sim Knative revisions were scaled to zero, the current live and
  sim revisions were `1/1`, and events showed probe failures during startup.
- Current Torghut events included readiness and liveness timeouts on `torghut-00292`, repeated
  `MultiplePodDisruptionBudgets` warnings for ClickHouse pods, and a keeper PDB with no matching pods.
- `torghut-db-migrations` was running during the first pod listing and later logged that the app database and postgres
  superuser database were ready; `/db-check` remained schema-current.
- A `torghut-whitepaper-autoresearch-profit-target` pod was retained in `Error`, and its container logs were no longer
  retrievable from containerd.
- Jangar was not available during the refreshed pass: `deployment/jangar` had desired replicas but zero total and zero
  available pods, and Jangar service calls returned HTTP `000`. A later follow-up showed it recovered to `1/1`, Argo CD
  `Synced/Healthy`, and `/health` HTTP 200, so this was a transient rollout brownout rather than a permanent outage.
- NATS had three ready broker pods, so live coordination was available even while Jangar serving was not.

### Runtime Evidence

- `/healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/readyz` returned HTTP 503 with `status=degraded`; dependencies for Postgres, ClickHouse, Alpaca, database,
  universe, empirical jobs, scheduler, and quant evidence were readable.
- `/trading/health` returned HTTP 503 with the same capital state: live submission disabled, proof floor `repair_only`,
  and zero notional.
- `/trading/status` returned HTTP 200 and confirmed `TRADING_MODE=live`, `TRADING_STRATEGY_RUNTIME_MODE=scheduler_v3`,
  live submit disabled, autonomy disabled, and kill switch disabled.
- The live submission gate blocked on `simple_submit_disabled`.
- The proof floor blocked on `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- Jangar account/window quant health returned HTTP 200 but `status=degraded` and `latestMetricsCount=0` for
  `account=paper&window=15m`.
- Jangar market-context health returned HTTP 200 but `overallState=degraded`, bundle freshness about 2309 seconds, and
  quality score 0.6825. Technicals, news, and regime were stale.

### Database And Data Evidence

- Direct Torghut Postgres queries used the named `torghut-db-app` secret and a read-only transaction.
- Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` had 147623 rows. Status counts were 69909 rejected, 63569 blocked, 13555 filled, 370 planned,
  217 canceled, and 3 expired. The newest decision row was `2026-05-06T17:44:19Z`; the newest executed decision was
  `2026-04-02T20:59:45Z`.
- `executions` had 13778 rows. The newest execution was created on `2026-04-02T20:59:45Z` and last updated on
  `2026-04-03T05:32:38Z`.
- `execution_tca_metrics` had 13775 rows across 12 symbols. The newest TCA computation was
  `2026-05-08T02:42:07Z`; average absolute slippage was about 13.76 bps.
- The largest TCA samples were NVDA 3289 rows at 13.4759 bps, MSFT 2704 rows at 9.5918 bps, AAPL 2033 rows at
  9.2512 bps, META 1716 rows at 12.9716 bps, AVGO 1123 rows at 21.8583 bps, GOOG 964 rows at 11.0983 bps, AMD 823
  rows at 14.9333 bps, MU 521 rows at 32.9352 bps, PLTR 458 rows at 19.7510 bps, and INTC 66 rows at 20.5711 bps.
- `vnext_empirical_job_runs` had 24 completed rows, newest at `2026-05-07T21:27:18Z`.
- `strategy_hypothesis_metric_windows` had 3 rows, all `shadow`, with newest window ending `2026-05-06T18:01:00Z`.
- `strategy_promotion_decisions` had one `shadow:false` decision from `2026-05-06T22:34:19Z`.
- `trade_cursor` for ClickHouse account `PA3SX7FYNUTF` was at `2026-05-07T20:55:01Z` and updated at
  `2026-05-07T20:58:10Z`.
- ClickHouse had 1748247 `ta_microbars` rows and 1157622 `ta_signals` rows, both with max timestamp
  `2026-05-07T20:55:01Z`.
- ClickHouse did not expose `market_context_bundles`, `ta_market_context`, `quant_latest_metrics`,
  `torghut_quant_latest_metrics`, `trade_updates`, or `order_updates` tables in the `torghut` database.

### Source Evidence

- `services/torghut/app/main.py` has 4237 lines and already combines readiness, proof floor, route reacquisition,
  alpha readiness, quant evidence, market context, and trading status.
- `services/torghut/app/trading/proof_floor.py` has 718 lines and already fails closed on live submit disabled, alpha
  readiness gaps, route universe gaps, quant/TCA evidence, and slippage breaches.
- `services/torghut/app/trading/route_reacquisition.py` has 374 lines and already builds repair candidates from proof
  floor dimensions.
- `services/torghut/app/trading/jangar_continuity.py` has 223 lines and is the right integration path for the Jangar
  availability lease.
- `services/torghut/app/trading/hypotheses.py` has 791 lines and already compiles hypothesis readiness, dependency
  quorum, and capital stage.
- Tests already cover proof floor, route reacquisition, Jangar continuity, market context, TCA adaptive policy,
  trading API, and readiness verifiers. The new work should add a pure dependency-pricing reducer test rather than
  expanding `main.py`.

## Problem

Torghut has enough evidence to explain a capital hold. It still lacks a single dependency-priced action frontier for
the next trading session.

The current failure modes are:

1. Operational dependencies can be healthy while the capital surface is correctly zero-notional.
2. TCA can be freshly recomputed from old executions, which is useful for route repair but not proof of current
   executable edge.
3. Empirical jobs can be fresh while alpha readiness has no promotion-eligible hypothesis.
4. Jangar quant health can be reachable but scoped latest-store evidence can be empty.
5. Market context can have acceptable aggregate quality while technicals, news, and regime are stale for intraday
   action.
6. Jangar can be in a serving brownout while Torghut stays reachable, making upstream authority a capital dependency.

The system needs to answer one operational question before every session: what is the highest capital action we can
take without crossing an unsettled dependency?

## Alternatives Considered

### Option A: Route-First Paper Probe

Use the strongest near-threshold routes, especially AAPL and MSFT, to drive the next paper probe once live submission
is intentionally enabled for paper-like execution.

Advantages:

- Easy to explain.
- Uses large TCA samples.
- Targets measurable slippage improvements.

Disadvantages:

- Ignores Jangar brownout authority.
- Ignores empty scoped quant latest-store evidence.
- Leaves market-context freshness and alpha rollback as post-hoc blockers.
- AAPL and MSFT are still above the strict 8 bps paper threshold.

Decision: reject as the primary architecture. Route candidates are inputs to the frontier, not the frontier itself.

### Option B: Dependency Freeze Until Everything Is Green

Keep all capital at zero until Jangar, quant health, market context, empirical jobs, alpha readiness, route/TCA, and
submission toggles are all green.

Advantages:

- Strong safety posture.
- Simple deployer rule.
- Reduces accidental promotion during brownout.

Disadvantages:

- Blocks zero-notional repair that would make the system profitable.
- Treats a missing quant latest-store table and a 20 bps route as the same kind of failure.
- Does not rank the next evidence purchase.

Decision: reject as the steady state. Keep freeze for emergency mode, not normal profit repair.

### Option C: Dependency-Priced Capital Frontier And Session Reentry

Score the next action by dependency price. Each dependency contributes an explicit hold, discount, or unlock value.
The frontier then selects observe, zero-notional repair, paper shadow sample, paper probe, live micro, or live scale.

Advantages:

- Converts mixed health into a capital decision.
- Allows debt-reducing repair while keeping paper/live blocked.
- Separates old route evidence from current session authority.
- Makes Jangar brownout a first-class capital input.
- Produces acceptance gates that engineers and deployers can test.

Disadvantages:

- Adds another reducer and payload to an already large trading status surface.
- Requires calibration so scores remain understandable.
- Slower than a direct AAPL paper canary.

Decision: select Option C.

## Architecture

Torghut adds a pure `dependency_priced_capital_frontier` reducer. It consumes:

- Jangar `control_plane_availability_lease`
- Jangar account/window quant health
- market-context health
- proof floor
- route reacquisition board
- TCA metrics
- empirical job freshness
- alpha readiness
- submission toggles
- market session state

The output is versioned as `torghut.dependency-priced-capital-frontier.v1`.

```text
dependency_price_card
  dependency_id
  dependency_class          # jangar_availability | quant_latest_store | market_context | empirical | alpha | route_tca | submission_toggle | session
  state                     # pass | discount | hold | block
  observed_at
  freshness_seconds
  threshold_seconds
  evidence_ref
  capital_effect            # none | observe_only | zero_notional_only | paper_hold | live_hold | full_block
  repair_value
  repair_cost
  owner
```

```text
session_reentry_frontier
  frontier_id
  generated_at
  account_label
  session_ref
  jangar_lease_ref
  proof_floor_ref
  highest_allowed_action    # observe | zero_notional_repair | paper_shadow_sample | paper_probe | live_micro | live_scale
  dependency_prices
  route_candidates
  hypothesis_candidates
  held_capital_classes
  next_repair_action
  rollback_target
```

Default capital rules:

- `observe` is allowed when Torghut healthz and database projections are readable.
- `zero_notional_repair` is allowed when dependencies are degraded but the repair names the debt it retires.
- `paper_shadow_sample` requires Jangar lease `serve` or `brownout` with `torghut_observe=allow`, quant latest-store
  evidence present for the account/window, and no live submission.
- `paper_probe` requires Jangar lease `serve`, scoped quant latest-store count greater than zero, market context fresh
  for technicals and regime, empirical job freshness under 24 hours, at least one promotion-eligible hypothesis, zero
  rollback-required hypotheses for the target, and route slippage below 8 bps.
- `live_micro` requires prior paper settlement, explicit live submit enablement, no proof-floor blockers, route
  slippage below 12 bps, and Jangar `live_micro` action escrow `allow`.
- `live_scale` requires repeated live micro settlement, no active market-context or quant freshness debt, and Jangar
  `live_scale` action escrow `allow`.

## Measurable Trading Hypotheses

Hypothesis 1: near-threshold mega-cap route repair can unlock paper candidates.

- Starting candidates: AAPL at 9.2512 bps and MSFT at 9.5918 bps average absolute slippage.
- Target: reduce average absolute slippage below 8 bps over at least 100 fresh route samples per symbol.
- Guardrail: no paper action if Jangar lease is not `serve`, scoped quant latest-store count is zero, or target alpha
  rollback is required.

Hypothesis 2: high-volume blocked routes can be repaired by route-specific execution policy before alpha changes.

- Starting candidates: NVDA 3289 rows at 13.4759 bps, AMD 823 at 14.9333 bps, AVGO 1123 at 21.8583 bps, and INTC 66
  at 20.5711 bps.
- Target: reduce slippage by at least 30 percent in zero-notional or paper-shadow samples before paper probe.
- Guardrail: if slippage remains above 12 bps after two repair packets, stop buying samples and shift to alpha or
  venue assumptions.

Hypothesis 3: scoped quant latest-store health predicts readiness better than broad ClickHouse freshness.

- Starting state: `ta_signals` and `ta_microbars` were fresh to `2026-05-07T20:55:01Z`, but Jangar scoped
  `account=paper&window=15m` quant health returned `latestMetricsCount=0`.
- Target: latest-store count greater than zero and pipeline lag under 15 seconds during an open session.
- Guardrail: if scoped quant health is empty, all paper/live actions hold even when ClickHouse source tables are
  populated.

Hypothesis 4: market-context freshness must be domain-priced for intraday trading.

- Starting state: aggregate quality was 0.6825, but technicals, news, and regime were stale.
- Target: technicals and regime fresh under 120 seconds, news fresh under 300 seconds or explicitly discounted for a
  no-news route.
- Guardrail: stale technicals or regime cap action at zero-notional repair for intraday routes.

## Implementation Scope

Engineer scope:

- Add `services/torghut/app/trading/dependency_priced_capital_frontier.py` as a pure reducer.
- Add `services/torghut/tests/test_dependency_priced_capital_frontier.py`.
- Integrate the reducer into `/trading/status` and `/trading/health` as an additive payload only after tests pass.
- Consume Jangar availability lease through `jangar_continuity.py`; if the lease is missing or stale, set
  `jangar_availability` to `hold` or `block` based on age and HTTP status.
- Keep proof floor as the hard safety gate. The frontier ranks actions; it does not bypass proof-floor blockers.
- Add a readiness verifier assertion that paper/live actions are impossible when `latestMetricsCount=0` or Jangar
  lease is missing.

Deployer scope:

- Shadow the frontier for one full market session before enforcement.
- Do not enable paper or live capital from this design until Jangar availability lease enforcement is active.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` until `paper_probe` gates pass and a separate deploy approval names the
  target symbol, account, max notional, and rollback target.
- Preserve current `/readyz` behavior: degraded capital state should keep HTTP 503 until the proof floor and frontier
  both allow a capital action.

## Validation Gates

The implementation is not complete until all gates pass:

- Unit tests cover Jangar outage, Jangar brownout, empty quant latest store, stale market context, fresh empirical
  evidence with alpha rollback, near-threshold route repair, route slippage breach, and live submit disabled.
- `/trading/status` exposes `dependency_priced_capital_frontier.highest_allowed_action=zero_notional_repair` for the
  2026-05-08 evidence fixture.
- `/trading/health` remains HTTP 503 when the highest allowed action is below `paper_probe`.
- A fixture with Jangar lease `serve`, scoped quant metrics count greater than zero, fresh market context, one
  promotion-eligible hypothesis, no rollback-required hypotheses, and AAPL slippage below 8 bps returns
  `paper_probe`.
- A fixture with live submit enabled but Jangar `live_micro` escrow held returns `paper_probe` at most.
- `uv run --frozen pytest services/torghut/tests/test_dependency_priced_capital_frontier.py` passes in the Torghut
  environment.
- Existing `test_profitability_proof_floor.py`, `test_route_reacquisition.py`, `test_jangar_continuity.py`, and
  `test_trading_api.py` continue to pass.

## Rollout Plan

Phase 0 is this architecture handoff.

Phase 1 adds the reducer and tests. The payload is generated only in local tests and a debug helper.

Phase 2 exposes the frontier on `/trading/status` behind an additive feature flag. No readiness or capital behavior
changes.

Phase 3 shadows the frontier through one market session and compares it with proof floor, alpha readiness, and Jangar
availability lease decisions.

Phase 4 lets zero-notional repair jobs consume the frontier. Paper/live remain disabled.

Phase 5 allows a paper-shadow sample for a named symbol only after Jangar availability, scoped quant health, market
context, empirical, alpha, and route gates all pass.

Phase 6 considers paper probe. Live micro and live scale are explicitly out of scope until paper settlement is recorded
and reviewed.

## Rollback Plan

- Disable exposure with `TRADING_DEPENDENCY_PRICED_FRONTIER_ENABLED=false`.
- Keep proof floor, live submission gate, and kill switch behavior unchanged.
- If the frontier emits an unexpected paper/live action, force `highest_allowed_action=zero_notional_repair` and hold
  capital until the fixture is added as a regression test.
- If Jangar availability lease is missing, stale, or HTTP `000`, downgrade to zero-notional repair regardless of route
  score.
- If market-context or quant latest-store freshness cannot be measured, hold paper/live and keep `/readyz` degraded.

## Risks

- The reducer can become a second proof floor if it is too broad. Keep it additive and ranking-oriented; proof floor
  remains the hard safety gate.
- Slippage thresholds can overfit stale April executions. Require fresh route samples before paper.
- Market context can be stale outside market hours for legitimate reasons. Session state must determine whether that
  is a hold or an informational discount.
- Empty Jangar quant latest-store evidence may reflect Jangar brownout rather than Torghut data absence. The frontier
  must preserve both dependency prices instead of collapsing them into one reason.

## Handoff Contract

Engineer acceptance:

- Implement the pure reducer and tests first.
- Preserve existing proof-floor semantics.
- Make the 2026-05-08 evidence fixture produce `highest_allowed_action=zero_notional_repair`.
- Add explicit fixtures for AAPL paper-probe eligibility and Jangar brownout paper hold.

Deployer acceptance:

- Shadow for one market session before using the payload for dispatch.
- Keep paper/live capital off until Jangar availability lease is enforced and scoped quant latest-store evidence is
  non-empty.
- Treat `simple_submit_disabled`, alpha rollback, Jangar HTTP `000`, and empty scoped quant latest store as independent
  blockers.
- Publish a NATS handoff that names the highest allowed action, target repair, and rollback target before any paper
  probe.
