# 190. Torghut Route Warrant Exchange And Ingestion Proof Reentry (2026-05-13)

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

I am selecting **route warrant exchange with ingestion proof reentry** as the next Torghut architecture step.

The live system is not idle. It is conflicted. Torghut `/healthz` returns HTTP 200, core pods are running, and the
latest promoted image is serving. Quant compute is fresh, with Jangar seeing current latest metrics and compute-stage
lag near seconds. But Torghut `/readyz` and `/trading/health` return HTTP 503. Live submission is blocked by
`simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and stale empirical jobs. The current Jangar
consumer evidence says `decision=repair`, `max_notional=0`, `route_repair_value=14`,
`accepted_routeable_candidate_count=0`, and `routeability_aggregate_state=blocked`.

The decision is to make the capital-facing object a route warrant, not a loose collection of freshness fields. The
route warrant ties together one consumer evidence receipt, ingestion/materialization clocks, direct data witnesses,
active-symbol TCA, empirical replay, market-context domain state, routeability repair acceptance, and the live
submission gate. It can authorize only observe or zero-notional repair while any dependency is stale. It can authorize
paper only after the same warrant shows accepted route candidates, current active TCA, current empirical replay,
current ingestion/materialization proof, and a capital gate that is still under Torghut authority.

The tradeoff is that routeable candidate count will remain zero until proof-path debt is retired. I accept that. A
non-zero routeable count without settled ingestion, TCA, empirical, and capital proof would be noise, not revenue
evidence.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps implementation milestones to:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `capital_gate_safety`
- `post_cost_daily_net_pnl`

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Runtime

- Runtime identity is `system:serviceaccount:agents:agents-sa`; in-cluster reads are authorized.
- Both swarms report `Active/Ready`.
- Argo reports `torghut` `Synced/Degraded` at sync revision `97de30dc5bdff03b026669ff059f50dfc70e683f`; the latest
  sync operation succeeded on `2026-05-13T00:02:24Z`.
- `torghut-options` is `Synced/Healthy`; `jangar` is `Synced/Healthy`.
- Torghut core pods are running, including the latest `torghut-00326` Knative deployment, simulation deployment,
  ClickHouse, Keeper, Postgres, TA, TA sim, WebSocket, options catalog, options enricher, and guardrail exporters.
- The serving Torghut image digest is
  `sha256:4ba6741297302675c4947add84fd2905b5420bc4513672022f5661bae402b04e`.
- Recent events show a successful rollout, but also readiness/startup probe failures during rollout, duplicate
  ClickHouse PodDisruptionBudget warnings, and external FlinkDeployment status modifications.
- `/healthz` returns HTTP 200. `/readyz` and `/trading/health` return HTTP 503.

### Source

- `services/torghut/app/main.py` is `5816` lines and already acts as the assembler for readiness, consumer evidence,
  proof floors, routeability repair acceptance, and live submission gates.
- The key proof modules are established but large enough to make implicit contracts risky:
  `evidence_clock_arbiter.py` is `1014` lines, `profit_freshness_frontier.py` is `1149`,
  `routeability_repair_acceptance.py` is `739`, `consumer_evidence.py` is `406`,
  `submission_council.py` is `1318`, `tca.py` is `975`, and `autonomy/lane.py` is `7393`.
- Existing tests cover evidence-clock invariants, routeability repair acceptance, profit freshness, profit-signal
  quorum, consumer evidence, revenue repair digests, autonomous lanes, TCA, and trading readiness.
- The missing invariant is not another endpoint. It is a route warrant reducer that refuses to mint a routeable
  candidate when compute is fresh but ingestion/materialization, TCA, empirical replay, or submission gates are stale.

### Database And Data

- Torghut Postgres schema head is `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `trade_decisions` has `147695` rows; newest `created_at` is `2026-05-12T17:54:23.892Z`.
- `executions` has `13778` rows; newest `created_at` is `2026-04-02T20:59:45.104Z`.
- `execution_tca_metrics` has `13775` rows; newest `computed_at` is `2026-05-08T02:42:07.924Z`.
- Active-symbol TCA is uneven or missing: AAPL averages `9.2512` bps absolute slippage, AMD `14.9333`, AVGO
  `21.8583`, INTC `20.5711`, and NVDA `13.4759`; AMZN, GOOGL, and ORCL are absent under those active symbols.
- `strategy_hypothesis_metric_windows` has three rows; newest `window_ended_at` is `2026-05-06T18:01:00Z`; max
  post-cost expectancy is `24.304747534` bps but stale.
- `strategy_promotion_decisions` has one row and no allowed decision.
- `vnext_empirical_job_runs` has `28` rows; newest `created_at` is `2026-05-08T21:54:41.117Z`.
- `research_candidates`, `research_promotions`, and `vnext_promotion_decisions` are empty.
- ClickHouse has TA data but not enough settled route proof: `ta_signals` has `1040505` rows and `ta_microbars` has
  `1497470` rows, both newest at `2026-05-12 18:48:40.399` ingest time.
- Jangar's materialized Torghut metrics are fresh at the latest-store level, but pipeline health shows compute current,
  ingestion degraded with max lag `1728000` seconds, and materialization mixed.

## Problem

Torghut has multiple proof surfaces that can disagree. A trader-facing decision cannot trust the best-looking field.

The current disagreement is specific:

1. Compute health is fresh while ingestion/materialization clocks are degraded.
2. Consumer evidence is fresh but still repair-only and zero-notional.
3. Trade decisions are current while executions and TCA are stale.
4. Positive post-cost expectancy exists only in stale metric windows.
5. Empirical job runtime tables contain historical successful rows while the runtime reports stale required jobs.
6. Market context is partially current but technicals, fundamentals, regime, and forecast registry evidence are
   degraded.
7. Live submission is explicitly disabled by `simple_submit_disabled`.

The architecture has to stop these partial truths from being recombined into a routeable claim.

## Alternatives Considered

### Option A: Reopen Paper Trading From The Fresh Compute Surface

Use the current quant compute, current trade decisions, and stale positive post-cost window to start a paper rehearsal
for the strongest symbols.

Advantages:

- Fastest path to new paper observations.
- Exercises order routing and TCA code paths.
- Makes the system feel productive.

Disadvantages:

- Ignores stale executions, stale TCA, stale empirical jobs, and disabled live submission.
- Converts fresh compute into routeability without settled ingestion/materialization proof.
- Violates `capital_gate_safety` by treating repair-only evidence as paper-ready.

Decision: reject. Fresh compute is not a route warrant.

### Option B: Freeze All Quant Work Until `/readyz` Is Green

Block all Torghut quant action until Argo is healthy, `/readyz` is 200, empirical jobs are current, and accepted
routeable candidates are non-zero.

Advantages:

- Strong safety posture.
- Simple for deployer and verify stages.
- Prevents false paper/live widening.

Disadvantages:

- Blocks the repair work that can make `/readyz` green.
- Treats ingestion proof repair, TCA repair, and live capital widening as the same risk.
- Provides no ordered plan for moving the value gates.

Decision: reject as the default operating model. Keep it as the emergency brake if route-warrant integrity fails.

### Option C: Route Warrant Exchange With Ingestion Proof Reentry

Publish one route warrant that reconciles consumer evidence, direct data witnesses, ingestion/materialization clocks,
active TCA, empirical replay, market context, routeability acceptance, and capital gates. Allow only observe and
zero-notional repair until the warrant is accepted.

Advantages:

- Directly addresses the observed split between fresh compute and degraded readiness.
- Preserves Torghut as the capital authority and Jangar as the dispatch authority.
- Gives engineer and deployer stages one object to implement, test, and verify.
- Maps every repair to the required value gates.
- Enables future paper/live evidence without weakening capital safety.

Disadvantages:

- Adds a reducer and tests across several proof surfaces.
- Keeps routeable candidates at zero until the warrant can be accepted.
- Requires careful rollout so a new warrant does not become another unsourced health blob.

Decision: select Option C.

## Architecture

Torghut publishes `route_warrant_exchange_v1` beside `/trading/consumer-evidence` and readiness payloads:

```text
route_warrant_exchange_v1
  schema_version = torghut.route-warrant-exchange.v1
  warrant_id
  generated_at
  fresh_until
  account
  torghut_revision
  source_commit
  consumer_evidence_receipt_id
  evidence_clock_arbiter_ref
  routeability_repair_acceptance_ref
  profit_freshness_frontier_ref
  live_submission_gate_ref
  direct_data_witnesses[]
  active_tca_witnesses[]
  empirical_replay_witnesses[]
  market_context_witnesses[]
  ingestion_materialization_witnesses[]
  repair_packets[]
  accepted_routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  fill_tca_or_slippage_quality
  capital_gate_safety
  post_cost_daily_net_pnl_state
  warrant_state                 # blocked | repair_only | paper_candidate | paper_accepted | live_candidate | live_accepted
  max_notional
  blocking_reason_codes[]
```

Each witness must include the source table or endpoint, newest timestamp, freshness budget, observed state, matching
published clock, and contradiction reason when the states differ.

Repair packets are executable only when zero-notional:

```text
route_warrant_repair_packet
  packet_id
  target_value_gate
  target_dependency             # ingestion | materialization | active_tca | empirical | forecast_registry | market_context | submission
  current_state
  expected_output_receipt
  expected_unblock_value
  max_notional = 0
  stop_conditions[]
  rollback_target
```

The warrant reducer must not infer paper or live eligibility from one good dependency. It accepts routeable candidates
only when all required dependencies settle in the same generated warrant.

## Implementation Scope

The next engineer milestone is bounded:

1. Add a `route_warrant_exchange` reducer under `services/torghut/app/trading/`, using the existing consumer evidence,
   evidence-clock arbiter, routeability repair acceptance, profit freshness frontier, TCA summary, empirical job state,
   market context, and live submission gate payloads.
2. Expose the warrant in `/trading/consumer-evidence` and `/readyz` without replacing the existing payloads.
3. Add regression tests under `services/torghut/tests/` proving that fresh compute plus stale ingestion, stale TCA,
   stale empirical jobs, or `simple_submit_disabled` yields `warrant_state=repair_only`, `max_notional=0`, and zero
   accepted routeable candidates.
4. Add a test proving that a fully current synthetic warrant can produce `paper_candidate` without granting live
   notional.
5. Keep route repair packets mapped to one value gate and one expected output receipt.

## Validation Gates

- `capital_gate_safety`: `max_notional` must remain `0` unless the route warrant is accepted by Torghut and live
  submission is explicitly allowed.
- `routeable_candidate_count`: accepted routeable candidates remain `0` while any warrant dependency is stale, missing,
  split, or disabled.
- `zero_notional_or_stale_evidence_rate`: the warrant must report stale and zero-notional rows by dependency so repair
  PRs can show the rate falling.
- `fill_tca_or_slippage_quality`: active symbols need current TCA rows and a slippage-quality verdict before paper or
  live support.
- `post_cost_daily_net_pnl`: live support remains blocked until paper or accepted canary routes publish current
  post-cost daily net PnL evidence.

Required local checks for the implementation PR:

- Targeted Torghut unit tests for the warrant reducer.
- Existing consumer evidence, readiness, routeability repair, TCA, and submission-council tests touched by the reducer.
- `uv run --frozen pyright --project pyrightconfig.json`.
- `uv run --frozen pyright --project pyrightconfig.alpha.json`.
- `uv run --frozen pyright --project pyrightconfig.scripts.json`.

Required deployer checks after image promotion:

- Argo `torghut`, `torghut-options`, `jangar`, and `agents` sync and health status.
- Torghut `/healthz`, `/readyz`, `/trading/health`, and `/trading/consumer-evidence`.
- Jangar `/ready` and `/api/agents/control-plane/status`.
- Database freshness for `trade_decisions`, `executions`, `execution_tca_metrics`, empirical job runs, and ClickHouse
  TA tables.
- Proof that the route warrant is repair-only before repair and accepted only after all listed dependencies settle.

## Rollout And Rollback

Roll out in observe mode first. The warrant is emitted and logged but existing readiness decisions remain unchanged.
Then make `/readyz` include the warrant state. Finally let Jangar dependency verdicts consume the warrant for
repair-only dispatch.

Rollback is to stop emitting or stop enforcing the warrant and return to the previous consumer evidence payload while
keeping live submission disabled and max notional at zero. A rollback must publish the failed invariant, the last
warrant id, and the dependency that produced the contradiction.

## Risks

- The reducer could become another aggregate that hides the exact blocker. Mitigation: every blocker must name a
  dependency, source ref, observed timestamp, and value gate.
- The active-symbol TCA mapping can confuse symbols such as `GOOG` and `GOOGL`. Mitigation: active-symbol tests must
  cover alias and missing-symbol behavior before paper support.
- Historical successful empirical rows can be mistaken for current readiness. Mitigation: the warrant uses freshness
  budgets and runtime required-job state, not historical success alone.
- Jangar could consume the warrant as a capital decision. Mitigation: the companion contract limits Jangar to dispatch
  custody; Torghut remains the capital authority.

## Handoff

Engineer handoff: implement the route warrant reducer and tests. The first PR should prove that the current evidence
set produces `repair_only`, `max_notional=0`, `accepted_routeable_candidate_count=0`, and repair packets for stale
ingestion/materialization, stale TCA, empirical jobs, forecast registry, market context, and disabled submission.

Deployer handoff: after promotion, prove the warrant through Argo sync, service health, endpoint payloads, and database
freshness. Do not treat HTTP 200 health or fresh compute as paper/live readiness unless the warrant is accepted.

The next milestone improves `capital_gate_safety` and `zero_notional_or_stale_evidence_rate` immediately. It creates
the proof path needed to move `routeable_candidate_count`, `fill_tca_or_slippage_quality`, and eventually
`post_cost_daily_net_pnl`.

## Implementation Note

The slippage-quality cut makes the `postgres_tca` evidence clock fail closed when `avg_abs_slippage_bps` is missing or
above the route guardrail. The reducer uses the TCA summary's explicit slippage guardrail when present and the doc 188
`8` bps average absolute slippage limit as the conservative fallback. High-slippage but fresh TCA now emits a
`fill_tca_or_slippage_quality` zero-notional repair packet, keeps route warrants in `repair_only`, and preserves
`max_notional=0`.
