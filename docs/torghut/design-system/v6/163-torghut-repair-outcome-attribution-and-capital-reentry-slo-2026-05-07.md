# 163. Torghut Repair Outcome Attribution And Capital Reentry SLO (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

I am selecting repair outcome attribution with capital reentry SLOs as the next Torghut profitability architecture
step.

Torghut is failing closed correctly. Live `/readyz` returns HTTP 503, proof floor is `repair_only`, capital state is
`zero_notional`, simple submit is disabled, market context is stale, alpha readiness has three shadow hypotheses with
zero promotion-eligible hypotheses, and live routeability has zero routeable symbols. Simulation returns HTTP 200, but
it is also repair-only and zero-notional with one probing `NVDA` route, seven missing symbols, stale market context, and
empty latest quant metrics.

The current design chain can refill evidence and rank route repairs, but it still lacks a capital-grade answer to a
hard question: did the repair retire the blocker it claimed to address? Torghut should publish a
`repair_outcome_attribution` ledger and `capital_reentry_slos`. The ledger compares before and after proof-floor,
routeability, TCA, market-context, alpha-readiness, quant-evidence, and submission-council state. The SLOs decide
whether a repair is useful, whether paper can be considered, and whether live must remain zero-notional.

The tradeoff is that some apparently useful repair work will not count toward capital. I accept that. Capital should
move only when outcome attribution proves the blocker changed and Jangar's companion ledger allows the matching action
class.

This extends the earlier capital repair outcome ledger instead of replacing it. Document 155 defined repair ROI and
edge reacquisition. This decision binds that outcome accounting to the newer profit-evidence refill lane, Jangar
material-action reentry SLOs, and explicit paper/live zero-notional rollback.

## Runtime Objective And Success Metrics

Success means:

- `/readyz`, `/trading/status`, and `/trading/autonomy` expose `repair_outcome_attribution` and
  `capital_reentry_slos`.
- Every empirical refresh, quant projection refill, market-context refresh, routeability repair, and TCA refresh has a
  before proof ref, after proof ref, target blocker, observed delta, and Jangar repair outcome ref.
- A repair can be `executed` while still `ineffective`; only `validated` repairs can advance paper reentry.
- Paper reentry requires proof-floor blocker retirement, at least two routeable symbols, fresh market context,
  promotion-eligible alpha readiness, nonempty quant latest metrics, TCA within guardrail, and Jangar
  `paper_canary` reentry SLO state.
- Live micro reentry additionally requires paper reentry with clean exits, route provenance coverage, no rollback
  alpha entries, and explicit live submission approval.
- Live capital remains `zero_notional` when any target blocker is unchanged, regressed, stale, or incomparable.
- Deployer output can explain capital state from one SLO state and one blocker delta list.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 around 18:09Z. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, GitOps resources, AgentRun objects, or trading flags.

### Runtime And Cluster Evidence

- Argo CD reported `torghut` synced but `Progressing` during the active rollout; `torghut-options` was synced and
  healthy.
- Active live and simulation Knative-backed deployments were `torghut-00276-deployment=1/1` and
  `torghut-sim-00376-deployment=1/1`.
- Older Torghut revisions were scaled to zero, and the latest image digest was shared across Torghut app, options
  catalog, and options enricher.
- Torghut TA and TA simulation deployments had just rolled and were creating task managers; recent events included
  startup probe refusals and Flink job initialization transitions.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`.
- The service account could read Torghut pods but could not read Torghut secrets.

### Live Data Evidence

- Live `/readyz` returned HTTP `503`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  readiness cache, empirical job reachability, DSPy non-live mode, and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage had one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live submission gate was closed with reason `simple_submit_disabled` and capital stage `shadow`.
- Live TCA had 7334 orders, 7245 filled executions, latest TCA at `2026-05-07T14:23:43.480686Z`, average absolute
  slippage about `13.82` bps, and guardrail `8` bps.
- Live routeability had zero routeable symbols, five blocked symbols, and three missing symbols.
- Live market context had no current domain states and was stale.
- Live quant evidence for `PA3SX7FYNUTF/15m` had 144 latest metrics, latest metrics at
  `2026-05-07T18:08:23.057Z`, no pipeline stages, and a missing update alarm.

### Simulation Evidence

- Simulation `/readyz` returned HTTP `200`.
- Simulation proof floor was `repair_only`, route state `repair_only`, and capital state `zero_notional`.
- Simulation blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_incomplete`, and `market_context_stale`.
- Simulation routeability had one probing symbol, `NVDA`, seven missing symbols, and zero routeable symbols.
- Simulation TCA had four orders, five filled executions, latest execution at `2026-05-07T09:20:27.213660Z`, and
  average absolute slippage `5.577112285` bps.
- Simulation quant evidence for `TORGHUT_SIM/15m` had zero latest metrics, empty latest store alarm, and no pipeline
  stages.
- Simulation market context was stale and alpha readiness had three shadow hypotheses, zero promotion-eligible
  hypotheses, and three rollback-required hypotheses.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` owns proof-floor dimensions, blocker lists, repair ladders, and the
  route reacquisition book.
- `services/torghut/app/trading/route_reacquisition.py` already ranks route repair candidates, including the
  `reduce_execution_slippage_before_route_reentry` path.
- `services/torghut/app/trading/tca.py` owns cost and routeability metrics.
- `services/torghut/app/trading/submission_council.py` remains the deterministic final order gate.
- `services/torghut/app/trading/revenue_repair.py` can score repair value but does not yet settle whether a repair
  changed a capital blocker.
- Existing tests cover proof floor behavior, route reacquisition, TCA, submission policy, trading API readiness, and
  revenue repair digests. The missing test surface is repair outcome attribution across executed but unchanged,
  improved, retired, regressed, and capital-blocked repairs.

## Problem

Torghut has repair candidates, but it does not yet have capital-grade repair accounting. That creates five risks:

1. A stale empirical job refresh can complete without changing dependency quorum.
2. A quant projection can become nonempty without making alpha readiness, routeability, or market context suitable for
   paper.
3. A route repair can improve simulation while live remains zero routeable.
4. A lower TCA value can still be irrelevant if route universe coverage is incomplete.
5. Jangar can allow bounded repair while still holding `paper_canary`, and Torghut needs to reflect that distinction.

The missing object is a repair outcome ledger whose capital result is based on blocker deltas, not repair execution.

## Alternatives Considered

### Option A: Promote The Best Simulation Route After Refill

Pros:

- Fastest way to produce paper feedback.
- Uses the existing `NVDA` probing route and low simulation slippage.
- Could test the submission path quickly.

Cons:

- Live has zero routeable symbols and live slippage remains above guardrail.
- Simulation still has seven missing symbols and empty quant metrics.
- Market context is stale and alpha readiness is not promotion eligible.
- Jangar still holds paper and live action classes.

Decision: reject. `NVDA` is repair evidence, not a paper authority.

### Option B: Use Proof Floor Alone As The Reentry SLO

Pros:

- Simple and already visible.
- It fails closed today.
- It lists the blockers that matter for capital.

Cons:

- It does not attribute which repair changed which blocker.
- It cannot price opportunity cost from false holds.
- It cannot distinguish executed repair from validated repair.

Decision: reject as insufficient for capital reentry.

### Option C: Add Repair Outcome Attribution And Capital Reentry SLOs

Pros:

- Measures blocker deltas across proof floor, routeability, TCA, market context, alpha, quant, and submission.
- Keeps repair useful while capital remains zero-notional.
- Binds Torghut paper/live reentry to Jangar action-class reentry.
- Produces measurable trading hypotheses and rollback triggers.

Cons:

- Adds a reducer and possibly persistence after the report-only phase.
- Requires repair classes to name their target blocker before they run.
- Will reject completed but ineffective repairs.

Decision: select Option C.

## Architecture

Add a pure `repair_outcome_attribution` reducer under `services/torghut/app/trading/`. It consumes proof-floor output,
route reacquisition records, TCA metrics, market-context state, alpha readiness, quant evidence, submission-council
state, and the Jangar repair outcome ledger.

`RepairOutcomeAttribution` fields:

- `outcome_id`
- `repair_intent_id`
- `repair_class`: `empirical_refresh`, `quant_projection_refill`, `market_context_refresh`, `routeability_repair`,
  `tca_refresh`, `alpha_readiness_repair`, or `submission_gate_repair`
- `account_label`
- `trading_mode`: `live` or `simulation`
- `service_revision`
- `image_digest`
- `jangar_repair_outcome_ref`
- `target_blocker`
- `before_proof_floor_ref`
- `after_proof_floor_ref`
- `before_state`
- `after_state`
- `before_routeable_symbol_count`
- `after_routeable_symbol_count`
- `before_avg_abs_slippage_bps`
- `after_avg_abs_slippage_bps`
- `before_market_context_state`
- `after_market_context_state`
- `before_alpha_readiness_state`
- `after_alpha_readiness_state`
- `before_quant_state`
- `after_quant_state`
- `decision_delta`: `retired`, `improved`, `unchanged`, `regressed`, `incomparable`, or `unknown`
- `capital_effect`: `none`, `paper_candidate`, `paper_hold`, `live_candidate`, or `live_hold`
- `expected_post_cost_edge_bps_delta`
- `observed_post_cost_edge_bps_delta`
- `fresh_until`
- `rollback_target`
- `reason_codes`

`CapitalReentrySlo` fields:

- `slo_id`
- `capital_surface`: `observe`, `repair`, `paper_canary`, `live_micro`, or `live_scale`
- `state`: `zero_notional`, `repair_only`, `paper_candidate`, `paper_allowed`, `live_candidate`, `live_allowed`,
  `rollback`, or `blocked`
- `required_outcome_classes`
- `required_clean_outcomes`
- `observed_clean_outcomes`
- `proof_floor_blockers`
- `unretired_target_blockers`
- `jangar_required_slo_state`
- `latest_outcome_refs`
- `max_notional`
- `fresh_until`
- `rollback_target`

State rules:

- `zero_notional`: no paper or live notional can move.
- `repair_only`: repair work can run with `max_notional=0`.
- `paper_candidate`: all blocker deltas are clean, but deployer has not accepted the paper reentry window.
- `paper_allowed`: paper canary can run under bounded notional and rollback.
- `live_candidate`: live micro canary can be considered after paper exits are clean.
- `live_allowed`: live micro or scale can route only when all required SLOs and approvals are current.
- `rollback`: any capital-adjacent outcome regressed or lost Jangar authority.
- `blocked`: no repair or reentry is safe for the requested surface.

## Measurable Trading Hypotheses

- H1: empirical refresh retires the four stale empirical job blockers without changing capital authority.
- H2: quant projection refill moves `paper/1d` or `TORGHUT_SIM/15m` from empty to nonempty while leaving capital
  `zero_notional`.
- H3: routeability repair increases routeable symbols from zero to at least two while keeping average absolute
  slippage at or below the active guardrail.
- H4: market-context refresh produces current domain states for every candidate symbol before paper reentry.
- H5: paper reentry remains blocked if Jangar `paper_canary` reentry SLO is not `reentry_allowed`.
- H6: live micro reentry remains blocked if any rollback-required alpha hypothesis remains.

## Implementation Scope

Torghut engineer owns:

- Add typed dataclasses or dictionaries for `RepairOutcomeAttribution` and `CapitalReentrySlo`.
- Add pure reducer functions under `services/torghut/app/trading/`.
- Wire report-only reducer output into `/readyz`, `/trading/status`, and `/trading/autonomy`.
- Keep persistence optional until reducer tests prove stable report-only behavior.
- Add tests for executed but unchanged repair, improved but not retired blocker, retired empirical blocker, regressed
  routeability, quant refill without capital effect, Jangar SLO missing, paper candidate hold, and live rollback.

Jangar engineer owns:

- Publish repair outcome refs and material action reentry SLOs.
- Treat Torghut outcome attribution as a capital dependency, not as source truth.
- Keep `paper_canary`, `live_micro_canary`, and `live_scale` held unless both Jangar and Torghut SLOs are current.

## Validation Gates

Minimum local validation:

- `uv run --frozen pytest services/torghut/tests/test_route_reacquisition.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k 'alpha_readiness or control_plane_contract'`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `bunx oxfmt --check docs/torghut/design-system/v6/163-torghut-repair-outcome-attribution-and-capital-reentry-slo-2026-05-07.md`

Runtime acceptance:

- A completed empirical refresh that leaves dependency quorum blocked records `decision_delta=unchanged`.
- A quant refill that clears an empty latest store alarm records `capital_effect=none` until proof floor, alpha,
  market context, routeability, TCA, submission, and Jangar SLOs are clean.
- Simulation `NVDA` cannot become paper authority while seven symbols are missing and Jangar paper SLO is held.
- Live capital remains zero-notional while live routeable symbol count is zero or average absolute slippage exceeds
  the active guardrail.
- Any `rollback` state in Jangar or Torghut moves paper and live SLOs to `zero_notional`.

## Rollout Plan

1. Ship report-only reducer output on live and simulation status endpoints.
2. Record attribution for `empirical_refresh` and `quant_projection_refill` first.
3. Add `market_context_refresh`, `routeability_repair`, and `tca_refresh` after report-only output is stable.
4. Let paper reentry SLOs read Jangar `paper_canary` SLO, but keep paper notional zero.
5. Enable paper canary only after clean blocker deltas, Jangar `reentry_allowed`, and explicit deployer acceptance.
6. Defer live micro and live scale until paper exits are clean and live routeability is no longer zero.

## Rollback Plan

- Keep proof floor and submission council as the hard capital gates.
- Hide attribution from capital decisions while preserving report-only diagnostics.
- Force all capital reentry SLOs to `zero_notional` if attribution is unavailable, stale, or regressed.
- Disable any persistence writer without changing `/readyz` fail-closed behavior.
- Keep simple submit disabled until live proof floor and deployer approval both pass.

## Risks

- Repair attribution can credit unrelated drift. Mitigation: require before/after refs, target blockers, and Jangar
  repair outcome refs.
- Paper canary pressure can rise after simulation improves. Mitigation: require at least two routeable symbols, fresh
  market context, nonempty quant evidence, and Jangar `paper_canary` reentry.
- Live TCA can look fresh while the latest execution timestamp is old. Mitigation: include freshness and route universe
  completeness in every SLO.
- Opportunity cost from strict holds can hide profitable repair. Mitigation: track false holds and post-cost edge
  deltas, but keep `capital_effect=none` until all hard guards pass.

## Engineer And Deployer Handoff

Engineer handoff:

- Implement attribution as a pure reducer before adding storage.
- Add fixtures for unchanged, improved, retired, regressed, and incomparable blocker deltas.
- Keep proof floor and submission council authoritative for capital while the new SLO is report-only.
- Consume Jangar repair outcome refs as required evidence for paper and live reentry.

Deployer handoff:

- Do not treat a completed repair, nonempty quant projection, or simulation probing route as paper authority.
- Require `paper_allowed` for paper and `live_allowed` for live, with current Jangar SLO refs.
- Keep `max_notional=0` for every state except explicit paper/live allowed windows.
- Roll back to zero-notional on stale attribution, missing Jangar refs, routeability regression, TCA guardrail breach,
  alpha rollback, market-context staleness, or submission-council block.
