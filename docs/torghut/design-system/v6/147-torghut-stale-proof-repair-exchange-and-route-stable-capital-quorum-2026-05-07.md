# 147. Torghut Stale-Proof Repair Exchange And Route-Stable Capital Quorum (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, stale proof repair ranking, Jangar route-stability consumption, paper/live capital quorum,
validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`

Extends:

- `146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md`
- `145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md`
- `144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md`
- `139-torghut-profit-data-witness-and-forecast-repair-exchange-2026-05-07.md`

## Decision

I am selecting **a stale-proof repair exchange with route-stable capital quorum** as Torghut's companion architecture
step.

Torghut is operationally alive, but it is not capital-qualified. At `2026-05-07T11:09Z`, `/readyz` returned
`status=degraded`. Scheduler, Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs, and
quant evidence were reachable or informational. Alpaca account `PA3SX7FYNUTF` was `ACTIVE`, the Jangar universe was
fresh with `12` symbols, and empirical jobs were healthy.

The profit evidence still says no. Live submission was closed by `simple_submit_disabled` with
`capital_stage=shadow`. The proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`,
and max notional `0`. Blocking reasons included `hypothesis_not_promotion_eligible`, `execution_tca_stale`,
`market_context_stale`, and `simple_submit_disabled`. Execution TCA was last computed on
`2026-04-02T20:59:45.136640Z`, average absolute slippage was about `568.61` bps against an `8` bps guardrail, quant
ingestion lag was `62,654` seconds, forecast authority was degraded with `registry_empty`, and zero hypotheses were
promotion eligible.

The selected design makes stale proof a repair market, not a vague readiness state. Torghut should rank stale TCA,
market-context freshness, forecast registry, quant ingestion, and alpha-readiness blockers by expected after-cost
capital unlock, but it must consume Jangar route-stability evidence before treating a repair as dispatchable. A fresh
Jangar escrow can support observe and zero-notional repair during route transitions. Paper and live submission require
a live Jangar route-stability window, current Torghut proof dimensions, and explicit submit enablement.

The tradeoff is that paper remains closed longer. I accept that because the current evidence would turn paper into
noise: the route can observe, but after-cost trading proof is stale or absent.

## Runtime Objective And Success Metrics

Success means:

- Torghut continues observe and zero-notional repair while `capital_state=zero_notional`.
- Every stale-proof repair bid names the proof dimension, current blocker, expected capital unlock, validation route,
  maximum runtime cost, expiry, and required Jangar route-stability refs.
- Repair dispatch can use Jangar snapshot escrow only for observe and zero-notional repair.
- Paper submission requires live Jangar route stability, current TCA, current market context, current quant ingestion,
  forecast authority or an explicit waiver, at least one promotion-eligible hypothesis, clean paper settlement, and
  paper submit enabled.
- Live submission additionally requires paper settlement, after-cost guardrails, expected shortfall coverage, no open
  capital repair leases, Jangar live action allow, and live submit enabled.
- The proof floor replaces static repair order with expected after-cost capital unlock.
- Rollback keeps `capital_state=zero_notional`, `simple_submit_disabled`, and all live notional at `0`.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, AgentRun objects, GitOps resources, or empirical artifacts.

### Jangar Route And Control-Plane Evidence

- Jangar `/ready` returned HTTP `200` and `status=ok`.
- Jangar execution trust, memory provider, runtime kits, and admission passports were healthy.
- Jangar database projection was healthy with `28` registered migrations, `28` applied migrations, zero unapplied
  migrations, zero unexpected migrations, and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar watch reliability was healthy with `2,571` events, `0` errors, and `0` restarts in the latest 15 minute
  window.
- Jangar material action verdicts allowed observe and bounded repair, but downgraded `dispatch_normal` to
  `repair_only` because controller-process witness freshness was missing.
- Recent scheduled runner failures showed that Jangar route connection refusal can still happen during rollout windows,
  even though more recent CronJobs completed.
- The companion Jangar contract therefore provides route-stable escrow for observe and repair, not for capital.

### Torghut Cluster And Runtime Evidence

- `deployment/torghut-00254-deployment` and `deployment/torghut-sim-00354-deployment` were available `1/1`.
- Current live and sim Torghut revisions used image digest
  `registry.ide-newton.ts.net/lab/torghut@sha256:ca8bedfa6923f4d765e19eb319c1fd29cb3b1522a452bdd51b17b4d6e1cb1496`.
- Torghut Postgres, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher, websocket
  services, guardrail exporters, Alloy, and Symphony pods were Running.
- The `torghut` Argo CD Application was `OutOfSync` but `Healthy`.
- Torghut events repeatedly reported ambiguous ClickHouse PodDisruptionBudget matches and transient readiness failures
  on live, sim, options, and websocket pods.
- The Knative service and revision APIs were not listable from this service account, so deployer validation must use
  allowed Deployment, pod, event, route, and Argo evidence unless higher RBAC is granted.

### Trading Health And Proof Evidence

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned `status=degraded`.
- Scheduler readiness, Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs, and quant
  evidence checks were available or informational.
- Alpaca account label was `PA3SX7FYNUTF`; account status was `ACTIVE`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, with `capital_stage=shadow`.
- Profitability proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max
  notional `0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`,
  `market_context_stale`, and `simple_submit_disabled`.
- Execution TCA had `13,775` orders, last computed `2026-04-02T20:59:45.136640Z`, average absolute slippage about
  `568.61` bps, and slippage guardrail `8` bps.
- Quant latest metrics count was `144`, metrics pipeline lag was `20` seconds, but ingestion-stage lag was `62,654`
  seconds.
- Forecast authority was degraded with `registry_empty`; eligible forecast models were empty.
- Alpha readiness had `3` hypotheses: `1` blocked, `2` shadow, `0` promotion eligible, and `3` rollback required.
- Market context was stale and contributed a hard live hold.

### Database And Source Evidence

- Runtime dependency checks reported Torghut Postgres and ClickHouse OK.
- Direct database shell access was not available from this runner because `pods/exec` is forbidden by the service
  account. This is not a blocker for the design because the normal deployer and verifier path must work through typed
  routes and Kubernetes object evidence.
- `services/torghut/app/main.py` is `4,124` lines and assembles the trading readiness and status routes.
- `services/torghut/app/trading/proof_floor.py` is `569` lines and already emits proof-floor dimensions and a repair
  ladder.
- `services/torghut/app/trading/forecast_runtime.py` is `326` lines and is the likely forecast-authority boundary.
- `services/torghut/app/trading/hypotheses.py` is `764` lines and owns hypothesis state and promotion reasons.
- `services/torghut/app/trading/market_context.py` is `290` lines and already flags `market_context_stale`.
- `services/torghut/app/trading/tca.py` is `768` lines and owns execution TCA evidence.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` is `730` lines and currently holds live submission at
  `repair_only` when the proof floor is not capital-ready.
- Tests already cover proof floor, trading API shape, market context, repair digest generation, and the scheduler
  pipeline. The missing fixture is a stale-proof exchange that ranks repair bids by expected capital unlock and
  rejects paper/live when Jangar route stability is snapshot-only or any proof quorum member is stale.

## Problem

Torghut has enough operational evidence to keep learning, but it does not have enough profit evidence to submit paper
or live orders.

The current failure modes are:

1. **Operational health can hide stale profit proof.** Database, broker, universe, and empirical jobs can be OK while
   TCA, market context, forecast, quant ingestion, and hypothesis promotion are invalid for capital.
2. **Repair priority is not capital-priced.** The proof floor lists repair actions, but it does not score expected
   after-cost capital unlock per blocker.
3. **Jangar route stability is not part of repair value.** A Torghut repair can be operationally useful only if it can
   cite route-stable Jangar authority for its dispatch class.
4. **Snapshot escrow must not become paper authority.** Jangar may allow repair under a fresh snapshot. Paper and live
   require live route stability.
5. **Least-privilege validation is required.** Normal verification cannot depend on direct database or ClickHouse
   shells.

## Alternatives Considered

### Option A: Promote Paper When Empirical Jobs Are Fresh

Pros:

- Fastest way to collect new paper observations.
- Uses current empirical job health.
- Avoids new scoring and quorum logic.

Cons:

- Ignores stale execution TCA and extreme slippage.
- Ignores stale market context, stale quant ingestion, empty forecast registry, and zero promotion-eligible
  hypotheses.
- Would produce paper evidence that cannot be trusted for after-cost capital qualification.

Decision: reject.

### Option B: Freeze All Repairs Until Every Proof Surface Is Healthy

Pros:

- Strong capital safety.
- Easy to explain.
- Prevents repair work from running on incomplete evidence.

Cons:

- Blocks the zero-notional repair work needed to make proof surfaces healthy.
- Leaves empirical, market-context, and TCA repair opportunities unpriced.
- Forces humans to repeatedly join Jangar and Torghut evidence by hand.

Decision: reject.

### Option C: Stale-Proof Repair Exchange With Route-Stable Capital Quorum

Pros:

- Keeps observe and zero-notional repair open while preserving capital safety.
- Ranks repairs by expected after-cost capital unlock rather than static severity.
- Requires Jangar route-stability evidence before repair dispatch.
- Prevents snapshot fallback from upgrading paper or live submission.
- Fits route-only validation in the current RBAC model.

Cons:

- Requires a new repair scorer and quorum reducer.
- Requires calibration for expected capital unlock.
- Keeps paper closed until several stale proof dimensions recover together.

Decision: select Option C.

## Architecture

Torghut emits one stale-proof repair exchange per account, revision, and market window.

```text
stale_proof_repair_exchange
  exchange_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  jangar_route_stability_ref
  proof_floor_ref
  proof_dimensions[]
  repair_bids[]
  paper_capital_quorum
  live_capital_quorum
  rollback_target
```

Each repair bid is scored against capital unlock, not only warning severity.

```text
stale_proof_repair_bid
  bid_id
  blocker_code
  proof_dimension
  hypothesis_ids[]
  current_state
  target_state
  expected_after_cost_dividend_bps
  expected_capital_unlock
  max_repair_runtime_seconds
  required_jangar_route_refs[]
  validation_refs[]
  expires_at
  decision
```

Paper and live quorums are explicit.

```text
capital_quorum
  quorum_id
  stage                 # paper, live_micro, live_scale
  decision              # allow, repair_only, hold, block
  jangar_route_state    # live_stable, escrow_repair_only, unstable
  required_dimensions[]
  missing_dimensions[]
  max_notional
  rollback_target
```

Rules:

1. Observe and zero-notional repair may proceed under `jangar_route_state=live_stable` or `escrow_repair_only`.
2. Paper requires `jangar_route_state=live_stable`.
3. Live micro and live scale require `jangar_route_state=live_stable` plus a Jangar live action allow.
4. `execution_tca_stale` blocks paper and live until TCA is current and slippage is inside the configured guardrail.
5. `market_context_stale` blocks paper and live for hypotheses that depend on market-context domains.
6. `forecast_registry_empty` blocks forecast-backed hypotheses unless a documented waiver marks forecast as
   non-required for that hypothesis.
7. Quant ingestion lag beyond the window threshold blocks paper and live for account/window-specific routes.
8. `simple_submit_disabled` is an absolute paper and live hold.
9. Zero promotion-eligible hypotheses block paper and live even if lower-level data surfaces are healthy.
10. Every accepted repair bid must name a validation route or command and expire if not settled.

## Implementation Scope

Engineer lane:

1. Add a reducer such as `services/torghut/app/trading/stale_proof_repair_exchange.py`.
2. Feed it from proof floor, live submission gate, alpha readiness, TCA, market context, forecast runtime, quant
   evidence, and Jangar route-stability refs.
3. Add the exchange to `/readyz` and `/trading/status` without making it the initial enforcement path.
4. Add a compact Jangar route-stability client that refuses to treat snapshot fallback as paper or live authority.
5. Add tests for TCA stale, market context stale, forecast registry empty, quant ingestion lag, submit disabled, and
   zero promotion eligibility.
6. Update repair digest generation to use exchange-ranked repair bids.

Deployer lane:

1. Roll out the exchange in observe mode.
2. Confirm that current live state remains `capital_state=zero_notional`.
3. Allow zero-notional repair ranking to use Jangar escrow refs.
4. Require live Jangar route-stability before any paper canary.
5. Keep live submit disabled until paper settlement, after-cost guardrails, and Jangar live action allow are all
   current.

## Validation Gates

Local validation:

- `pytest services/torghut/tests/test_profitability_proof_floor.py`
- `pytest services/torghut/tests/test_trading_api.py -k proof_floor`
- `pytest services/torghut/tests/test_market_context.py -k stale`
- `pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `ruff check services/torghut/app/trading services/torghut/tests`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation:

- `curl -sS http://torghut.torghut.svc.cluster.local/readyz | jq '.proof_floor, .stale_proof_repair_exchange'`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.route_stability_escrow'`
- `kubectl get deployments -n torghut -o wide`
- `kubectl get events -n torghut --field-selector type!=Normal --sort-by=.lastTimestamp`
- Confirm observe and zero-notional repair remain available while `capital_state=zero_notional`.
- Confirm paper remains blocked when Jangar route state is `escrow_repair_only`.
- Confirm live remains blocked when `simple_submit_disabled`, stale TCA, stale market context, or zero promotion
  eligibility persists.

## Rollout

1. Shadow: expose the stale-proof repair exchange without changing submission behavior.
2. Repair ranking: make revenue repair digest and operator views consume ranked repair bids.
3. Observe repair: allow zero-notional repairs to cite Jangar route-stability escrow.
4. Paper gate: require live Jangar route stability plus all paper quorum dimensions.
5. Live gate: require paper settlement, after-cost guardrails, no open capital repair leases, and live submit enabled.

## Rollback

Rollback keeps capital safe:

- Disable exchange consumption and return to existing proof-floor repair ladder.
- Keep `capital_state=zero_notional`.
- Keep `simple_submit_disabled`.
- Preserve exchange receipts for incident and profitability analysis.
- Do not delete stale proof records; mark superseded receipts with a rollback reason.
- If Jangar route-stability refs are unavailable, treat all paper/live quorum decisions as `hold` or `block`.

## Risks

- Expected capital unlock can be gamed if not tied to settled after-cost evidence. Require validation refs before
  accepting repair bids.
- Snapshot fallback can be misread as paper authority. The quorum model explicitly separates `escrow_repair_only` from
  `live_stable`.
- Market context may be stale because the market is closed. Allow closed-session informational staleness only when the
  affected hypothesis does not require fresh domain context.
- TCA repair may take longer than a route-stability window. The repair bid can remain open, but paper/live stay closed.
- Torghut Argo `OutOfSync` adds rollout ambiguity. Deployer must resolve or waive that before capital gates.

## Handoff To Engineer

Implement the exchange as a pure reducer before route wiring. Keep it separate from `main.py` and the scheduler.

Acceptance gates:

- Unit fixture: Jangar route state `escrow_repair_only` allows observe and zero-notional repair, blocks paper and live.
- Unit fixture: stale TCA blocks paper and live even when empirical jobs are healthy.
- Unit fixture: market context stale blocks affected hypotheses and produces a ranked repair bid.
- Unit fixture: forecast registry empty blocks forecast-backed hypotheses unless a waiver is present.
- Unit fixture: quant ingestion lag blocks account/window paper and live routes.
- Unit fixture: zero promotion-eligible hypotheses block paper and live.
- API fixture: `/readyz` exposes the exchange and keeps `capital_state=zero_notional` for current evidence.

## Handoff To Deployer

Deployer should roll out observe-only first and keep submit disabled.

Acceptance gates:

- Current cluster still reports `capital_state=zero_notional` after rollout.
- Repair digest lists ranked stale-proof repair bids with validation refs.
- Paper remains blocked while Jangar route state is snapshot-only, TCA is stale, market context is stale, forecast
  registry is empty, quant ingestion is stale, or submit is disabled.
- Live remains blocked until paper settlement and Jangar live action allow are current.
- Rollback returns to the prior proof-floor ladder without changing broker submission flags.
