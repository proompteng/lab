# 152. Torghut Proof-Floor Settlement Bonds And TCA Repair Auction (2026-05-07)

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

I am selecting **proof-floor settlement bonds with a TCA repair auction** as the next Torghut profitability
architecture step.

The evidence says Torghut is operationally alive but economically not promotable. At `2026-05-07T13:12Z`, `healthz`
was ok, Postgres and ClickHouse dependency checks were ok, `/db-check` was schema-current at Alembic head
`0029_whitepaper_embedding_dimension_4096`, empirical jobs were fresh, and trade decisions were still arriving. At
the same time, `/readyz` and `/trading/health` returned HTTP 503. The proof floor remained `repair_only`, capital was
zero-notional, the forecast registry was empty, market context was stale, all three hypotheses were shadow with zero
promotion-eligible candidates, and execution TCA was last computed on `2026-04-02` with average absolute slippage of
`568.6138848199565249` bps against an `8` bps guardrail.

The important detail is that TCA has two different problems. First, it is stale. Second, the last measured execution
quality is bad enough that a simple recompute may prove the strategy should remain blocked. Torghut needs to treat
those as different repair investments. A stale TCA bond buys a fresh measurement. A bad TCA bond buys strategy,
routing, or submission-policy repair. Only the second class can claim capital unlock after the measurement is current.

The selected design makes every proof-floor repair bid for settlement. Torghut prices the expected blocker reduction,
expected after-cost edge, confidence, data freshness, runtime cost, and closure receipt. Jangar consumes the resulting
bond through the source rollout truth exchange and decides whether a zero-notional repair warrant may run.

The tradeoff is that Torghut must publish more structured economics before it gets more autonomy. I accept that.
Profitability work without priced proof-floor settlement is activity; priced settlement is how we decide whether the
next repair is worth running.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `proof_floor_settlement_bonds` from `/trading/health`, `/readyz`, and `/trading/status`.
- Each `proof_floor_settlement_bond` names `bond_id`, `repair_dimension`, `repair_class`, `account_label`,
  `hypothesis_ids`, `proof_floor_before`, `expected_blocker_delta`, `expected_after_cost_bps`, `confidence`,
  `fresh_until`, `zero_notional_required`, `closure_receipts`, and `capital_effect`.
- TCA bonds distinguish `tca_recompute` from `tca_policy_repair`.
- Market-context, forecast-registry, alpha-readiness, and live-submit bonds have separate closure receipts.
- A bond can close only when the corresponding proof-floor blocker is removed or explicitly converted into a better
  typed blocker.
- Capital remains zero-notional until Jangar accepts the closed bond and source-rollout settlement is converged for
  the relevant action class.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- Argo CD reported `torghut` as `Synced` and `Healthy` at revision
  `4c4417997ba6adb89678d7a784499adfa22b7470`.
- Torghut pods were running, including ClickHouse, Keeper, Postgres, TA jobs, options catalog/enricher, live service,
  simulation service, and whitepaper autoresearch workers.
- `torghut-00259` was running with the live service pod `2/2 Running`.
- Direct Knative service listing and CNPG cluster listing were RBAC-blocked for this service account, so this design
  relies on typed runtime endpoints and database projections for ordinary validation.
- `/healthz` returned HTTP 200 with `status=ok`.
- `/readyz` returned HTTP 503 with `status=degraded`.
- `/trading/health` returned HTTP 503 with the same proof-floor blockers.

### Trading And Profit Evidence

- Scheduler state was ok and running.
- Postgres, ClickHouse, and Alpaca dependencies were ok.
- Live submission gate was closed: `allowed=false`, `simple_submit_disabled`, `capital_stage=shadow`.
- Profitability proof floor was not ok: `floor_state=repair_only`, `capital_state=zero_notional`, and required proof
  was false.
- Repair ladder codes included `live_submit_gate_closed`, `repair_alpha_readiness`, `repair_execution_tca`,
  `repair_market_context`, `repair_drift_governance`, and `closed_session_signal_hold`.
- Empirical jobs were healthy and truthful for candidate `chip-paper-microbar-composite@execution-proof` on dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Forecast service was degraded because the registry was empty.
- Quant health returned HTTP 200 from the Jangar direct route, with latest metrics updating at assessment time, but
  stage rows were empty and health was skipped when account and window were omitted.
- Alpha readiness reported `3` hypotheses, all shadow, `0` promotion eligible, and `3` rollback required.

### Database And Data Evidence

- `/db-check` reported schema current, lineage ready, branch count `1`, no duplicate revisions, and current head
  `0029_whitepaper_embedding_dimension_4096`.
- `/db-check` retained parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Direct Postgres reads showed estimated rows near `147,606` trade decisions, `13,778` executions, and `13,775`
  execution TCA metric rows.
- `trade_decisions` had fresh rows on `2026-05-06`, proving the decision pipeline was not completely idle.
- `executions` and `execution_tca_metrics` last updated on `2026-04-02`, proving execution-quality evidence is stale.
- TCA `avg_abs_slippage_bps=568.6138848199565249` against an `8` bps guardrail means a recompute can retire staleness
  but cannot be assumed to retire the quality blocker.
- `strategy_hypotheses` contained strategy-level records, but runtime alpha readiness still had no promotion-eligible
  hypothesis.

### Source Evidence

- `services/torghut/app/main.py` is the route assembly file and should not own bond economics.
- `services/torghut/app/trading/proof_floor.py` already emits blocker dimensions and repair ladder entries.
- `services/torghut/app/trading/tca.py` owns execution-quality aggregation and should provide TCA evidence to bond
  pricing.
- `services/torghut/app/trading/market_context.py` owns market-context freshness and should provide closure receipts
  for market-context bonds.
- `services/torghut/app/trading/submission_council.py` owns submission gates and must remain the final deterministic
  policy consumer.
- Focused tests already exist for proof floor, submission council, market context, forecast service, TCA adaptive
  policy, empirical jobs, and strategy hypothesis governance.

## Problem

Torghut currently names proof-floor blockers, but it does not make repair economics explicit enough to prioritize
work or prove capital relevance.

The failure modes are:

1. TCA staleness and TCA quality failure can collapse into one blocker, causing a repair job to claim progress after
   it merely recomputes bad evidence.
2. Healthy infrastructure and fresh empirical jobs can mask stale market context, stale execution evidence, and empty
   forecast registry state.
3. Alpha readiness can remain shadow-only after data repairs, so capital unlock cannot be assumed from data freshness.
4. The live submit gate can stay disabled for policy reasons even when proof-floor evidence improves.
5. Jangar cannot admit the most valuable repair unless Torghut states expected value, cost, expiry, and closure proof.

## Alternatives Considered

### Option A: Keep The Existing Proof-Floor Repair Ladder

Pros:

- Already implemented and visible in health endpoints.
- Safe because capital stays closed.
- Easy for operators to read.

Cons:

- Does not price repair value.
- Does not separate stale TCA measurement from bad TCA policy or strategy quality.
- Does not give Jangar a closure receipt tied to capital gates.

Decision: reject as insufficient.

### Option B: Recompute All Stale Evidence On Schedule

Pros:

- Simple to automate.
- Will eventually refresh TCA, market context, and quant windows.
- Keeps economic ranking out of the first implementation.

Cons:

- Burns runtime on repairs that may not unlock capital.
- Can refresh bad evidence and still leave the system zero-notional.
- Adds schedule load without proving after-cost edge.

Decision: reject.

### Option C: Publish Proof-Floor Settlement Bonds

Pros:

- Prices each blocker by expected blocker reduction and expected after-cost edge.
- Makes TCA recompute and TCA policy repair separate bids.
- Gives Jangar a bounded zero-notional object to admit through warrants.
- Keeps capital closed until closure receipts and source-rollout settlement agree.
- Turns repair work into a measurable profitability portfolio.

Cons:

- Requires careful scoring and calibration.
- Adds more status schema and fixtures.
- Can still mis-rank repairs if source evidence is stale or biased.

Decision: select Option C.

## Architecture

Torghut adds a reducer outside route assembly:

```text
proof_floor_settlement_bonds
  generated_at
  account_label
  torghut_revision
  proof_floor_ref
  market_window
  bonds[]
  suppressed_bonds[]
```

Each bond has:

```text
proof_floor_settlement_bond
  bond_id
  repair_dimension
  repair_class
  account_label
  hypothesis_ids[]
  proof_floor_before
  expected_blocker_delta
  expected_after_cost_bps
  confidence
  source_receipts[]
  fresh_until
  zero_notional_required
  closure_receipts[]
  capital_effect
  jangar_warrant_ref
  rollback_target
```

Repair classes are:

- `tca_recompute`: refresh stale TCA measurement. Closure requires a new TCA computation inside the configured
  freshness window. It does not claim strategy quality improvement by itself.
- `tca_policy_repair`: run strategy, routing, or submission-policy repair after fresh TCA still breaches the
  guardrail. Closure requires fresh TCA inside the guardrail or a typed strategy rejection that removes the hypothesis
  from promotion consideration.
- `market_context_refresh`: renew market-context data and prove freshness for the target market window.
- `forecast_registry_activation`: populate or bind a forecast registry candidate and prove the service is configured
  and non-empty.
- `alpha_readiness_clearance`: move a hypothesis from shadow to promotion eligible only after empirical, TCA, market,
  and rollback requirements agree.
- `live_submit_policy_clearance`: clear deterministic submit policy only after proof-floor and Jangar settlement
  permit paper or live progression.

Bond ranking uses:

- Expected blocker reduction: how many proof-floor blockers the bond can close or convert.
- Expected after-cost basis points: estimated incremental edge after data, execution, and runtime cost.
- Confidence: evidence freshness, sample size, empirical truthfulness, and hypothesis consistency.
- Risk tier: whether the repair is observe-only, zero-notional, paper, or live-adjacent.
- Expiry: how long the quote is valid before market or execution evidence must be refreshed.

## Implementation Scope

Engineer stage should implement:

1. A `proof_floor_settlement_bonds` reducer that consumes proof-floor blockers, TCA metrics, market context,
   forecast registry state, alpha readiness, empirical job summaries, and submission gate state.
2. Stable bond IDs derived from account, repair dimension, repair class, proof-floor epoch, and source receipts.
3. Route projection in `/trading/health`, `/readyz`, and `/trading/status`.
4. Jangar-facing bond references that map to repair warrants and source-rollout truth settlement.
5. Tests for stale TCA, bad fresh TCA, stale market context, empty forecast registry, shadow-only alpha readiness, and
   submit gate closure.

Out of scope for this design artifact:

- Enabling live submit.
- Raising capital notional above zero.
- Writing new trade or execution records.
- Replacing deterministic submission council policy.

## Validation Gates

Engineer validation:

- Unit tests prove `tca_recompute` closes only TCA staleness.
- Unit tests prove fresh TCA above the guardrail creates or preserves a `tca_policy_repair` bond.
- Unit tests prove market-context freshness has its own closure receipt.
- Unit tests prove forecast registry empty state creates a separate bond.
- Unit tests prove no bond can claim capital unlock while alpha readiness has zero promotion-eligible hypotheses.
- Existing tests for proof floor, market context, forecast service, TCA adaptive policy, submission council, and
  empirical jobs stay green.

Deployer validation:

- `/healthz` may be ok while `/readyz` remains degraded; this is acceptable until bonds close.
- `/db-check` must stay schema-current before trusting any bond projection.
- `/trading/health` must expose current bonds and the underlying proof-floor blockers.
- Jangar must expose a fresh source-rollout truth receipt before a bond can drive a repair warrant.
- Capital remains `zero_notional` until the relevant bond is closed and Jangar action-class settlement permits the
  next step.

## Rollout Plan

1. Add the reducer and tests without changing submission policy.
2. Publish bonds as status-only diagnostics.
3. Map bonds to Jangar repair warrants for zero-notional repair admission.
4. Let Jangar consume closed bonds for paper canary consideration only after one schedule cycle of stable receipts.
5. Keep live submit disabled until paper settlement, expected shortfall coverage, rollback posture, and deployer gates
   are all satisfied.

## Rollback Plan

Rollback is capital-safe:

- If bond projection fails, omit bonds and keep the proof floor `repair_only`.
- If a bond expires, suppress it and require fresh proof before repair admission.
- If TCA recompute proves slippage remains above guardrail, keep capital closed and emit `tca_policy_repair`.
- If market context or forecast registry regress, invalidate dependent alpha-readiness bonds.
- If Jangar source-rollout settlement is stale or divergent, bonds may remain visible but cannot admit repair work.

## Risks And Mitigations

- Risk: expected after-cost bps is noisy. Mitigation: include confidence and suppress low-confidence capital claims.
- Risk: recompute work is mistaken for quality repair. Mitigation: separate `tca_recompute` from
  `tca_policy_repair`.
- Risk: status payload grows too large. Mitigation: publish current active bonds and compact suppressed-bond reasons.
- Risk: alpha readiness remains blocked after data repairs. Mitigation: bonds can close data blockers without claiming
  promotion eligibility.
- Risk: live submit policy is opened too early. Mitigation: submission council remains final authority and Jangar
  settlement is required before capital progression.

## Engineer Handoff

Build bond pricing as a deterministic reducer. Start with the exact live evidence from this run: schema current,
empirical jobs fresh, forecast registry empty, market context stale, alpha readiness shadow-only, TCA last computed on
`2026-04-02`, and slippage far beyond the guardrail. The reducer should emit separate bonds for TCA recompute, TCA
policy repair, market-context refresh, forecast registry activation, and alpha-readiness clearance. No bond should
claim paper or live capital unlock until closure receipts prove the blocker is gone and Jangar settlement agrees.

## Deployer Handoff

Do not promote Torghut capital posture from infrastructure health alone. Require `/db-check` schema-current,
`/trading/health` bond projection current, proof-floor blockers reduced or converted by closure receipts, and a fresh
Jangar source-rollout truth settlement receipt. Treat stale TCA and bad TCA as different deployment risks. A TCA
recompute can make the data current; only fresh TCA inside guardrail, or a typed rejection of the losing hypothesis,
can support capital progression.
