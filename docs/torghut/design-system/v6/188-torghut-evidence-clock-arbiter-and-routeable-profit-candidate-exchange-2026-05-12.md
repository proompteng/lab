# 188. Torghut Evidence-Clock Arbiter And Routeable Profit Candidate Exchange (2026-05-12)

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

I am selecting a **Torghut evidence-clock arbiter with a routeable profit candidate exchange** as the next architecture
step.

The current system is safe, but it is not yet revenue-ready. Live ClickHouse TA data is fresh for the active eight
symbols, with `ta_signals` and `ta_microbars` updating at `2026-05-12T16:38Z`. The live trading service is running, but
`/readyz` returns HTTP 503 and `/trading/status` keeps `live_submission_gate.allowed=false`,
`capital_stage=shadow`, `simple_submit_disabled`, `empirical_jobs_not_ready`, stale market-context domains, stale TCA,
and `promotion_eligible_total=0`. Jangar quant health is globally alive, yet scoped pipeline evidence still carries
ingestion and materialization debt. Torghut Postgres shows the same split: `147,666` trade decisions exist, but newest
executions stopped on `2026-04-02`, newest TCA computation is `2026-05-08`, only one strategy hypothesis is active, and
the only promotion decision is not allowed.

That split is the design problem. We have fresh data in one clock, stale proof in another clock, and degraded rollout
state in the cluster. A candidate should not become paper-ready because any one clock is fresh. A candidate becomes
routeable only when the market-data clock, Jangar quant clock, Torghut Postgres proof clock, route/TCA clock,
hypothesis lineage clock, empirical replay clock, and rollout clock agree inside their guardrails.

The selected design makes that agreement explicit. Torghut will publish an `evidence_clock_arbiter` receipt and a
`routeable_profit_candidate_exchange` beside the existing proof-floor, profit-window, profit-signal quorum,
route-reacquisition, and quality-frontier surfaces. The arbiter does not authorize notional. It classifies clock
agreement, names the smallest repair that can move a value gate, and mints routeable candidates only when all required
clocks are current. Jangar consumes the companion receipt to decide which zero-notional repair work can run and which
deploy or dispatch action must remain held.

The tradeoff is ceremony. Some work that looks locally useful will wait until its clock and rollout evidence is
attached. I accept that tradeoff because the business metric is routeable post-cost profit evidence and live trading
readiness without weakening capital safety, not more stale repair artifacts.

## Evidence Snapshot

All evidence below was collected read-only. I did not mutate Kubernetes resources, database rows, broker state,
trading flags, GitOps resources, or AgentRun objects.

### Cluster And Rollout

- `kubectl auth whoami` used `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset, but
  in-cluster reads were authorized.
- Argo CD reported `torghut` `Synced/Degraded` at revision `32564cef018d608a7928c80240a70d35f75c5b25`.
- Argo CD reported `jangar` and `agents` `Synced/Healthy` at revision `b9137f87f5e14cffab6f841cf5ead38724b95949`.
- Torghut core pods were running: `torghut-00320`, `torghut-sim-00418`, ClickHouse replicas, Keeper, CNPG Postgres,
  live TA job manager, four live TA task managers, options catalog, options enricher, guardrail exporters, Alloy, and
  Symphony.
- The degraded Torghut app is not noise. `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and
  `torghut-options-ta` were in `ImagePullBackOff`. Recent events showed private-registry DNS failures for
  `registry.ide-newton.ts.net`, plus recurring pull backoffs on WebSocket and simulation TA pods.
- Live Torghut TA recovered to `RUNNING` after a startup-probe failure, but sim/options signal paths remained blocked.
- Jangar pods were running, with recent restarts on `jangar` and `bumba`. Agents controllers were `2/2` and fresh
  component heartbeats in Jangar DB showed `agents-controller`, `orchestration-controller`, `supporting-controller`,
  and `workflow-runtime` healthy until `2026-05-12T16:39Z`.
- Agents namespace still carried many recent failed scheduled jobs and market-context jobs, including fundamentals and
  news failures for `AMZN` and `INTC`.

### Runtime And Source

- Jangar unscoped quant health returned `ok=true`, `latestMetricsCount=4536`, and a one-second latest-store lag.
- Torghut `/readyz` returned HTTP 503.
- Torghut `/trading/status` returned `enabled=true`, `mode=live`, `autonomy_enabled=false`, and `running=true`, but
  live submission stayed blocked by `hypothesis_not_promotion_eligible`, `empirical_jobs_not_ready`, and
  `simple_submit_disabled`.
- The same status payload reported scoped quant `status=degraded`, `quant_metrics_update_missing`,
  `quant_pipeline_degraded`, ingestion lag over `341,000` seconds for the sampled account/window, and materialization
  lag near `196` seconds.
- Hypothesis state was conservative: `H-CONT-01` and `H-REV-01` had missing strategy lineage; `H-MICRO-01` had a
  candidate but remained blocked/shadow because empirical jobs, TA-core, route/TCA, drift, and feature evidence were
  stale or missing.
- TCA quality is stale and incomplete for the current active universe. Status scoped to eight symbols showed
  `order_count=7334`, newest execution `2026-04-02T19:00:29Z`, newest TCA computation `2026-05-08T02:42:07Z`, no
  expected-shortfall samples, and missing symbol coverage for `AMZN`, `GOOGL`, and `ORCL`.
- Source risk is concentrated in large orchestration surfaces. `services/torghut/app/main.py` is `5,298` lines,
  `submission_council.py` is `1,318` lines, and `tca.py` is `975` lines. The pure reducers are better homes for the
  next milestone: `profit_windows.py`, `profit_signal_quorum.py`, `quality_adjusted_profit_frontier.py`,
  `route_reacquisition.py`, and `consumer_evidence.py`.
- Test coverage is broad, with focused tests for profit windows, profit signal quorum, quality-adjusted frontier,
  route reacquisition, TCA refresh, consumer evidence, empirical jobs, and trading readiness. The missing test is a
  cross-clock invariant: fresh ClickHouse rows must not mint a routeable candidate when Postgres proof, Jangar scoped
  quant, TCA, empirical replay, or rollout clocks are stale.

### Database And Data

- CNPG pod exec was forbidden for this service account, so database reads used app database secrets and direct
  Postgres connections from the worker pod. Every SQL query was read-only.
- Torghut Postgres migration head was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `executions` contained `13,778` rows, `13,571` filled rows, and newest `created_at=2026-04-02T20:59:45Z`.
- `trade_decisions` contained `147,666` rows across `19` symbols, newest `created_at=2026-05-08T17:29:45Z`.
- `execution_tca_metrics` contained `13,775` rows across `12` symbols, newest `computed_at=2026-05-08T02:42:07Z`,
  average absolute slippage about `13.76` bps, and `expected_shortfall_count=0`.
- TCA by active route shows the guardrail problem: AAPL averaged about `9.25` bps, AMD `14.93` bps, AVGO `21.86` bps,
  INTC `20.57` bps, and NVDA `13.48` bps. Several current active symbols have no TCA rows.
- `strategy_hypotheses` had one active row: `H-MICRO-01`.
- `strategy_hypothesis_metric_windows` had three rows for one candidate, newest window ending
  `2026-05-06T18:01:00Z`; one row had positive post-cost expectancy, but the evidence is now stale.
- `strategy_promotion_decisions` had one row and `allowed_count=0`.
- `vnext_empirical_job_runs` had `28` completed and promotion-eligible rows, but all were created no later than
  `2026-05-08T21:54:41Z`, and the runtime classified the required jobs as stale.
- Options data is fresh: `torghut_options_contract_catalog` held about `2.44M` contracts with newest
  `last_seen_ts=2026-05-12T16:00:45Z`, and options watermarks advanced through `2026-05-12T16:32:26Z`.
- ClickHouse storage is healthy for live TA: `ta_microbars` had about `1.48M` rows and `ta_signals` about `1.07M`
  rows; both updated at `2026-05-12T16:38Z`. The active eight symbols had fresh per-symbol `ta_signals`, while older
  expanded symbols were stale by days.
- Jangar DB showed `quant_metrics_latest=4536`, `quant_metrics_series` around `73K`, and fresh latest metrics at
  `2026-05-12T16:37Z`. Quality was mixed: most latest metrics were `insufficient_data`, `618` were stale, and `424`
  were good. Recent pipeline rows showed ingestion all false and materialization mixed.

## Problem

Torghut has too many clocks and no arbiter. The live system can prove market data is fresh while also proving capital
readiness is stale. Both facts are true. Without a clock arbiter, the next engineer or scheduler can accidentally pick
the favorable fact and create a routeable-candidate claim that cannot survive deployment verification.

The failure modes are concrete:

1. Fresh ClickHouse TA rows can hide stale Postgres execution, TCA, empirical replay, and promotion clocks.
2. Global Jangar quant health can hide scoped ingestion or materialization failures.
3. A candidate can show a positive stale metric window while live route/TCA, market context, and rollout clocks are
   blocked.
4. Registry DNS/image-pull failures can leave data-producing pods unavailable while proof reducers still carry old
   evidence.
5. Options data can be fresh and high-volume while equity routeability remains underfunded.
6. Zero-notional repair work can increase artifact volume without reducing stale-evidence rate or increasing
   routeable candidate count.

## Alternatives Considered

### Option A: Promote `H-MICRO-01` Toward Paper Because ClickHouse Is Fresh

Use fresh active-symbol TA and the positive `2026-05-06T18:01Z` metric window as enough evidence to start paper
rehearsal for the microstructure candidate.

Advantages:

- Fastest route to more paper observations.
- Exercises route/TCA and execution paths.
- Uses the only candidate with known lineage.

Disadvantages:

- Ignores stale metric-window, empirical, TCA, and promotion clocks.
- Ignores current Torghut app degradation from image-pull failures.
- Converts a stale positive backtest into a capital-adjacent action.
- Violates the value gate `capital_gate_safety`.

Decision: reject. Positive stale evidence is still stale evidence.

### Option B: Repair Only The Registry And Rollout Path

Treat private-registry DNS/image-pull failures as the primary blocker and focus the next milestone on rollout
plumbing.

Advantages:

- Directly addresses the visible Argo degradation.
- Reduces failed rollout and simulation readiness noise.
- Gives deployer stage a clear operational target.

Disadvantages:

- Does not distinguish fresh TA from stale profit proof.
- Does not improve routeable candidate count by itself.
- Could produce healthy pods that continue to serve stale TCA and stale empirical proof.

Decision: reject as the whole architecture. It is a required repair lane under the selected design.

### Option C: Evidence-Clock Arbiter And Routeable Profit Candidate Exchange

Publish a single Torghut arbiter that compares clock evidence across ClickHouse, Jangar quant, Postgres proof,
empirical replay, hypothesis lineage, route/TCA, market context, options data, and cluster rollout. Mint routeable
profit candidates only when the clocks agree; otherwise emit zero-notional repair lots ranked by value gate.

Advantages:

- Prevents one fresh surface from overriding stale capital evidence.
- Converts clock disagreement into a concrete repair queue.
- Gives Jangar a compact receipt for dispatch and deploy custody.
- Maps directly to the required value gates.
- Lets options freshness improve future hypotheses without weakening equity capital safety.

Disadvantages:

- Adds a new reducer and contract that must be kept aligned with existing proof surfaces.
- Requires tests across several existing payload shapes.
- May hold paper rehearsal even when the dashboard headline looks green.

Decision: select Option C.

## Architecture

Torghut adds two additive shadow-first payloads.

First, `evidence_clock_arbiter`:

```text
evidence_clock_arbiter
  schema_version = torghut.evidence-clock-arbiter.v1
  arbiter_id
  generated_at
  fresh_until
  account
  window
  active_revision
  clocks[]
  clock_splits[]
  routeable_candidate_count
  stale_or_zero_notional_evidence_rate
  capital_decision              # observe_only | repair_only | paper_candidate | hold
  max_notional = 0 unless independent capital gate allows
  required_jangar_custody_ref
  selected_repair_lot_ids[]
```

Each clock is a typed record:

```text
evidence_clock
  name                          # clickhouse_ta | jangar_quant | postgres_tca | empirical | promotion | rollout
  state                         # current | stale | missing | split | blocked
  as_of
  max_age_seconds
  source_ref
  affected_value_gates[]
  blocking_reason_codes[]
```

Second, `routeable_profit_candidate_exchange`:

```text
routeable_profit_candidate_exchange
  schema_version = torghut.routeable-profit-candidate-exchange.v1
  exchange_id
  generated_at
  account
  window
  routeable_candidates[]
  zero_notional_repair_lots[]
  rejected_candidates[]
  capital_safety_ref
```

A candidate becomes routeable only when all required clocks are current and the candidate clears:

- hypothesis lineage present and active;
- metric window age within threshold;
- post-cost expectancy above the hypothesis guardrail;
- TCA coverage present for the symbol route and average absolute slippage under guardrail;
- scoped Jangar quant latest, ingestion, and materialization clocks current;
- market-context domains required by the hypothesis current;
- empirical replay jobs current and promotion-authority eligible;
- rollout clock current: the live, sim, and feeder paths needed by the candidate are not degraded;
- Jangar custody receipt allows the action class.

When any clock fails, the exchange emits zero-notional repair lots. Repair lots must name the expected value gate:

- `post_cost_daily_net_pnl`: only for replay or paper-proof work with a current no-notional guard.
- `routeable_candidate_count`: route, lineage, or hypothesis repair likely to mint a candidate.
- `zero_notional_or_stale_evidence_rate`: evidence-clock repair, empirical refresh, schema lineage, or market context.
- `fill_tca_or_slippage_quality`: TCA refresh, symbol coverage, expected-shortfall calibration, or slippage reduction.
- `capital_gate_safety`: rollout quarantine, custody receipt repair, kill-switch parity, or promotion-gate repair.

## Measurable Trading Hypotheses And Guardrails

`H-MICRO-01` remains the first candidate to rehabilitate because it has the only active strategy hypothesis and a known
candidate id. It cannot move to paper until:

- `routeable_candidate_count >= 1` for `PA3SX7FYNUTF/15m`;
- three consecutive current metric windows show `post_cost_expectancy_bps >= 10`;
- `avg_abs_slippage_bps <= 8` for the route symbols in that candidate;
- expected-shortfall calibration has at least `60` samples or is explicitly marked as unavailable and non-promoting;
- Jangar scoped quant ingestion and materialization are both current;
- live, sim, WebSocket, and required TA rollout clocks are current;
- max notional remains `0` until a separate capital gate allows paper.

`H-CONT-01` and `H-REV-01` are not routeable until strategy lineage exists. Their first repair lots target
`routeable_candidate_count` and `zero_notional_or_stale_evidence_rate`, not PnL.

Options freshness is treated as an opportunity surface, not a capital bypass. The options catalog and watermarks can
fund new hypothesis proposals only after the equity evidence-clock arbiter proves the active route clocks are not
silently stale.

## Implementation Scope

Engineer milestone 1:

- Add a pure `evidence_clock_arbiter` builder under `services/torghut/app/trading/`.
- Add a pure `routeable_profit_candidate_exchange` builder that consumes existing profit-window, profit-signal quorum,
  quality frontier, route-reacquisition, TCA, market-context, empirical, and rollout/custody payloads.
- Expose both payloads in `/trading/status`, `/trading/health`, and `/readyz` as shadow-only fields.
- Add unit tests proving fresh ClickHouse data cannot mint a routeable candidate while any required proof clock is
  stale, missing, split, or rollout-blocked.

Engineer milestone 2:

- Teach Jangar's Torghut consumer path to read the arbiter receipt and reject dispatch/deploy widening when the
  companion custody receipt is absent or stale.
- Add an operator summary field showing top clock split, selected repair lot, expected value gate, and next validation
  command.

Deployer milestone:

- Roll out with `max_notional=0`.
- Verify live and sim `/readyz`, `/trading/status`, Jangar quant health, Argo app health, ClickHouse per-symbol
  freshness, Postgres proof freshness, and the routeable candidate exchange.
- Keep live capital blocked until the arbiter, profit-window custody, and independent capital gate all agree.

## Validation Gates

The implementation is not accepted until these gates are green:

- `post_cost_daily_net_pnl`: daily net PnL remains observational unless a current routeable candidate exists; no stale
  positive window can be counted as routeable evidence.
- `routeable_candidate_count`: candidate count is zero when any required clock is stale, and at least one only when
  all clocks are current for the candidate.
- `zero_notional_or_stale_evidence_rate`: stale or zero-notional repair lots decline after repair runs; no repair run
  is accepted without before/after clock evidence.
- `fill_tca_or_slippage_quality`: TCA rows cover route symbols, newest computation is within threshold, and expected
  shortfall coverage is either current or explicitly non-promoting.
- `capital_gate_safety`: every emitted candidate carries `max_notional=0` until the independent capital gate and Jangar
  custody allow paper.

## Rollout

1. Add the Torghut reducers and tests behind shadow-only response fields.
2. Deploy Torghut and verify the fields appear with zero-notional decisions.
3. Add Jangar consumption in shadow mode and compare custody decisions against current material action verdicts.
4. Enable Jangar to block repair dispatch only when the arbiter is missing or stale; normal dispatch and deploy widening
   remain held on rollout or capital clock splits.
5. Promote the exchange from shadow to required only after the deployer captures Argo, health, DB, ClickHouse, and
   route evidence in one verification note.

## Rollback

Rollback is field-level first:

- Disable Jangar consumption of the new receipt and fall back to the existing profit-window and action-custody
  contracts.
- Keep Torghut emitting the payload for observation if it is not causing route latency or status failures.
- If the Torghut reducer causes status regressions, remove it from response assembly and keep the pure module/tests for
  correction.
- Never roll back by widening capital. If the arbiter is missing or inconsistent, the valid capital decision is hold or
  zero-notional repair.

## Risks

- Clock thresholds can become too strict and block useful repairs. Mitigation: shadow-mode comparison and per-clock
  reason codes before enforcement.
- A new payload can duplicate existing proof surfaces. Mitigation: the arbiter cites existing receipts instead of
  recomputing their business logic.
- Postgres and Jangar DB reads can become expensive if the reducer queries directly. Mitigation: build from already
  assembled status inputs first; add DB access only through existing repositories.
- Registry DNS/image-pull failures can make rollout clocks noisy. Mitigation: the companion Jangar contract treats
  rollout degradation as a custody hold and a repair lot, not as a capital signal.

## Handoff

Engineer next action: implement `evidence_clock_arbiter` and `routeable_profit_candidate_exchange` as pure Torghut
reducers with tests for stale Postgres proof, fresh ClickHouse split, degraded Jangar scoped quant, stale TCA, stale
empirical jobs, missing lineage, and degraded rollout.

Deployer next action: after the implementation PR merges, verify the fields on live and sim, prove Argo app health,
prove ClickHouse freshness, prove Postgres proof freshness, and keep capital at zero unless every clock and Jangar
custody receipt agrees.

Revenue metric improved: this design targets `routeable_candidate_count` and
`zero_notional_or_stale_evidence_rate` first, then `post_cost_daily_net_pnl` only after current routeable candidates
exist.

## Implementation Note

The first implementation cut adds `services/torghut/app/trading/evidence_clock_arbiter.py` as a pure reducer and
surfaces `torghut.evidence-clock-arbiter.v1` plus `torghut.routeable-profit-candidate-exchange.v1` on `/readyz`,
`/trading/health`, and `/trading/status`. The reducer consumes already-assembled status inputs; it does not add hot
path database reads or change live submission defaults. Fresh ClickHouse or global quant evidence cannot mint a
routeable candidate while scoped quant stages, Postgres TCA, empirical replay, rollout, routeability acceptance,
profit-signal quorum, or capital clocks are stale, split, missing, or blocked.

Validation for this cut covers stale Postgres proof, fresh ClickHouse split, degraded scoped quant stages, repair-only
capital gates, missing lineage, API payload presence, and unchanged `max_notional=0`. Rollback is field-level: remove
the two shadow fields from response assembly or disable downstream consumption; do not widen notional or relax TCA,
freshness, rollout, or custody gates.

The second implementation cut carries the same `evidence_clock_arbiter` and
`routeable_profit_candidate_exchange` through `/trading/consumer-evidence`, which is the Jangar action boundary.
Jangar now records the arbiter id, split clocks, custody state, routeable exchange id, zero-notional repair lot ids, and
an operator summary. If the companion stage-custody receipt is absent or stale, Jangar converts that into
data-freshness, runtime, and rollout-ambiguity evidence: normal dispatch is downgraded, deploy widening is held, and
paper/live Torghut capital stays blocked while zero-notional repair dispatch remains available.
