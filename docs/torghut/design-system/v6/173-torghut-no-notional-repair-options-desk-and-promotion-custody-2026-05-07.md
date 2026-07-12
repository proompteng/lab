# 173. Torghut No-Notional Repair Options Desk And Promotion Custody (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

I am selecting a **no-notional repair options desk with promotion evidence custody** as the next Torghut profitability
architecture step.

Torghut should not receive paper or live capital from the current state. `/trading/health` reports `status=degraded`,
proof floor `repair_only`, capital state `zero_notional`, and maximum notional `0`. Blocking reasons are
`hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, `market_context_stale`, and
`simple_submit_disabled`. The route reacquisition book is still valuable: it shows one probing symbol and seven repair
candidates, with `NVDA`, `AMD`, `INTC`, and `AVGO` blocked by TCA and `AMZN`, `GOOGL`, and `ORCL` missing route
evidence. That is not capital evidence, but it is a good repair backlog.

The database makes the same point in sharper form. Torghut has 147,623 trade decisions and 13,775 execution TCA rows,
so there is enough history to form execution hypotheses. It has only one shadow promotion decision, zero allowed
promotion decisions, zero research promotions, zero vnext promotion decisions, and zero autoresearch epochs/specs. The
profitable path is to spend compute on no-notional repairs that can produce missing promotion evidence, not to widen
capital because some data surfaces are fresh.

The design answer is an options desk. Each repair option is a small, auditable hypothesis with expected unblock value,
cost, evidence half-life, symbol scope, validation test, and promotion custody. It can use stale or incomplete evidence
only while max notional is zero and the Jangar ready-action packet allows `torghut_observe` or bounded repair. It cannot
graduate to paper or live until the option produces fresh route, market context, alpha readiness, TCA, and promotion
receipts.

The tradeoff is that Torghut will spend time on measurement before capital. I am choosing that because profitability
depends on post-cost, promotion-quality evidence. Activity volume by itself is not edge.

## Success Metrics

Success means:

- `/trading/status` and `/trading/health` emit `repair_options_desk`.
- Each desk includes `desk_id`, `generated_at`, `account_label`, `revision`, `jangar_ready_action_packet_ref`,
  `repair_options`, `promotion_custody`, `capital_gate`, `rollback_target`, and `fresh_until`.
- Each repair option includes `option_id`, `hypothesis`, `symbol_scope`, `evidence_refs`, `expected_unblock_value`,
  `estimated_cost`, `max_notional`, `required_outputs`, `validation_gate`, `promotion_custodian`, and
  `invalidation_rule`.
- All initial options have `max_notional=0`.
- Route repair options can rank `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and `ORCL`, but cannot submit orders.
- Paper canary remains held until market context is fresh, route TCA is complete, alpha readiness has at least one
  promotion-eligible hypothesis, promotion evidence exists, and Jangar `paper_canary` is `allow`.
- Live capital remains blocked until paper evidence is current, live submission is explicitly enabled, and Jangar live
  packets are `allow`.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, databases,
trading flags, promotion records, or orders.

### Runtime And Cluster Evidence

- Argo CD reported `torghut` `Synced/Healthy` at main
  `250e2e1fd8a14ea235215ab8bb93cb8cf9e40421`, with the last operation succeeded at `2026-05-07T23:11:36Z`.
- Torghut live revision `torghut-00289` and sim revision `torghut-sim-00388` were running.
- ClickHouse, Keeper, Torghut DB, TA, TA sim, options catalog, options enricher, WebSocket services, and guardrail
  exporters were running.
- One retained `torghut-whitepaper-autoresearch-profit-target` pod remained in `Error`.
- Recent Torghut events included startup and readiness probe failures during revision transition before the latest
  live and sim revisions became ready.

### Trading Evidence

- `/trading/health` returned `status=degraded`.
- Proof floor:
  - `floor_state=repair_only`
  - `route_state=repair_only`
  - `capital_state=zero_notional`
  - `max_notional=0`
- Blocking reasons:
  - `hypothesis_not_promotion_eligible`
  - `execution_tca_route_universe_incomplete`
  - `market_context_stale`
  - `simple_submit_disabled`
- Alpha readiness had 3 hypotheses, 0 promotion-eligible, and 3 rollback-required.
- Quant ingestion was informational, not a capital pass. Latest metrics were fresh, but pipeline health was degraded
  with large stage lag.
- Execution TCA covered 7,334 orders and 7,245 filled executions in the health payload. The route universe had one
  probing symbol, four blocked symbols, and three missing symbols.
- Route repair priority favored `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and `ORCL`.

### Database And Data Evidence

- Direct Torghut Postgres reads succeeded with the app credential. `current_database()` returned `torghut`.
- `trade_decisions` exact count was 147,623, with newest decision at `2026-05-06T17:44:19Z`; 13,775 rows had
  executions.
- `execution_tca_metrics` had 13,775 rows, 12 symbols, and newest computation at `2026-05-07T14:23:44Z`.
- `strategy_hypotheses` had 1 active row.
- `strategy_promotion_decisions` had 1 row, `allowed=false`, state `shadow`.
- `research_promotions`, `vnext_promotion_decisions`, `autoresearch_epochs`, and `autoresearch_candidate_specs` had
  zero rows.
- `vnext_empirical_job_runs` had 24 rows, all status `completed`, all promotion-authority eligible, newest update at
  `2026-05-07T21:27:18Z`; there were still no vnext promotion decisions.
- Direct Jangar Postgres reads showed fresh `torghut_control_plane.quant_metrics_latest` rows through
  `2026-05-07T23:24Z`, but `quant_pipeline_health` carried about 51,102,150 live rows and no sampled autovacuum or
  autoanalyze timestamp.
- Market-context snapshots in Jangar remained split: news was updated on 2026-05-07, while fundamentals were last
  updated on 2026-03-16.

## Problem

Torghut has enough observations to know what is broken, but not enough promotion evidence to risk capital. The
profitable failure mode to avoid is "busy repair": running refreshes, simulations, and schedule jobs that do not
produce a promotion-quality receipt.

Repair work needs the discipline of an options desk:

1. Name the hypothesis before spending compute.
2. Price the expected unblock value.
3. Bind the work to a symbol or evidence surface.
4. Keep max notional at zero.
5. Define the promotion receipt that would make the option valuable.
6. Expire the option when evidence half-life or market regime changes.

Without that structure, Torghut can keep accumulating proof data while paper/live capital remains correctly blocked and
profitability does not improve.

## Alternatives Considered

### Option A: Keep Proof Floor Gates Only

Use the current proof floor and route reacquisition book as the complete repair contract.

Advantages:

- Already implemented.
- Correctly blocks capital today.
- Provides a ranked route repair list.

Disadvantages:

- Does not require each repair to state a measurable profit hypothesis.
- Does not tie repair completion to a promotion custody receipt.
- Does not separate cheap no-notional repair from expensive broad refreshes.

Decision: keep proof floor as an input, but reject it as the complete repair desk.

### Option B: Refresh Every Surface Before Any Repair

Require market context, route TCA, quant health, alpha readiness, empirical jobs, and promotion tables to be fresh
before running additional repair.

Advantages:

- Strong evidence quality.
- Simple to audit.
- Reduces stale-evidence loops.

Disadvantages:

- Blocks useful zero-notional repair during closed sessions.
- Spends compute on low-value refreshes before ranking actual blockers.
- Still does not create promotion decisions.

Decision: reject as too blunt.

### Option C: No-Notional Repair Options Desk

Create a portfolio of zero-notional repair options ranked by expected unblock value, cost, half-life, and promotion
custody.

Advantages:

- Turns repair work into measurable profitability hypotheses.
- Allows useful repair without capital exposure.
- Forces every option to produce a promotion-quality output or expire.
- Gives Jangar a compact consumer contract through the ready-action exchange.

Disadvantages:

- Adds option lifecycle state.
- Requires cost and unblock estimates to be calibrated over time.
- Slows paper promotion until custody receipts exist.

Decision: select Option C.

## Architecture

Torghut emits:

```text
repair_options_desk
  schema_version
  desk_id
  generated_at
  account_label
  revision
  jangar_ready_action_packet_ref
  repair_options
  promotion_custody
  capital_gate
  rollback_target
  fresh_until
```

Each option includes:

```text
repair_option
  option_id
  option_class           # route_repair | context_refresh | alpha_readiness | tca_refresh | promotion_custody
  hypothesis
  symbol_scope
  evidence_refs
  expected_unblock_value
  estimated_cost
  max_notional
  required_outputs
  validation_gate
  promotion_custodian
  invalidation_rule
  expires_at
```

Initial option classes:

- `route_repair`: repair blocked or missing route evidence for `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and
  `ORCL`.
- `context_refresh`: refresh stale market-context domains and prove freshness per domain.
- `alpha_readiness`: turn blocked/shadow hypotheses into promotion-eligible or rollback-closed states.
- `tca_refresh`: recompute route TCA and compare slippage against guardrails.
- `promotion_custody`: write a promotion decision or explicit denial with evidence bundle and rollback path.

Initial measurable hypotheses:

- Route repair is valuable only if at least one blocked or missing symbol reaches routeable/probing state without
  increasing max notional above zero.
- Market-context repair is valuable only if stale domains move inside freshness thresholds before the next paper gate.
- Alpha readiness repair is valuable only if at least one hypothesis becomes promotion-eligible and zero hypotheses are
  rollback-required for the same candidate.
- TCA repair is valuable only if route universe completeness improves and average absolute slippage stays within the
  guardrail for the candidate symbol set.
- Promotion custody repair is valuable only if it writes a durable allowed or denied decision with traceable evidence.

## Capital Rules

- `torghut_observe`: allowed only when Jangar ready-action exchange permits observe or bounded repair.
- `repair_option_execute`: allowed with `max_notional=0`, bounded runtime, and named output receipts.
- `paper_canary`: held until Jangar `paper_canary=allow`, proof floor is above `repair_only`, market context is fresh,
  route TCA is complete, alpha readiness is promotion-eligible, and promotion custody exists.
- `live_micro_canary`: blocked until paper canary evidence is current and live submission is explicitly enabled.
- `live_scale`: blocked until live micro canary evidence passes independently and Jangar live packets are `allow`.

Fresh quant metrics are not enough to unlock capital. The desk treats them as context unless the option's required
outputs include the matching promotion receipt.

## Implementation Scope

Engineer scope:

1. Add a `repair_options_desk` builder near the existing profitability proof floor and route reacquisition book.
2. Reuse existing health inputs rather than querying large proof tables in hot paths.
3. Add a persistence table or JSON status section for option lifecycle only after the advisory payload proves stable.
4. Add tests for zero-notional invariants, option expiry, promotion custody absence, and Jangar packet gating.
5. Add UI rows that show option class, symbol scope, expected unblock value, max notional, required output, and
   expiration.

Deployer scope:

1. Do not enable paper or live capital from a repair option alone.
2. Accept option execution only when max notional is zero and the Jangar packet allows `torghut_observe` or bounded
   repair.
3. Require a promotion custody receipt before paper canary.
4. Roll back by disabling option execution and preserving generated option/receipt evidence.

## Validation Gates

Required local validation for implementation:

- `pytest services/torghut/tests/test_profitability_proof_floor.py`
- `pytest services/torghut/tests/test_route_reacquisition.py`
- `pytest services/torghut/tests/test_verify_trading_readiness.py`
- `pytest services/torghut/tests/test_autonomy_evidence.py`
- `bun run --cwd services/jangar test -- src/server/__tests__/torghut-trading-summary.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/torghut-quant-metrics-store.test.ts`

Required read-only deployer validation:

- `curl -sS http://torghut.torghut.svc.cluster.local/trading/health`
- `curl -sS http://torghut.torghut.svc.cluster.local/trading/status`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- Read-only SQL for Torghut `trade_decisions`, `execution_tca_metrics`, `strategy_hypotheses`,
  `strategy_promotion_decisions`, `research_promotions`, `vnext_empirical_job_runs`, `vnext_promotion_decisions`, and
  autoresearch tables.
- Read-only SQL for Jangar `torghut_control_plane.quant_metrics_latest`,
  `torghut_control_plane.quant_pipeline_health`, and `public.torghut_market_context_snapshots`.

## Rollout

1. Ship `repair_options_desk` in advisory mode.
2. Render options in the Torghut/Jangar control-plane UI without changing capital gates.
3. Compare desk ranking against the existing route reacquisition book and proof floor for one full market session.
4. Allow zero-notional option execution only after Jangar ready-action packets permit bounded Torghut repair.
5. Require promotion custody receipts before any paper canary decision.

## Rollback

Rollback target:

- Disable option execution.
- Keep the proof floor, route reacquisition book, and existing capital gates unchanged.
- Preserve generated option payloads for audit.
- Keep `live_submit_enabled=false` and max notional at `0`.

Rollback must not delete trading evidence, mutate promotion decisions, or bypass the proof floor.

## Risks And Tradeoffs

- Expected unblock values can be wrong early. Treat them as ranking hints until calibrated against completed repairs.
- Option payloads can become stale quickly around market open. Every option needs `expires_at`.
- A no-notional option can still waste compute. The desk must track estimated cost and completion value.
- Promotion custody can become a paperwork exercise. Require actual evidence refs, not title-only approvals.

## Handoff Contract

Engineer acceptance gates:

- Implement the desk without enabling paper or live capital.
- Prove every option defaults to `max_notional=0`.
- Prove missing promotion custody blocks paper canary even when route or quant evidence improves.
- Prove Jangar ready-action packets are consumed as gates, not advisory text, before any paper/live packet can unlock.

Deployer acceptance gates:

- Before running a repair option, confirm `max_notional=0`, `expires_at` is future, and Jangar allows bounded Torghut
  repair.
- Before paper canary, require a fresh promotion custody receipt plus Jangar `paper_canary=allow`.
- Before live micro canary, require paper evidence, live submission enablement, and Jangar live packet `allow`.
- Roll back by disabling option execution and preserving receipts, not by deleting negative evidence.
