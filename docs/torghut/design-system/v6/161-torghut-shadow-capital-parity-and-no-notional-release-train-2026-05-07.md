# 161. Torghut Shadow Capital Parity And No-Notional Release Train (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, shadow capital parity, zero-notional release safety, routeability repair, Jangar
enforcement release train consumption, validation, rollback, and implementation acceptance gates.

Companion Jangar contract:

- `docs/agents/designs/157-jangar-shadow-parity-ledger-and-enforcement-release-train-2026-05-07.md`

Extends:

- `159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `158-torghut-capital-proof-provenance-and-routeable-edge-repair-ledger-2026-05-07.md`
- `157-torghut-profit-contract-actuation-and-capital-surface-truth-2026-05-07.md`

## Decision

I am selecting shadow capital parity with a no-notional release train as the next Torghut profitability architecture
step.

Torghut is correctly refusing capital. Live `/readyz` is degraded, live proof floor is `repair_only`, capital state is
`zero_notional`, simple submit is disabled, live routeable symbol count is zero, and average absolute slippage is above
the guardrail. Simulation is healthier at the HTTP level, but it is not a capital signal. It has one probing `NVDA`
route, seven missing symbols, stale market context, shadow-only alpha readiness, and zero notional.

The useful next step is not to widen paper or live capital. It is to measure whether shadow capital decisions would
have agreed with the existing zero-notional gates, and to rank repairs by the evidence they would produce without
raising notional. Torghut should publish `shadow_capital_parity` and `no_notional_release_train`. These records compare
proof-floor, route-reacquisition, market-context, alpha, quant, and submission decisions against actual order-admission
and realized data outcomes. They also consume Jangar's `enforcement_release_train` so a Torghut paper or live gate
cannot promote while Jangar material action parity is still shadow-only.

The tradeoff is that useful simulation repair work remains explicitly zero-notional. I accept that. We can learn from
sim, route repairs, and market-context refreshes without pretending they are paper-capital authority.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `shadow_capital_parity` and `no_notional_release_train` from `/readyz`, `/trading/health`, and
  `/trading/status`.
- Live capital remains `zero_notional` when live routeable symbol count is zero, live submit is disabled, market
  context is stale, alpha readiness is shadow-only, or Jangar material enforcement is not promoted.
- Simulation can produce repair candidates, but a probing route cannot become a paper canary until its parity record
  proves no unsafe false allows and no unresolved dependency receipt gaps.
- Every capital surface has a release state: `shadow_collecting`, `repair_candidate`, `paper_candidate`,
  `paper_enforced`, `live_candidate`, `live_enforced`, `rollback`, or `blocked`.
- `false_capital_allow` blocks promotion immediately.
- `false_capital_hold` is recorded as opportunity cost and may be accepted only when the measured post-cost edge is
  positive and Jangar parity is promoted.
- Route repair records carry before/after routeable symbols, missing symbols, blocked symbols, TCA, market-context
  state, alpha state, quant evidence, and Jangar release-train ref.
- Deployer checks can reject capital with one release-train state, one parity epoch, and a finite blocker list.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- Torghut live deployment `torghut-00273-deployment` was available during the Kubernetes pass, and the runtime status
  endpoint reported revision `torghut-00274` during the HTTP pass.
- Torghut simulation deployment `torghut-sim-00373-deployment` was available during the Kubernetes pass, and the
  runtime status endpoint reported revision `torghut-sim-00374` during the HTTP pass.
- Torghut Postgres, ClickHouse, Keeper, TA, TA simulation, options TA, options catalog, options enricher, WebSocket
  services, guardrail exporters, Symphony, and Alloy were running.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Argo CD reported `torghut` as healthy but out of sync, and `torghut-options` as healthy after a recent successful
  sync.
- The service account could read deployments, pods, services, and events, but could not list Knative services, CNPG
  clusters, or secrets. Typed endpoints are the available data witnesses.

### Live Capital And Data Evidence

- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, empirical job reachability, DSPy non-live runtime mode, and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage had one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live submission gate was closed: `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`.
- Live alpha readiness had three shadow hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- Live execution TCA had 7334 orders, 7245 filled executions, latest TCA at `2026-05-07T14:23:43.480686Z`, average
  absolute slippage `13.8203637593029676` bps, and guardrail `8` bps.
- Live routeability had zero routeable symbols, five blocked symbols (`AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`), and
  three missing symbols (`AMZN`, `GOOGL`, `ORCL`).
- Live market context was stale with no current domain state.
- Live quant evidence was informational, not a capital allow: latest metrics existed, but update/stage evidence was
  incomplete.

### Simulation Evidence

- Simulation `/readyz` returned HTTP `200`.
- Simulation proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and
  `max_notional=0`.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, and `market_context_stale`.
- Simulation live-submission equivalent gate was pass for non-live mode, but capital remained zero-notional.
- Simulation TCA had four orders, five filled executions, one unsettled execution, latest TCA at
  `2026-05-06T18:00:43.661339Z`, average absolute slippage `5.577112285` bps, and guardrail `8` bps.
- Simulation routeability had one probing symbol (`NVDA`) and seven missing symbols.
- Simulation quant evidence had zero latest metrics and no pipeline stages.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` already emits proof dimensions, blocker lists, repair ladders, and a
  route reacquisition book.
- `services/torghut/app/trading/route_reacquisition.py` builds symbol-level route repair records but does not measure
  shadow decision parity against actual no-notional order admission.
- `services/torghut/app/trading/tca.py` owns execution TCA and routeability metrics.
- `services/torghut/app/trading/submission_council.py` remains the deterministic final submission gate and should
  consume release-train state rather than becoming the parity registry.
- Existing tests cover proof floor, route reacquisition, TCA, submission policy, scheduler safety, and trading API
  readiness. The missing test surface is shadow capital parity across live zero-notional, simulation probing routes,
  market-context staleness, alpha readiness, quant evidence, and Jangar enforcement state.

## Problem

Torghut has conservative blockers, but it does not yet prove whether shadow capital decisions are safe to enforce. That
matters because the current live and simulation states can be misread:

1. Live has zero routeable symbols and must remain zero-notional.
2. Simulation has one probing route and HTTP 200, but still lacks market context, alpha readiness, quant receipts, and
   route universe completeness.
3. A non-live submission gate can pass while capital should stay zero-notional.
4. Jangar can expose useful shadow material verdicts without proving they are enforceable.
5. Repair candidates can look productive even when they do not improve post-cost routeable edge.

The missing object is a capital parity ledger that compares proposed shadow capital behavior against actual safe
behavior before any paper or live notional is allowed.

## Alternatives Considered

### Option A: Promote Simulation `NVDA` To A Paper Canary

Pros:

- Fast feedback loop.
- `NVDA` is the one simulation symbol with TCA under the aggregate guardrail.
- Could generate fresh paper TCA and execution outcomes.

Cons:

- Seven simulation symbols are missing.
- Market context is stale and alpha readiness is not promotion eligible.
- Jangar material gates are not promoted to enforcement.
- A single route canary would hide route-universe incompleteness.

Decision: reject. `NVDA` is a repair candidate, not capital authority.

### Option B: Keep Proof Floor As The Only Capital Gate

Pros:

- It already fails closed.
- It is visible in live and simulation readiness.
- It carries enough blockers to prevent accidental notional today.

Cons:

- It does not compare shadow capital decisions against actual order-admission outcomes.
- It does not quantify false holds or false allows.
- It cannot tell deployers when a repair-only simulation signal has enough parity to become paper.

Decision: reject as incomplete.

### Option C: Add Shadow Capital Parity And No-Notional Release Train

Pros:

- Keeps live and paper notional at zero while learning from shadow decisions.
- Measures false capital allows before any enforcement.
- Ranks repairs by expected post-cost routeability, not just blocker priority.
- Binds capital promotion to Jangar's enforcement release train.

Cons:

- Adds a reducer and likely compact persistence after the report-only phase.
- Requires before/after repair samples before paper can move.
- Will keep capital closed longer than a single-symbol paper probe.

Decision: select Option C.

## Architecture

Add `shadow_capital_parity` under `services/torghut/app/trading/`. It consumes proof floor output, route reacquisition
records, TCA, market context state, alpha readiness, quant evidence, submission policy, account/revision identity, and
Jangar enforcement release-train state.

`ShadowCapitalParityRecord` fields:

- `record_id`
- `account_label`
- `service_revision`
- `mode`: `live` or `paper`
- `capital_surface`: `observe`, `repair`, `paper`, `live_micro`, or `live_scale`
- `proof_floor_ref`
- `route_reacquisition_ref`
- `jangar_release_train_ref`
- `shadow_decision`
- `actual_decision`
- `decision_delta`: `match`, `false_capital_allow`, `false_capital_hold`, `incomparable`, or `unknown`
- `proposed_notional`
- `actual_notional`
- `routeable_symbol_count`
- `blocked_symbol_count`
- `missing_symbol_count`
- `candidate_symbols`
- `avg_abs_slippage_bps`
- `tca_guardrail_bps`
- `market_context_state`
- `alpha_readiness_state`
- `quant_evidence_state`
- `sample_count`
- `false_capital_allow_count`
- `false_capital_hold_count`
- `expected_post_cost_edge_bps_delta`
- `fresh_until`
- `blocking_reason_codes`
- `rollback_target`

`NoNotionalReleaseTrain` fields:

- `release_train_id`
- `generated_at`
- `fresh_until`
- `account_label`
- `mode`
- `capital_surface`
- `current_state`: `shadow_collecting`, `repair_candidate`, `paper_candidate`, `paper_enforced`,
  `live_candidate`, `live_enforced`, `rollback`, or `blocked`
- `required_clean_windows`
- `observed_clean_windows`
- `required_routeable_symbols`
- `required_jangar_state`
- `unsafe_false_allow_count`
- `accepted_false_hold_count`
- `selected_repair_ids`
- `promotion_blockers`
- `max_notional`
- `rollback_target`

State rules:

- `shadow_collecting`: parity records exist, but sample or clean-window requirements are not met.
- `repair_candidate`: zero-notional repair is useful and safe.
- `paper_candidate`: paper notional can be considered only after routeability, market context, alpha, quant, and
  Jangar parity are clean.
- `paper_enforced`: paper admission is allowed with bounded notional and rollback receipt.
- `live_candidate`: live micro-canary can be considered after paper enforcement has clean exits.
- `live_enforced`: live notional can route only with all capital contracts live and passing.
- `rollback`: promotion was disabled after a parity regression.
- `blocked`: a hard blocker remains, including any false capital allow.

Initial release policy:

- Live stays `blocked` while routeable symbol count is zero or submit is disabled.
- Simulation stays `repair_candidate` at most while routeable symbol count is below two, market context is stale, or
  alpha readiness is shadow-only.
- No mode can become `paper_candidate` until Jangar `paper_canary` release state is at least `parity_candidate`.
- No live mode can become `live_candidate` until paper has enforced and rolled back cleanly.

## Measurable Trading Hypotheses

Hypothesis 1: A route repair that moves at least two symbols from missing or blocked to routeable while keeping average
absolute slippage at or below `8` bps should reduce false capital holds without increasing false capital allows.
Guardrail: no paper notional until `false_capital_allow_count=0` across the required windows.

Hypothesis 2: Market-context refresh should improve alpha promotion readiness only when it is tied to the same
routeability cohort. Metric: increase in promotion-eligible hypotheses and decrease in stale market-context blockers
for the same account, service revision, and proof window. Guardrail: stale or absent domain state keeps max notional at
zero.

Hypothesis 3: A single simulation probing symbol is not enough to justify paper capital. Metric: expected unblock value
must include route-universe completeness, not just the presence of one candidate symbol. Guardrail: require at least
two routeable scoped symbols, no unsettled execution count, and Jangar paper parity before paper canary.

## Validation Gates

Engineer validation:

- Add `services/torghut/app/trading/shadow_capital_parity.py`.
- Add tests where live zero routeable symbols keep the release train `blocked`.
- Add tests where simulation `NVDA` is probing but seven missing symbols keep state `repair_candidate`.
- Add tests where shadow allow against actual zero-notional records `false_capital_allow`.
- Add tests where shadow hold against a passing repair candidate records `false_capital_hold` without allowing notional.
- Add tests where absent Jangar release-train state blocks paper and live promotion.

Deployer validation:

- Query live and simulation `/readyz` and `/trading/status`.
- Require `shadow_capital_parity.false_capital_allow_count=0`.
- Require `no_notional_release_train.current_state` to match the requested capital surface.
- Require live proof floor not `repair_only`, routeable symbols above threshold, market context fresh, alpha readiness
  promotable, quant evidence current, and Jangar release train promoted.
- If any condition fails, keep `capital_state=zero_notional` and allow only observe or zero-notional repair.

## Rollout

Phase 0 ships parity records in live and simulation status with no order-admission impact.

Phase 1 ranks zero-notional repair candidates from parity records and route reacquisition records.

Phase 2 permits paper candidate review only after clean parity windows and Jangar paper parity.

Phase 3 enforces bounded paper notional with explicit rollback and TCA settlement.

Phase 4 considers live micro-canary only after paper has clean realized outcomes and a tested rollback.

## Rollback

Rollback is simple and must stay simple:

1. Set the requested capital surface back to `blocked` or `rollback`.
2. Force `max_notional=0`.
3. Keep parity and repair records visible.
4. Disable paper/live submission before disabling repair scoring.
5. Require new clean parity windows before any future promotion.

Rollback must never remove proof-floor blockers or route-reacquisition records. Those records are the audit trail for
why notional stayed closed.

## Risks And Tradeoffs

- The parity ledger can slow paper experimentation. That is intentional while live has zero routeable symbols and
  stale market context.
- False holds can hide opportunity cost. The ledger records them, but only false allows block promotion automatically.
- Repair scoring can overfit to one symbol. The release train requires route-universe thresholds before paper.
- Jangar parity is now a hard dependency for capital promotion. This keeps the systems honest: if Jangar cannot say a
  material gate is promoted, Torghut cannot cite it as capital authority.

## Handoff To Engineer

Implement this as a pure reducer first. Keep proof floor and submission council authoritative. The smallest useful
slice is:

1. Build `ShadowCapitalParityRecord` from proof floor, route reacquisition, and actual notional state.
2. Publish `shadow_capital_parity` and `no_notional_release_train` in live and simulation status payloads.
3. Add tests for live blocked, simulation repair candidate, false capital allow, false capital hold, and missing
   Jangar parity.
4. Do not change order admission in the first implementation.

## Handoff To Deployer

For the current evidence window, live remains blocked and simulation remains repair-only. Do not promote `NVDA` to a
paper canary. Use the parity release train to decide which zero-notional repairs are worth running, then require clean
parity windows before any paper or live notional change.
