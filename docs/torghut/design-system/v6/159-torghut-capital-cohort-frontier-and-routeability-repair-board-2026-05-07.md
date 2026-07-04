# 159. Torghut Capital Cohort Frontier And Routeability Repair Board (2026-05-07)

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

I am selecting a capital cohort frontier with a routeability repair board as the next Torghut profitability
architecture step.

Torghut is not failing open. It is correctly refusing capital. Live `/readyz` is degraded, live capital is
zero-notional, and the active live routeable universe is empty. Simulation is HTTP 200, but its proof floor is still
repair-only, only `NVDA` is routeable, and seven configured symbols are missing. The fresh deployment to revision
`00272` proves rollout availability, not capital readiness.

The useful profitability move is to stop asking whether Torghut is broadly healthy and start asking which capital
cohort can reacquire routeable, post-cost edge. Torghut should publish `capital_cohort_frontier` and
`routeability_repair_board` from `/readyz`, `/trading/health`, and `/trading/status`. A capital cohort is keyed by
service revision, account, proof window, routeable symbol set, TCA guardrail, market-context freshness, alpha readiness,
quant-stage freshness, Jangar execution cohort, and submission policy. It can earn observation, repair, paper-canary,
or live-capital eligibility only when the same cohort owns the required evidence.

The tradeoff is strict patience. A green simulation route and one routeable symbol do not justify paper capital. They
justify a repair board entry with measurable unblock value. That is the right behavior when live has zero routeable
symbols and simple submit is disabled.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `capital_cohort_frontier` and `routeability_repair_board` from `/readyz`, `/trading/health`, and
  `/trading/status`.
- Live capital remains `zero_notional` when routeable live symbol count is zero or Jangar launch quarantine is not
  current.
- Simulation can produce repair candidates, but paper canary requires at least two routeable scoped symbols, fresh
  market context, alpha readiness, quant lag below threshold, and a current Jangar execution cohort.
- A repair board entry records before/after routeable symbols, missing symbols, blocked symbols, TCA, market context,
  quant lag, alpha readiness, and Jangar cohort ref.
- The board ranks repair candidates by expected unblock value and expected post-cost edge, not by readiness status
  alone.
- Capital receipts cannot cite Jangar contracts that are absent, design-only, expired, retired, or quarantined.
- Deployer gates can reject capital with one cohort ID, one routeability board ID, and a finite reason list.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- Torghut live revision `torghut-00272` and simulation revision `torghut-sim-00372` were both available at `1/1`.
- Both active revisions used image digest
  `sha256:05fd4b6fc045a50adb049acc98c34278592cea12786aa08597d259ea05c0b464`.
- Torghut Postgres, ClickHouse, Keeper, TA, TA simulation, options TA, WebSocket services, options catalog, options
  enricher, Symphony, Alloy, and guardrail exporters were running.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Recent Torghut events showed revision `00272` rollout, database migrations, empirical and whitepaper backfills
  completing, options readiness transients, Flink status-modified-externally warnings, and duplicate ClickHouse PDB
  warnings.
- The service account could read deployments, pods, services, and events, but could not list Knative services or exec
  into database pods.

### Live Capital And Data Evidence

- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, empirical jobs, DSPy non-live mode, and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage had one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live execution TCA had 7334 orders, 7245 filled executions, latest TCA at `2026-05-07T14:23:43.480686+00:00`,
  average absolute slippage `13.8203637593029676` bps, and guardrail `8` bps.
- Live symbol routing showed zero routeable symbols, five blocked symbols (`AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`),
  and three missing symbols (`AMZN`, `GOOGL`, `ORCL`).
- Live quant evidence had 144 latest metrics updated at `2026-05-07T16:23:26.613Z`, but max stage lag was
  `524848` seconds.

### Simulation Evidence

- Simulation `/readyz` returned HTTP `200` in paper mode.
- Simulation proof floor remained `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  `max_notional=0`.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `market_context_stale`.
- Simulation TCA had four orders, five filled executions, latest TCA at `2026-05-06T18:00:43.661339+00:00`, one
  unsettled execution, average absolute slippage `5.577112285` bps, one routeable symbol (`NVDA`), and seven missing
  symbols.
- Simulation quant evidence was degraded with zero latest metrics and no pipeline stages.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and should not absorb another capital decision subsystem.
- `services/torghut/app/trading/proof_floor.py` is 680 lines and already emits floor state, route state, blockers,
  proof dimensions, and repair ladder entries.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA and symbol routeability metrics.
- `services/torghut/app/trading/revenue_repair.py` is 638 lines and can inform repair value, but it does not yet own
  capital cohort settlement.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and remains the deterministic submission gate.
- The current source contains proof-floor and TCA tests, but the missing test surface is capital cohort classification
  across live/sim routeability, Jangar launch quarantine, market context, quant stage lag, and paper/live submission
  policy.

## Problem

Torghut can explain why capital is closed, but it does not yet rank routeability repairs by cohort. That matters
because the current live and simulation states are different in a way that can be misread:

1. Live has zero routeable symbols and must remain zero-notional.
2. Simulation has one routeable symbol and HTTP 200, but still lacks route universe completeness, market context, and
   alpha readiness.
3. Quant latest metrics can be fresh while a required ingestion stage is stale by days.
4. A new service revision can be available without proving a profitable capital cohort.
5. Jangar can be serving while launch quarantine still holds dispatch, merge, and capital classes.

The missing object is a capital frontier that says which cohort is observation-only, which is repairable, and what
measured change would make the next cohort capital-eligible.

## Alternatives Considered

### Option A: Keep Proof Floor As The Only Capital Frontier

Pros:

- It already fails closed.
- It is visible in `/readyz`.
- It captures the major blockers: routeability, market context, alpha readiness, and submission policy.

Cons:

- It does not group evidence by service revision, account, proof window, and Jangar execution cohort.
- It ranks repair ladder items but does not settle before/after routeability by capital cohort.
- It cannot tell deployers whether a green simulation route belongs to a capital-eligible cohort.

Decision: reject as insufficient.

### Option B: Promote Simulation NVDA To A Paper Canary

Pros:

- It would create a fast learning loop.
- NVDA is currently routeable in simulation and within the aggregate slippage guardrail.
- It would generate paper fills and fresh TCA faster than waiting for all eight symbols.

Cons:

- Seven symbols are still missing in simulation.
- Market context and alpha readiness still block paper capital.
- Jangar launch quarantine and source/GitOps provenance are not current.
- A single-symbol canary would overfit the easiest route rather than repair the routeable universe.

Decision: reject. NVDA is a repair candidate, not capital authority.

### Option C: Add Capital Cohort Frontier And Routeability Repair Board

Pros:

- Separates observation, repair, paper canary, and live capital by cohort.
- Makes routeability repair measurable and rankable by expected unblock value.
- Binds capital receipts to Jangar execution cohorts and launch quarantine.
- Keeps live zero-notional while still letting the system learn from sim and repair evidence.

Cons:

- Adds a reducer and optional persistence surface.
- Requires before/after snapshots to avoid false repair credit.
- Keeps paper and live capital closed until routeability, market context, alpha readiness, quant freshness, and Jangar
  proof converge.

Decision: select Option C.

## Architecture

Add a pure `capital_cohort_frontier` reducer under `services/torghut/app/trading/`. It consumes proof-floor output,
TCA symbol routes, market-context freshness, alpha readiness, quant evidence, submission policy, service revision,
account label, and the Jangar execution cohort settlement exposed by Jangar.

`CapitalCohortFrontier` fields:

- `frontier_id`
- `account_label`
- `service_revision`
- `image_digest`
- `proof_window_start`
- `proof_window_end`
- `capital_surface`: `observe`, `repair`, `paper_canary`, `live_micro_canary`, or `live_scale`
- `jangar_execution_cohort_id`
- `jangar_launch_quarantine_decision`
- `proof_floor_state`
- `route_state`
- `capital_state`
- `routeable_symbol_count`
- `blocked_symbol_count`
- `missing_symbol_count`
- `routeable_symbols`
- `blocked_symbols`
- `missing_symbols`
- `tca_guardrail_bps`
- `avg_abs_slippage_bps`
- `market_context_state`
- `alpha_readiness_state`
- `quant_stage_lag_seconds`
- `submission_policy_state`
- `decision`: `allow`, `repair_only`, `hold`, or `block`
- `max_notional`
- `blocking_reason_codes`
- `fresh_until`
- `rollback_target`

`RouteabilityRepairBoard` fields:

- `board_id`
- `generated_at`
- `frontier_id`
- `account_label`
- `candidate_repairs`
- `selected_repair_ids`
- `rejected_repair_ids`
- `expected_unblock_value`
- `expected_post_cost_edge_bps_delta`
- `required_jangar_cohort_ref`
- `fresh_until`
- `rollback_target`

`RouteabilityRepairCandidate` fields:

- `repair_id`
- `repair_dimension`: `route_universe`, `market_context`, `alpha_readiness`, `quant_ingestion`, `execution_tca`, or
  `submission_policy`
- `symbols`
- `state_before`
- `target_state`
- `routeable_symbols_before`
- `routeable_symbols_target`
- `blocked_symbols_before`
- `missing_symbols_before`
- `avg_abs_slippage_bps_before`
- `target_avg_abs_slippage_bps`
- `quant_lag_before_seconds`
- `target_quant_lag_seconds`
- `capital_effect`: `none`, `observe`, `paper_candidate`, `live_micro_candidate`, or `live_scale_candidate`
- `expected_unblock_value`
- `guardrails`
- `rollback_target`

Capital rules:

- `observe` is allowed when dependencies are healthy enough to measure and Jangar permits `torghut_observe`.
- `repair` is allowed with zero notional when Jangar launch quarantine permits bounded repair dispatch or observation.
- `paper_canary` requires at least two routeable scoped symbols, fresh market context, alpha readiness, quant stage lag
  below 900 seconds for required stages, current Jangar execution cohort, and paper submission policy.
- A single-symbol simulation cohort is `repair_only` unless an explicit exception sets max notional to zero.
- `live_micro_canary` requires live routeability, passing scoped TCA, live submission enabled, current Jangar launch
  quarantine, and paper settlement history.
- `live_scale` requires sustained live micro evidence across at least two independent sessions and no stale Jangar or
  Torghut cohort evidence.

## Measurable Trading Hypotheses

Hypothesis 1: If live routeability repairs remove missing and high-slippage symbols from the active capital cohort,
routeable live symbol count should move from 0 to at least 2 before any paper canary is considered. Guardrail:
`max_notional=0` until two symbols satisfy the scoped TCA guardrail.

Hypothesis 2: If simulation NVDA is retained as an observation-only repair candidate, it should produce fresh paper TCA
without widening capital to the seven missing symbols. Guardrail: single-symbol simulation cohorts cannot leave
`repair_only` without a named exception and zero notional.

Hypothesis 3: If quant ingestion is repaired, `max_stage_lag_seconds` should move from `524848` to below 900 for the
live required stages before live micro canary is considered. Guardrail: fresh latest metrics alone are not enough.

Hypothesis 4: If market-context refresh becomes current for the active hypothesis window, the blocker list should lose
`market_context_stale` without changing capital until routeability and alpha readiness also pass. Guardrail:
market-context freshness cannot override routeability.

Hypothesis 5: If Jangar launch quarantine becomes current and source/GitOps provenance is present, Torghut can cite the
Jangar execution cohort in paper receipts. Guardrail: quarantined or retired Jangar cohorts cannot be cited for capital.

## Validation Gates

Engineer acceptance gates:

- Add unit tests for live zero routeable symbols, simulation one routeable symbol, stale market context, stale quant
  ingestion, missing alpha readiness, and disabled live submission.
- Add a fixture where Jangar launch quarantine is `hold` and prove all capital surfaces stay zero-notional.
- Add a fixture where Jangar launch quarantine is current but routeability is incomplete and prove paper remains held.
- Add a fixture where two paper symbols are routeable, market context is fresh, alpha is ready, quant lag is below
  threshold, and Jangar cohort is current; prove paper canary is bounded.
- Add before/after repair-board tests for route universe repair and quant ingestion repair.
- Keep reducer logic out of `main.py`; use a small module under `services/torghut/app/trading/`.

Deployer acceptance gates:

- Live `/readyz` may remain HTTP 503; verify it exposes `capital_cohort_frontier` and still reports zero-notional.
- Simulation `/readyz` may be HTTP 200; verify one-symbol routeability remains repair-only.
- Confirm routeability board ranks `route_universe`, `alpha_readiness`, `execution_tca`, and `market_context` repairs.
- Confirm any paper canary cites `jangar_execution_cohort_id` and has `max_notional=0` until all paper gates pass.
- Confirm live micro canary and live scale remain blocked while live submission is disabled or routeable live symbols
  are zero.

Suggested targeted validation commands:

```bash
uv run --frozen pytest services/torghut/tests -k "proof_floor or tca or capital"
uv run --frozen pyright --project services/torghut/pyrightconfig.json
uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json
uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json
bunx oxfmt --check docs/torghut/design-system/v6/159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md
```

## Rollout Plan

Phase 1 publishes `capital_cohort_frontier` and `routeability_repair_board` in shadow mode from readiness and status
routes. Existing proof-floor behavior remains authoritative.

Phase 2 wires Jangar execution cohort IDs into the frontier when Jangar publishes them. Missing Jangar cohort evidence
keeps capital zero-notional.

Phase 3 lets repair automation consume the routeability board for zero-notional repair work: route universe pruning,
market-context refresh, quant ingestion repair, and TCA refresh.

Phase 4 allows bounded paper canary only after at least two scoped paper symbols pass routeability and all noncapital
proof gates are current.

Phase 5 considers live micro canary only after paper settlement history exists, live routeability is non-empty, live
submission is explicitly enabled, and Jangar launch quarantine is current.

## Rollback

- Disable frontier consumption and keep existing proof-floor behavior in charge.
- Continue publishing frontier and repair board as audit-only evidence if the reducer is healthy.
- If the reducer fails, omit `capital_cohort_frontier` and keep proof-floor zero-notional behavior.
- Keep live submission disabled and `max_notional=0`.
- Expire any paper candidate receipts that cite missing, quarantined, retired, or expired Jangar cohorts.

## Risks And Mitigations

- Risk: a repair board can over-rank a cheap repair with no profit value. Mitigation: require expected unblock value and
  expected post-cost edge delta, not only readiness improvement.
- Risk: simulation routeability can be mistaken for live capital readiness. Mitigation: paper and live cohorts are
  separate, and live capital requires live routeability plus paper settlement history.
- Risk: fresh quant latest metrics can mask stale ingestion. Mitigation: required-stage max lag is part of the frontier.
- Risk: Jangar cohort settlement may lag Torghut readiness. Mitigation: missing or held Jangar cohort evidence keeps
  capital zero-notional.
- Risk: before/after repair snapshots can be noisy. Mitigation: repairs need proof windows and scoped symbols before
  claiming capital effect.

## Handoff To Engineer

Implement `capital_cohort_frontier` as a pure reducer over existing proof-floor, TCA, market-context, quant, submission,
and Jangar evidence. Do not add the logic to `main.py`. Start with shadow output and fixtures matching the current live
and simulation evidence: zero live routeable symbols, one simulation routeable symbol, stale market context, stale live
quant ingestion, disabled live submission, and missing Jangar cohort authority.

## Handoff To Deployer

Before allowing paper or live capital, require:

- `capital_cohort_frontier.decision=allow` for the exact account, service revision, and proof window.
- `routeable_symbol_count >= 2` for paper canary and nonzero live routeability for live micro canary.
- `jangar_execution_cohort_id` is current and launch quarantine is not held or blocked.
- `max_notional=0` unless all selected capital gates pass.
- Live submission remains disabled until live micro canary gates explicitly pass.

## Open Questions

- Should routeability board candidates persist in Postgres, ClickHouse, or both?
- Should the first paper canary require two routeable semiconductor names or one semiconductor plus one broad-market
  hedge?
- What should the minimum paper fill count be before a live micro canary can consume a cohort receipt?
- Should quant ingestion repair own the route universe refresh, or should those remain separate repair dimensions?
