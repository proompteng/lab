# 185. Torghut Routeability Repair Acceptance Ledger (2026-05-08)

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

I am selecting a **routeability repair acceptance ledger** as Torghut's next bounded implementation milestone.

The system is serving, but it is not revenue-ready. Read-only checks at `2026-05-08T12:27Z` showed Torghut live revision
`torghut-00308` and Torghut sim revision `torghut-sim-00406` running `2/2`. Postgres and ClickHouse dependencies were
OK. `/db-check` returned current and expected Alembic head `0030_evidence_epochs`, with schema lineage ready and known
parent-fork warnings. Jangar quant runtime was enabled and had 144 latest metrics for `PA3SX7FYNUTF/15m`.

The business state remains blocked. `/readyz` returned `status=degraded`; live submission was closed by
`simple_submit_disabled`; proof floor was `repair_only`; capital state was `zero_notional`; and revenue repair digest
reported `revenue_ready=false`, `business_state=repair_only`, with blockers
`hypothesis_not_promotion_eligible`, `simple_submit_disabled`, and `quant_pipeline_stages_missing`. Market context
was stale for technicals, news, and regime. Quant latest metrics were present, but scoped pipeline stages were missing.

The next design step is not a broader proof marketplace or a paper probe. It is an acceptance ledger that says which
repair lots are good enough to count toward routeability, and which remain zero-notional evidence debt. The ledger
should make the current routeability claim explicit: Torghut may repair evidence, but it must not increase paper/live
capital or routeable candidate count until the lot's receipts settle.

## Business Metric And Value Gates

The business metric remains: increase routeable post-cost profit evidence and live trading readiness without weakening
capital safety.

The ledger maps every repair lot to a value gate:

- `routeable_candidate_count`: a candidate counts only after route/TCA, quant-stage, market-context, alpha, forecast,
  and Jangar admission receipts settle.
- `zero_notional_or_stale_evidence_rate`: missing scoped quant stages, stale market-context domains, missing route TCA,
  and underfunded promotion evidence are counted as stale evidence until receipts are current.
- `fill_tca_or_slippage_quality`: TCA repairs must improve route coverage or reduce slippage without threshold
  loosening.
- `capital_gate_safety`: every unsettled lot has `paper_notional_limit=0` and `live_notional_limit=0`.
- `post_cost_daily_net_pnl`: no PnL improvement is claimed until a settled paper route records post-cost evidence.

## Current Evidence

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags,
or GitOps manifests.

### Cluster And Rollout

- `agents-controllers` was `2/2` ready; the May 5 controller quorum degradation was not present in this sample.
- Jangar pod `jangar-7cd957c744-mhlg5` was `2/2 Running`.
- Torghut pod `torghut-00308-deployment-7d87dd9db-4bjt6` was `2/2 Running`.
- Torghut sim pod `torghut-sim-00406-deployment-5f7646d6cd-fx54s` was `2/2 Running`.
- Torghut Postgres, ClickHouse, Keeper, TA, TA sim, options TA, options catalog, options enricher, WebSocket, and
  options WebSocket pods were running.
- Recent Torghut events showed normal `torghut-00308` and `torghut-sim-00406` revision readiness after probe warmup.
- Recent events still showed ClickHouse multiple-PDB warnings and a no-pods keeper PDB warning. These are not immediate
  revenue blockers, but they are rollout hygiene debt.

### Source Architecture And Test Surface

- `services/torghut/app/main.py` is over 5,000 lines and already projects `/readyz`, `/trading/status`,
  `/trading/health`, and `/trading/consumer-evidence`. The acceptance ledger should be a pure reducer under
  `services/torghut/app/trading/`, not another block of API assembly logic.
- `services/torghut/app/trading/revenue_repair.py` already produces the revenue repair digest and is the closest
  upstream source for blocker priority.
- `services/torghut/app/trading/capital_reentry_cohorts.py` groups receipt cohorts and should remain the cohort source,
  not the routeability acceptance arbiter.
- `services/torghut/app/trading/quality_adjusted_profit_frontier.py` ranks repair quality; the acceptance ledger should
  consume its signal without duplicating frontier scoring.
- Existing tests cover revenue repair digest, capital reentry cohorts, quant readiness, trading readiness, and Jangar
  consumer evidence. The missing test is the acceptance invariant: no lot can count as routeable while any required
  receipt is stale, missing, or explicitly repair-only.

### Database And Data Quality

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head `0030_evidence_epochs`, one expected
  head, one current head, and no missing or unexpected heads.
- Schema graph lineage was ready. Warnings named existing migration parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready but warned that account scope checks are bypassed while multi-account mode is false.
- Jangar quant health returned `ok=true`, `status=degraded`, `latestMetricsCount=144`,
  `latestMetricsUpdatedAt=2026-05-08T12:25:51.593Z`, `runtimeEnabled=true`, `runtimeStarted=true`,
  `missingPipelineHealthStages=true`, and no scoped stages.
- Torghut `/readyz` folded that into `quant_pipeline_stages_missing`, informational but still part of stale evidence.
- Market context for ORCL was checked at `2026-05-08T12:27:40Z`; fundamentals were OK, but technicals, news, and regime
  were stale.
- Revenue repair digest reported `business_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and
  repair queue priority starting with route universe repair, alpha readiness repair, and live submit gate closure.

## Problem

Torghut has a good safety stance and a growing set of receipts, but it does not yet have a compact acceptance ledger
that says when a repair lot is routeable.

Without that ledger:

1. Fresh latest quant metrics can mask missing scoped pipeline stages.
2. A healthy pod can mask repair-only business state.
3. A market-context bundle can mask stale domains.
4. A route repair can improve activity without improving after-cost evidence.
5. A Jangar run can produce output that does not retire a Torghut value gate.
6. Deployer verification depends on reading several large payloads instead of one acceptance surface.

## Alternatives Considered

### Option A: Start A Paper Probe When The First Symbol Looks Repairable

Advantages:

- Fast route activity.
- Easy milestone for dashboards.
- Uses the current proof floor and revenue repair digest without adding another reducer.

Disadvantages:

- Does not settle scoped quant stages.
- Does not settle stale market-context domains.
- Risks counting activity as routeability before TCA, alpha, forecast, and Jangar admission are current.

Decision: reject. Paper probes should be an output of acceptance, not the acceptance test.

### Option B: Require Full `/readyz=ok` Before Any Repair Work Counts

Advantages:

- Very safe.
- Simple deployer rule.
- Prevents routeability inflation.

Disadvantages:

- Blocks measurement of useful zero-notional repair.
- Treats route/TCA, quant-stage, market-context, and alpha repairs as indistinguishable.
- Gives engineers no ordered path from repair-only to paper.

Decision: reject as primary. Keep it for paper/live action classes.

### Option C: Routeability Repair Acceptance Ledger

Advantages:

- Converts current blockers into typed lots with required receipts and value gates.
- Lets zero-notional repair work count only when it retires stale evidence.
- Gives Jangar one payload to consume for routeability admission.
- Keeps paper/live notional at zero until all lot receipts settle.

Disadvantages:

- Adds a new projection to maintain.
- Requires careful ownership so it does not duplicate revenue repair, capital reentry, or quality frontier scoring.
- Routeable candidate count will rise slower than activity count.

Decision: select Option C.

## Architecture

Torghut adds a pure acceptance reducer:

```text
routeability_repair_acceptance_ledger
  schema_version
  ledger_id
  generated_at
  fresh_until
  account
  window
  torghut_revision
  revenue_repair_digest_ref
  proof_floor_ref
  capital_reentry_ref
  quality_frontier_ref
  jangar_routeability_admission_ref
  lots[]
  aggregate_state
  accepted_routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  next_safe_repair_actions[]
  rollback_target
```

Each lot is explicit:

```text
routeability_repair_lot
  lot_id
  lot_type
  symbols
  hypothesis_ids
  value_gate
  current_state              # missing | stale | blocked | repairing | accepted | rejected
  required_receipts
  blocking_reason_codes
  acceptance_condition
  expected_gate_delta
  paper_notional_limit
  live_notional_limit
  rollback_trigger
```

Initial lots:

- `quant_scoped_stage_repair`: missing scoped quant pipeline stages for `PA3SX7FYNUTF/15m`.
- `market_context_domain_repair`: stale technicals, news, and regime domains.
- `alpha_readiness_repair`: no promotion-eligible hypotheses.
- `route_universe_tca_repair`: excluded or missing route/TCA symbols from revenue repair.
- `forecast_and_promotion_repair`: underfunded candidate and promotion evidence.
- `submit_gate_hold`: `simple_submit_disabled` remains a hard hold for paper/live action.
- `jangar_admission_witness`: Jangar routeability admission must be current before any paper candidate claim.

Rules:

- A lot can retire stale evidence with zero notional.
- A lot cannot increase `routeable_candidate_count` until all required receipts are `accepted`.
- Every unsettled lot has `paper_notional_limit=0` and `live_notional_limit=0`.
- `simple_submit_disabled` is never bypassed by a repair lot.
- Slippage threshold loosening cannot satisfy route/TCA acceptance.
- Direct database access is optional for operators; the ledger must be valid from typed runtime surfaces.

## Validation Gates

Local checks for engineer stage:

- Add tests for each initial lot type.
- Add a test where quant latest metrics are fresh but scoped stages are missing; acceptance must remain stale.
- Add a test where market-context bundle is recent but required domains are stale; acceptance must remain stale.
- Add a test where revenue repair is `repair_only`; paper/live notional limits remain zero.
- Add a test where Jangar admission is stale or missing; routeable candidate count does not increase.
- Run the focused Torghut readiness, revenue repair, capital reentry, and consumer evidence test slices.

Runtime checks for deployer stage:

- `/db-check` remains current at Alembic head `0030_evidence_epochs`.
- `/readyz` and `/trading/status` include the acceptance ledger.
- `/trading/revenue-repair` and `/trading/consumer-evidence` reference the same ledger id.
- Jangar admission consumes the ledger id and reports held paper/live action while repair-only.
- `accepted_routeable_candidate_count` is zero until all required receipts settle.
- `max_notional` remains zero while proof floor is `repair_only`.

## Rollout

1. Ship the ledger in observe mode.
2. Compare acceptance lots with revenue repair digest, capital reentry cohorts, quality frontier, and Jangar admission
   for one market session.
3. Expose the ledger id in `/readyz`, `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence`.
4. Let Jangar enforce routeability admission holds from the ledger.
5. Permit a paper probe proposal only after routeability acceptance moves at least one lot to `accepted` without
   weakening capital gates.

## Rollback

- Hide the ledger from admission and keep existing proof floor, revenue repair, capital reentry, and consumer evidence
  behavior unchanged.
- Keep `simple_submit_disabled` and zero live notional.
- Do not roll back by loosening route/TCA, market-context, quant, alpha, or forecast thresholds.
- If the ledger emits an accepted candidate while proof floor remains `repair_only`, disable enforcement and treat the
  emission as a release-blocking bug.

## Risks And Tradeoffs

- Duplicate scoring risk: mitigate by making the ledger an acceptance reducer, not a ranker.
- Payload size risk: publish compact lots and references rather than embedding all source payloads.
- False staleness risk: missing scoped stage instrumentation could block acceptance. That is acceptable until a receipt
  proves freshness.
- Slower routeable count: the count rises only when receipts settle. That is the point; routeability is a business
  claim, not an activity metric.

## Handoff

Engineer handoff: implement the pure acceptance reducer and tests first. Cite this document before changing code. The
smallest useful milestone is a ledger on `/readyz` and `/trading/status` that marks quant scoped stage repair,
market-context domain repair, alpha readiness, route/TCA repair, forecast repair, submit gate hold, and Jangar admission
witness as distinct lots with zero paper/live notional.

Deployer handoff: deploy observe-only. Acceptance is current `/db-check`, a fresh ledger id across status surfaces,
Jangar admission consuming that id, `accepted_routeable_candidate_count=0` until receipts settle, and unchanged
`capital_gate_safety` with `max_notional=0`.

## Implementation Note

The first engineer cut adds the observe-mode `torghut.routeability-repair-acceptance-ledger.v1` projection under
`services/torghut/app/trading/`. Torghut surfaces the same ledger on `/readyz`, `/trading/status`, `/trading/health`,
and `/trading/consumer-evidence`; `/trading/revenue-repair` references the ledger id. Jangar's Torghut consumer
evidence parser carries the ledger id, lot ids, accepted candidate count, and blocking reasons into negative evidence
so paper/live action stays held while the ledger is blocked, stale, or missing. This remains observe-only and keeps
paper/live notional at zero.
