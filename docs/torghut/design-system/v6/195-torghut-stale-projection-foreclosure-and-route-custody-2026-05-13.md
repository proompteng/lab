# 195. Torghut Stale Projection Foreclosure And Route Custody (2026-05-13)

Status: Accepted for Jangar engineer and deployer handoff

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

I am selecting a **stale projection foreclosure ledger** for Torghut route custody.

Torghut is not failing as a service. On 2026-05-13, `/readyz` returned `status=degraded`, but the dependency picture was
specific: scheduler OK, Postgres OK, ClickHouse OK, Alpaca broker OK, schema current at
`0031_autoresearch_candidate_spec_epoch_uniqueness`, universe loaded with `8` static symbols, and empirical jobs
healthy. The degradation was capital and proof-floor related: live submission blocked by `simple_submit_disabled`,
capital stage `shadow`, profitability proof floor `repair_only`, promotion eligible hypotheses `0`, and
`ta-core` blocked by `signal_lag_exceeded`.

The state-store evidence showed why Jangar cannot treat projected health as route authority. Torghut TCA was active
with `13775` metrics and newest computed timestamp `2026-05-13T15:29:49Z`, options watermarks were current, and
empirical job runs were present. At the same time, Torghut `evidence_epochs` and `evidence_receipts` were empty, filled
execution state was stale at `2026-04-02`, and route custody required receipt classes that were not yet present. From
Jangar's side, market-context rows carried stale `running` and `started` projections even while newer snapshots existed.

The selected design preserves zero-notional repair. It does not promote paper or live capital. It adds a ledger that
classifies Torghut projections as current, stale-foreclosed, missing-receipt, contradictory, or terminal-audit before
Jangar may use them for stage custody, repair dispatch priority, or any future capital-adjacent gate.

The tradeoff is that Torghut will expose less optimistic route health. That is the right tradeoff. A route that has
fresh TCA but missing receipts is useful for repair, not for promotion.

## Governing Runtime Requirements

This companion contract follows the Jangar swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates for this contract:

- `zero_notional_or_stale_evidence_rate`
- `routeable_candidate_count`
- `fill_tca_or_slippage_quality`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

Jangar cross-plane value gates affected by this contract:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

Evidence was collected read-only on 2026-05-13.

- Torghut deployments were ready after the current rollout. Older Knative revisions remained scaled down.
- Torghut `/db-check` returned schema current with expected and current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and lineage ready with
  only known parent-fork warnings.
- Torghut `/readyz` returned HTTP `503` and `status=degraded`.
- Scheduler, Postgres, ClickHouse, Alpaca, universe, database, and empirical jobs were OK.
- Live submission was blocked by `simple_submit_disabled`; capital stage was `shadow`; capital state was
  `zero_notional`; profitability proof floor was `repair_only`.
- `alpha_readiness` showed `3` shadow hypotheses, `0` promotion eligible, and `2` rollback required.
- Segment summary showed empirical, execution, llm-review, and market-context OK, while `ta-core` was blocked by
  `signal_lag_exceeded`.
- Torghut Postgres `trade_decisions` summarized to `69909` rejected decisions, newest `2026-05-04`, and `63665`
  blocked decisions, newest `2026-05-13T15:26Z`.
- Torghut `executions` had `13555` filled rows, but newest update was `2026-04-02`. The current route must therefore
  distinguish fresh analysis from stale fill evidence.
- Torghut `execution_tca_metrics` had `13775` rows, newest computed `2026-05-13T15:29:49Z`, and observed slippage
  range from about `-302.83` bps to `609.20` bps.
- Torghut `evidence_epochs` and `evidence_receipts` were empty.
- Torghut `autoresearch_candidate_specs` had `342` eligible candidates and latest autoresearch epoch status
  `no_profit_target_candidate`.
- Torghut `vnext_empirical_job_runs` had `32` completed rows marked promotion-authority eligible, newest
  `2026-05-13T04:24:33Z`.
- Torghut options watermarks were current for `7198` contract-symbol rows, newest success `2026-05-13T16:14:03Z`, and
  maximum retry count `0`.
- Jangar route custody saw repair-only evidence and required receipt classes including
  `torghut.execution-tca-refresh-receipt.v1` and `torghut.market-context-freshness-receipt.v1`.

## Problem

Torghut has enough evidence to do useful zero-notional repair work, but not enough settled receipt evidence to promote
routes or let Jangar stage custody consider route projections current.

The concrete failure modes are:

1. A route can show a healthy segment summary while its required receipt ledger is empty.
2. Fresh TCA metrics can coexist with stale fill execution evidence.
3. Market-context snapshots can be recent in aggregate while individual domain run projections remain stale.
4. Repair lots can be dispatched repeatedly when the missing receipt is the real blocker.
5. Jangar can block on broad `market_context_stale` or `route_stability_hold` reason codes without knowing which
   Torghut projection lost authority.
6. Trading hypotheses remain shadow-only because route custody cannot prove which blockers were retired.

## Alternatives Considered

### Option A: Treat Segment Health As Route Authority

This path allows a route segment marked OK in `/readyz` or consumer evidence to satisfy Jangar route custody.

Advantages:

- Simple to consume.
- Keeps the route surface optimistic.
- Avoids new receipt work.

Disadvantages:

- Hides missing receipt ledgers.
- Lets fresh snapshots mask stale domain projections.
- Does not explain why promotion eligibility is still zero.
- Could pressure Jangar to release capital-adjacent work without proof.

Decision: reject. Segment health is not enough for route authority.

### Option B: Freeze All Route Repair Until Receipts Exist

This path blocks Torghut repair dispatch until every receipt table and route proof is populated.

Advantages:

- Maximally conservative for capital safety.
- Easy to explain.
- Prevents repeated no-delta repair runs.

Disadvantages:

- Creates deadlock because repair lanes are how receipts get produced.
- Wastes the fresh TCA, options, and empirical signals already available.
- Increases manual intervention.

Decision: reject. Zero-notional repair must stay available.

### Option C: Stale Projection Foreclosure Ledger

The selected path emits a route-custody ledger that separates current route authority from stale or missing projection
authority. Repair stays allowed when explicitly zero-notional, but promotion remains blocked until current receipts
exist.

Advantages:

- Makes Jangar stage custody deterministic.
- Preserves observe-mode repair throughput.
- Converts stale or missing projections into named repair actions.
- Gives trading hypotheses a clear path from repair-only to paper candidate.

Disadvantages:

- Adds schema, endpoint, and test work.
- Can make current readiness look worse by exposing missing receipts directly.
- Requires careful account/window binding for every receipt.

Decision: select Option C.

## Architecture

Torghut emits `stale_projection_foreclosure_ledger` through `/trading/consumer-evidence` first, then optionally
`/readyz` and `/trading/health` once the payload is stable.

```text
stale_projection_foreclosure_ledger
  schema_version = torghut.stale-projection-foreclosure-ledger.v1
  generated_at
  fresh_until
  account
  window
  capital_stage = shadow
  max_notional = 0
  route_custody_decision = current | repair_only | hold
  projection_claims[]
  foreclosure_receipts[]
  missing_receipts[]
  required_repair_actions[]
  hypothesis_impacts[]
```

Each projection claim records:

```text
torghut_projection_claim
  claim_id
  claim_class
  source_ref
  account
  window
  hypothesis_id
  strategy_id
  observed_at
  fresh_until
  authority_state
  reason_codes[]
  value_gates[]
  required_receipt_schema
  repair_lot_id
```

Initial `claim_class` values:

- `market_context_fundamentals`: fundamentals freshness, snapshot quality, and completed-run receipt;
- `market_context_news`: news freshness, ingestion watermark, and completed-run receipt;
- `execution_tca`: TCA metric recency and route-level slippage guardrail;
- `execution_fill_sample`: filled execution sample recency and order lifecycle evidence;
- `empirical_job`: empirical job completion and promotion-authority eligibility;
- `research_candidate`: autoresearch candidate and promotion table proof;
- `route_custody_receipt`: the receipt that binds the above claims into a Jangar-consumable route verdict.

Initial `authority_state` values:

- `authoritative`: required source and receipt are current for account, window, and hypothesis;
- `repair_only`: source is useful for zero-notional repair but cannot support promotion;
- `stale_foreclosed`: source exists but exceeded its freshness or renewal budget;
- `missing_receipt`: source may be present, but required receipt schema is absent;
- `contradictory`: current sources disagree;
- `terminal_audit`: old terminal evidence is retained for review but cannot renew route authority;
- `unknown`: Torghut could not inspect the source.

## Route Custody Rules

The ledger must enforce these route rules:

- `max_notional` remains `0` for all `repair_only`, `stale_foreclosed`, `missing_receipt`, `contradictory`, and
  `unknown` states.
- A fresh segment summary cannot renew a missing receipt.
- A fresh TCA metric cannot renew stale fill execution evidence.
- Fresh news cannot renew stale fundamentals, and fresh fundamentals cannot renew stale news.
- Empirical job eligibility can support repair priority, but it cannot promote a hypothesis without route-custody
  receipts.
- A repair lot may be dispatchable only when it names the expected receipt schema and the reason code it is expected to
  retire.
- A repeated repair lot without a new receipt becomes no-delta debt for Jangar terminal compaction.

## Measurable Trading Hypotheses

This contract does not invent a new trading strategy. It turns current Torghut blockers into measurable promotion
hypotheses:

1. **TCA receipt repair hypothesis**: if `torghut.execution-tca-refresh-receipt.v1` is produced for the active account
   and 15 minute window, route custody can retire `tca_evidence_stale` and reduce repair-only rejections without
   increasing slippage guardrail breaches.
2. **Market-context receipt repair hypothesis**: if fundamentals and news receipts are produced independently, the
   route can retire `market_context_stale` without letting one domain mask the other.
3. **Fill-sample evidence hypothesis**: if fresh fill or paper-fill sample receipts are bound to execution TCA,
   `active_session_execution_samples_stale` can be replaced by a measured execution-quality verdict.
4. **Research promotion evidence hypothesis**: if autoresearch candidates produce current promotion receipts,
   `research_candidates_empty`, `research_promotions_empty`, and `vnext_promotion_decisions_empty` can become
   hypothesis-scoped repair outcomes instead of global route blockers.

Each hypothesis must be evaluated with zero notional until capital contracts outside this document authorize a wider
stage.

## Jangar Integration

Jangar consumes the ledger through the projection foreclosure notary.

- `missing_receipt` becomes a Jangar `torghut_route_custody` claim with material action `hold` for paper/live and
  `repair_only` for zero-notional repair.
- `stale_foreclosed` becomes a named repair action and cannot be counted as a current healthy projection.
- `authoritative` can satisfy route custody only when account, window, hypothesis, and receipt schema match the current
  Jangar stage.
- `terminal_audit` can inform incident review but cannot block a clean current rollout by itself.
- `unknown` holds material action because Jangar cannot prove safety.

The first integration should be read-only and additive. It should not change broker submission flags, order routing, or
capital limits.

## Implementation Milestones

### Milestone 1: Ledger Payload And Fixtures

Value gates: `capital_gate_safety`, `handoff_evidence_quality`, `ready_status_truth`.

- Add typed ledger schema to Torghut consumer-evidence payloads.
- Build fixtures for fresh TCA with missing receipt, stale fill sample, fresh options watermark, stale market-context
  domain, and current empirical job.
- Prove `max_notional=0` is emitted for every non-authoritative state.

### Milestone 2: Receipt Binding

Value gates: `zero_notional_or_stale_evidence_rate`, `routeable_candidate_count`, `manual_intervention_count`.

- Bind TCA, market-context, fill-sample, empirical, and research candidate claims to receipt schemas.
- Emit explicit missing receipt records for empty `evidence_epochs` and `evidence_receipts`.
- Add tests that fresh source data without receipts remains repair-only.

### Milestone 3: Repair Lot Prioritization

Value gates: `failed_agentrun_rate`, `routeable_candidate_count`, `fill_tca_or_slippage_quality`.

- Prioritize repair lots by expected receipt and reason-code delta.
- Mark repeated lots without new receipts as no-delta debt.
- Preserve dispatch only for zero-notional repair work.

### Milestone 4: Jangar Consumption

Value gates: `ready_status_truth`, `pr_to_rollout_latency`, `handoff_evidence_quality`.

- Feed the ledger into Jangar projection foreclosure notary.
- Expose route custody claim totals by authority state.
- Ensure stage credit and ready truth separate Torghut missing receipts from live service failure.

### Milestone 5: Deployer Verification

Value gates: `manual_intervention_count`, `capital_gate_safety`, `post_cost_daily_net_pnl`.

- Verify Torghut `/db-check`, `/readyz`, and `/trading/consumer-evidence` after rollout.
- Verify Jangar status consumes the ledger and keeps capital-adjacent work held.
- Record which receipt blocker prevents paper promotion, or which receipt was produced and which reason code retired.

## Validation Gates

The engineer stage is not complete until:

- unit tests cover every `authority_state`;
- endpoint tests prove `max_notional=0` for repair-only, missing receipt, stale, contradictory, and unknown states;
- tests prove fresh TCA without a receipt cannot satisfy route authority;
- tests prove fresh news cannot renew stale fundamentals and fresh fundamentals cannot renew stale news;
- tests prove a repeated repair lot without a new receipt is surfaced as no-delta debt;
- formatting and relevant Torghut checks pass.

The verify stage is not complete until:

- Torghut schema is current at the expected Alembic head;
- Torghut readiness degradation is explained by named capital/proof guards rather than unknown route authority;
- Jangar status receives the ledger and reports route-custody claim totals;
- repair dispatch remains zero-notional;
- no paper/live capital gate opens because of this change;
- the handoff names the specific receipt blocker or retired reason code.

## Rollout Plan

1. Emit the ledger in consumer evidence as observe-only metadata.
2. Add Jangar read-side consumption while keeping existing route-custody decisions unchanged.
3. Enable Jangar stage custody to use missing-receipt and stale-foreclosed states for explanation.
4. Let repair lot prioritization use the ledger after one clean schedule cycle.
5. Defer any paper/live promotion change to a separate capital proof PR.

## Rollback Plan

Rollback is safe because this design is additive and zero-notional:

- remove the ledger from Jangar consumption first;
- keep Torghut emitting it for audit if endpoint compatibility is stable;
- fall back to the previous consumer-evidence route-custody payload;
- keep `simple_submit_disabled`, `capital_stage=shadow`, and `max_notional=0`;
- preserve any emitted receipts for incident review.

If the ledger destabilizes Torghut readiness, roll back the serving image and use the previous repair outcome dividend
ledger until the endpoint tests are fixed.

## Risks And Mitigations

- Risk: route custody becomes harder to satisfy. Mitigation: that is acceptable for paper/live; zero-notional repair
  stays available.
- Risk: receipt schemas drift between Jangar and Torghut. Mitigation: schema names are explicit and must be tested in
  both services before stage custody consumes them.
- Risk: old fill evidence blocks all progress. Mitigation: classify stale fill evidence as repair-only and give it a
  specific receipt target instead of a global route hold.
- Risk: market-context domains mask each other. Mitigation: fundamentals and news have independent claims and cannot
  renew each other.
- Risk: operators confuse degraded readiness with broken infrastructure. Mitigation: `/readyz` and Jangar status must
  distinguish healthy dependencies from capital/proof-floor holds.

## Handoff To Engineer

Implement the ledger as an additive endpoint payload first. Do not change order submission, broker flags, notional
limits, or capital stage. The first PR should make stale route projections visible, bind missing receipts to repair
lots, and prove zero-notional safety with tests.

Acceptance gates:

- `evidence_epochs` or `evidence_receipts` empty produces `missing_receipt`;
- fresh TCA without the required receipt remains `repair_only`;
- stale fill evidence is separate from TCA freshness;
- fundamentals and news claims are independent;
- every non-authoritative claim emits `max_notional=0`;
- repeated no-receipt repair lots become no-delta debt.

## Handoff To Deployer

After deployment, treat Torghut `status=degraded` as actionable only after checking the ledger. If infrastructure
dependencies are healthy and the ledger says missing receipt or stale-foreclosed, the system is in controlled repair,
not serving failure. Keep capital closed until the ledger reports authoritative route custody for the current account,
window, hypothesis, and receipt schema.

Rollout acceptance gates:

- `/db-check` schema current;
- `/readyz` dependency health recorded;
- `/trading/consumer-evidence` includes the stale projection foreclosure ledger;
- Jangar projection notary consumes the ledger;
- `max_notional=0` preserved;
- handoff names either the receipt blocker or the retired reason code.
