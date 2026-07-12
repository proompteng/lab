# 184. Torghut Execution-Trusted Profit-Repair Settlement (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting **execution-trusted profit-repair settlement** as Torghut's next profitability architecture step.

The current runtime has improved materially since the May 5 shared soak. At `2026-05-08T12:15Z`, Argo CD reported
Torghut, Torghut options, Jangar, and the Symphony apps `Synced` and `Healthy` at
`e87e3d87d3b8313f408704e2fa9317bb5a679c8e`. Live Torghut is serving revision `torghut-00307`; sim is serving
`torghut-sim-00405`; Postgres, ClickHouse, Keeper, TA, WebSocket, options catalog, and options enricher pods are
running. `/db-check` is current at Alembic head `0030_evidence_epochs`.

The profit and action gates are still closed for good reasons. Live `/readyz` returns `status=degraded`.
`proof_floor.floor_state=repair_only`, `route_state=repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
Live submission is blocked by `simple_submit_disabled` and `hypothesis_not_promotion_eligible`. The current
consumer-evidence receipt is live and current, but it still reports `paper=blocked`, `live=blocked`, `max_notional=0`,
and reason codes `forecast_registry_degraded`, `simple_submit_disabled`, and
`hypothesis_not_promotion_eligible`.

The market evidence names the next scarce repair. Live execution TCA has 7,334 orders and 7,245 filled executions, with
average absolute slippage around `13.82` bps against an 8 bps guardrail. AAPL is probing, not capital-ready. AMD, AVGO,
INTC, and NVDA are blocked by route/TCA exclusions; AMZN, GOOGL, and ORCL are missing route TCA. Sim is worse:
`/readyz=ok` for service health, but proof remains `repair_only`, routeable count is zero, NVDA is blocked at about
`110.16` bps, and seven symbols are missing.

The selected design turns those blockers into a settlement ledger. Torghut should not propose paper or live capital
because one endpoint returns 200 or one symbol is probing. It should publish a typed `profit_repair_settlement_ledger`
that ranks repair debt by value-gate impact, cites Jangar execution-trust admission, and keeps every lot at zero
notional until forecast, alpha, quant freshness, route/TCA, and Jangar trust evidence settle.

The tradeoff is that paper activation stays slower than a direct AAPL probe. I accept that. A system with degraded
execution trust, stale scoped quant stages, and route slippage above guardrail should buy evidence quality before it
buys activity.

## Business Metric And Value Gates

The governing business metric is to increase routeable post-cost profit evidence and live trading readiness without
weakening capital safety.

This design maps each milestone to a value gate:

- `post_cost_daily_net_pnl`: no claim until paper settlement records post-cost evidence for a settled route.
- `routeable_candidate_count`: increase only when route/TCA, forecast, alpha, quant, and Jangar admission receipts are
  present.
- `zero_notional_or_stale_evidence_rate`: reduce by retiring quant, schema, forecast, route, and stage-staleness debt
  lots.
- `fill_tca_or_slippage_quality`: improve by repairing high-activity TCA and missing-symbol TCA before paper probes.
- `capital_gate_safety`: keep `max_notional=0` for every unsettled repair lot.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker
state, or GitOps manifests.

### Cluster And Rollout

- Argo CD reported `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` `Synced` /
  `Healthy`, operation `Succeeded`, revision `e87e3d87d3b8313f408704e2fa9317bb5a679c8e`.
- Live Torghut pod `torghut-00307-deployment-5c8b6dcbd8-2gpj8` and sim pod
  `torghut-sim-00405-deployment-7644857cd6-b29xz` were `2/2 Running`.
- Torghut options catalog, options enricher, TA, TA sim, options TA, WebSocket, ClickHouse, Keeper, and Postgres pods
  were running.
- Recent Torghut events showed normal Knative revision rollout, completed migration/backfill/bootstrap jobs, ClickHouse
  multiple-PDB warnings, and a transient Postgres readiness 500.
- Recent Jangar events showed app restarts and readiness failures during the current rollout before the ready pod
  settled. Jangar `/ready` still marked execution trust degraded from swarm stage staleness.

### Source Architecture And Test Surface

- `services/torghut/app/main.py` is 5,068 lines and assembles `/readyz`, `/trading/status`, `/trading/health`, and
  `/trading/consumer-evidence`; it should not absorb more repair scoring.
- `services/torghut/app/trading/proof_floor.py` is 754 lines and owns the profit-floor receipt.
- `services/torghut/app/trading/consumer_evidence.py` is 406 lines and owns stable consumer-evidence and
  route-proven receipts.
- `services/torghut/app/trading/capital_reentry_cohorts.py` is 616 lines and groups current receipt-settlement cohorts.
- `services/torghut/app/trading/quality_adjusted_profit_frontier.py` is 628 lines and ranks repair packets from
  quality signals.
- `services/torghut/app/trading/submission_council.py` is 1,318 lines and remains the high-risk capital gate.
- Existing tests cover proof floor, route reacquisition, consumer evidence, capital reentry cohorts, quality-adjusted
  frontier, readiness verification, and Jangar consumer parsing.
- The missing contract is a settlement reducer that joins Jangar execution-trust admission with Torghut's profit debt
  and proves that stale evidence can be repaired while paper/live notional remains zero.

### Database And Data Quality

- Direct CNPG `psql` through `kubectl cnpg` is forbidden for this service account in `torghut` and `jangar` because
  `pods/exec` is denied.
- ClickHouse direct HTTP returned 401 without credentials.
- `/db-check` returned HTTP 200 with current and expected Alembic head `0030_evidence_epochs`.
- Jangar quant health for `account=PA3SX7FYNUTF&window=15m` returned `status=degraded`; live Torghut's proof floor
  showed 144 latest metrics but `quant_pipeline_degraded`, ingestion stage lag around 596,178 seconds, and
  materialization lag around 103 seconds.
- Market context was mostly fresh in the live sample, but news remained stale for some hypothesis paths.
- Profit lease projections still marked windows `quarantined`, with reasons including `quant_pipeline_degraded`,
  `schema_lineage_missing`, `route_universe_empty`, `research_candidates_empty`, `research_promotions_empty`,
  `vnext_promotion_decisions_empty`, and `rejection_drag_unmeasured`.

## Problem

Torghut now has many useful proof receipts, but it does not yet settle them into a capital-safe repair sequence.

The failure modes are:

1. A current consumer-evidence route can be mistaken for paper readiness even while the receipt blocks paper and live.
2. AAPL probing can look like a routeable candidate even though dependency receipts and Jangar trust are not settled.
3. Sim readiness can be HTTP 200 while route evidence is empty or above slippage guardrail.
4. Quant latest metrics can be fresh while scoped stages are stale enough to keep the pipeline degraded.
5. Forecast and promotion tables remain underfunded for the active candidate.
6. Jangar execution-trust degradation should influence repair admission, but Torghut does not yet cite that admission
   in the profit repair path.
7. Direct database inspection is not guaranteed for deployers, so typed receipts must be sufficient for validation.

## Alternatives Considered

### Option A: Promote AAPL To A Paper Probe First

Advantages:

- Fastest visible movement in route activity.
- Uses the only current probing symbol.
- Simple to explain.

Disadvantages:

- Ignores Jangar execution-trust degradation.
- Ignores forecast and alpha blockers.
- Lets route/TCA partial success bypass quant and settlement debt.

Decision: reject. AAPL should be a repair lot, not a bypass.

### Option B: Freeze All Torghut Work Until Every Proof Dimension Is Green

Advantages:

- Strong safety posture.
- Easy to operate.
- Prevents accidental capital movement.

Disadvantages:

- Blocks the zero-notional work required to repair proof dimensions.
- Treats route TCA repair, forecast repair, quant freshness repair, and paper/live action as the same risk.
- Leaves the business metric unchanged.

Decision: reject for repair work, keep for live capital.

### Option C: Execution-Trusted Profit-Repair Settlement

Advantages:

- Converts every blocker into a named debt lot with acceptance conditions.
- Lets Torghut keep repairing evidence under zero notional.
- Requires Jangar execution-trust admission before paper unlock proposals.
- Gives deployers a compact receipt that maps work to value gates and rollback.

Disadvantages:

- Adds another reducer and status payload.
- Requires discipline to avoid duplicating quality-frontier and capital-reentry logic.
- Paper remains blocked until settlement clears multiple receipts.

Decision: select Option C.

## Architecture

Torghut adds a derived `profit_repair_settlement_ledger` beside the existing proof floor, capital reentry, consumer
evidence, and quality-adjusted frontier projections.

```text
profit_repair_settlement_ledger
  schema_version
  ledger_id
  generated_at
  fresh_until
  account_label
  trading_mode
  torghut_revision
  jangar_execution_trust_admission_ref
  consumer_evidence_receipt_id
  proof_floor_ref
  capital_reentry_ledger_ref
  quality_frontier_ref
  repair_lots[]
  aggregate_state
  next_safe_action
  rollback_target
```

Each lot is scoped and measurable:

```text
profit_repair_lot
  lot_id
  lot_class                  # quant_freshness | forecast_registry | route_tca | missing_tca |
                             # alpha_readiness | schema_lineage | rejection_drag | submit_enablement
  symbol_set
  hypothesis_ids
  current_state              # observe | repair | hold | paper_candidate | block
  value_gate
  expected_gate_delta
  required_receipts
  blocking_reason_codes
  next_repair_action
  paper_notional_limit
  live_notional_limit
  success_condition
  rollback_trigger
```

Initial lots:

- `quant_stage_freshness`: clear scoped ingestion/materialization lag for `PA3SX7FYNUTF/15m`.
- `forecast_registry_repair`: restore eligible forecast registry and promotion table evidence for
  `chip-paper-microbar-composite@execution-proof`.
- `aapl_receipt_settlement`: settle AAPL market context, quant, alpha, forecast, and Jangar admission before paper.
- `high_activity_tca_repair`: repair NVDA, AMD, AVGO, and INTC slippage/exclusion debt.
- `missing_tca_probe`: create simulation TCA evidence for AMZN, GOOGL, and ORCL.
- `schema_lineage_and_rejection_drag`: provide typed evidence for schema lineage and rejection drag that current profit
  lease projections mark missing.
- `submit_enablement`: keep `simple_submit_disabled` in force until all paper gates settle.

Rules:

- Every lot starts with `paper_notional_limit=0` and `live_notional_limit=0`.
- No paper candidate can be proposed while Jangar execution-trust admission is degraded or stale.
- No lot can improve `routeable_candidate_count` unless route/TCA, forecast, alpha, quant, and Jangar receipts are
  present.
- Threshold loosening cannot satisfy a route/TCA lot unless a separate risk waiver keeps notional at zero and names
  the expected slippage cost.
- Direct database access failure is recorded as observer limitation, not as proof success.

## Measurable Trading Hypotheses

H1: Quant freshness repair reduces stale-evidence holds.

- Baseline: 144 latest metrics are present, but scoped quant pipeline state is degraded with ingestion stage lag around
  596,178 seconds.
- Target: scoped quant stage status is current for live and sim before any paper probe proposal.
- Guardrail: notional remains zero while any required quant stage is stale.

H2: Forecast registry repair creates at least one paper-eligible hypothesis candidate.

- Baseline: consumer evidence blocks on `forecast_registry_degraded`; profit leases report empty research candidates
  and promotions.
- Target: one active candidate has an eligible forecast and promotion ref.
- Guardrail: forecast repair cannot override alpha readiness or route/TCA.

H3: Route/TCA repair increases candidate quality, not just count.

- Baseline: AAPL probes, four high-activity symbols are blocked, three symbols are missing, and live average absolute
  slippage is around 13.82 bps against an 8 bps guardrail.
- Target: at least two blocked or missing symbols move to observed/probing with slippage inside the route guardrail.
- Guardrail: any breach retires the lot back to repair with zero notional.

H4: Execution-trusted settlement lowers false readiness.

- Baseline: Jangar top-line readiness is ok while execution trust is degraded by swarm stage staleness.
- Target: Torghut paper proposals cite a current Jangar execution-trust admission.
- Guardrail: stale or degraded Jangar admission forces `paper_candidate=hold`.

H5: Capital safety remains intact.

- Baseline: proof floor is `repair_only`, live submission is disabled, and max notional is zero.
- Target: every repair lot preserves zero live notional until post-cost paper evidence settles.
- Guardrail: any non-zero live notional while proof floor is `repair_only` invalidates the ledger.

## Implementation Scope

Engineer stage should implement:

- A pure `profit_repair_settlement_ledger` reducer under `services/torghut/app/trading/`.
- Additive ledger payloads in `/trading/status`, `/readyz`, `/trading/health`, and `/trading/consumer-evidence`.
- Jangar execution-trust admission consumption as an optional receipt. Missing or degraded Jangar admission holds
  paper/live action but allows zero-notional repair.
- Tests for quant freshness lots, forecast registry lots, AAPL settlement, high-activity TCA repair, missing TCA
  repair, schema/rejection-drag lots, Jangar degraded admission, and invariant `max_notional=0`.
- A verifier update that fails if the ledger claims paper readiness while proof floor remains `repair_only`.

Do not put the scoring logic into `app/main.py` or `submission_council.py`. Keep the settlement reducer pure, then have
the API surfaces project it.

## Validation Gates

Local checks:

- `cd services/torghut && uv run --frozen pytest tests/test_profit_repair_settlement.py`
- `cd services/torghut && uv run --frozen pytest tests/test_consumer_evidence.py tests/test_capital_reentry_cohorts.py tests/test_quality_adjusted_profit_frontier.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `bunx oxfmt --check docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`

Runtime checks after rollout:

- `/db-check` remains current at one Alembic head.
- `/readyz` includes `profit_repair_settlement_ledger`.
- `/trading/consumer-evidence` includes the ledger ref and still reports `max_notional=0` while blockers are active.
- Jangar status cites the ledger in `profit_repair_settlement_admission`.
- Paper and live action classes remain held or blocked until all settlement lots clear.

## Rollout

1. Ship the ledger in shadow mode with no submission behavior change.
2. Compare ledger lots against proof floor, capital reentry cohorts, and quality-adjusted frontier for one market
   session.
3. Enable Jangar admission consumption for paper proposal holds.
4. Let zero-notional repair stages consume lot ids and value-gate refs.
5. Permit a bounded paper probe proposal only after quant, forecast, route/TCA, alpha, and Jangar admission settle.

## Rollback

- Hide the ledger from admission and leave existing proof floor, capital reentry, consumer evidence, and quality
  frontier behavior intact.
- Keep `simple_submit_disabled` and live notional zero.
- Revert through normal PR/GitOps image promotion if runtime health regresses.
- Do not repair by loosening slippage, forecast, or alpha thresholds.

## Handoff

Engineer handoff: the next bounded milestone is the pure settlement reducer and tests. It must cite this document
before changing code, and every repair lot must map to one of the five value gates.

Deployer handoff: deploy the first implementation as observe-only. Acceptance is a fresh ledger on `/readyz` and
`/trading/consumer-evidence`, unchanged zero-notional capital posture, current `/db-check`, Jangar admission visible,
and no new regression in route/TCA or quant freshness.
