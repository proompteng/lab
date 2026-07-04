# 154. Torghut Marginal Proof-Spend Portfolio And Capital Repair Budget (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, proof-floor blockers, repair prioritization, proof-spend budgets, Jangar brownout
admission, validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`

Extends:

- `153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`
- `152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`
- `151-torghut-repair-alpha-carry-exchange-and-paper-settlement-ledger-2026-05-07.md`

## Decision

I am selecting a marginal proof-spend portfolio as the next Torghut profitability architecture step.

Torghut is operationally alive but not economically clear for live capital. The live service returned HTTP `503` from
`/readyz` because the proof floor remained `repair_only` and capital remained `zero_notional`. At the same time,
Postgres, ClickHouse, Alpaca, schema lineage, Jangar universe, empirical jobs, and the readiness cache were healthy.
That split matters. The next profitable move is not "run every repair" or "block everything." It is to spend scarce
proof capacity on the repair with the highest expected marginal capital unlock per unit of controller load, data cost,
and runtime cost.

The proof-spend portfolio consumes Jangar brownout tokens from the companion design. Torghut submits repair bids for
TCA, market context, alpha readiness, quant ingestion, and live submission. Jangar admits only the bids that fit the
current controller budget. Torghut then measures whether the admitted repair changed the proof floor, capital stage,
post-cost edge, or drawdown budget. Repairs that only create activity without moving those measures lose future
priority.

The tradeoff is that Torghut must price repair work before it gets more repair capacity. I accept that. The system is
currently zero-notional because the proof floor is doing its job. The way back to profitability is not a larger cron
fanout; it is a ranked portfolio of proof repairs with measurable closure.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `proof_spend_portfolio` from `/trading/health`, `/readyz`, and `/trading/status`.
- Each repair bid names `bid_id`, `repair_dimension`, `hypothesis_ids`, `expected_blocker_delta`,
  `expected_after_cost_bps_delta`, `runtime_cost`, `controller_cost`, `data_cost`, `fresh_until`,
  `zero_notional_required`, `closure_metric`, and `rollback_target`.
- Bids are ranked by marginal expected value, not by arrival order.
- TCA recompute, TCA policy repair, market-context refresh, alpha-readiness repair, quant-ingestion repair, and
  live-submit policy changes are separate bid classes.
- Capital remains zero-notional until a closed repair changes proof-floor state and Jangar brownout admission allows
  the relevant action class.
- Paper widening requires positive post-cost edge, not just healthy infrastructure.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Runtime And Cluster Evidence

- Torghut live `/readyz` returned HTTP `503` with `status=degraded`.
- Torghut simulation `/readyz` returned HTTP `200` in paper mode.
- Torghut live and simulation active Knative deployments were available at `1/1` on current digest
  `sha256:69e1ddad4229200a90343a65facbb152ee6dfbf65e141e92539b4ddffdaf5e60`.
- Torghut options catalog, options enricher, TA jobs, ClickHouse, Keeper, Postgres, LLM guardrails exporter, WebSocket
  services, and Symphony Torghut pods were running.
- A pre-existing whitepaper autoresearch profit-target pod was in `Error`.
- Recent Torghut events showed rollout readiness churn, duplicate ClickHouse PodDisruptionBudget warnings, and Flink
  status-modified-externally warnings.
- Direct CNPG SQL and CNPG cluster listing were RBAC-blocked for this service account in `torghut`. Typed runtime
  endpoints are therefore the ordinary data witness for this architecture lane.

### Data And Proof Evidence

- Live Postgres dependency was ok.
- Live ClickHouse dependency was ok.
- Live Alpaca dependency was ok and used live endpoint class.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema graph lineage was ready with branch count `1`, no duplicate revisions, no orphan parents, and known parent
  fork warnings at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Empirical jobs were healthy for candidate `chip-paper-microbar-composite@execution-proof` and dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live submission gate was closed: `allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`.
- Profitability proof floor was not ok: `floor_state=repair_only`, `route_state=repair_only`,
  `capital_state=zero_notional`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`,
  `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and `simple_submit_disabled`.
- TCA evidence was fresh enough to evaluate but not good enough to promote: `13,775` orders, `13,571` filled
  executions, latest computed at `2026-05-07T14:23:44.018621+00:00`, average absolute slippage
  `13.7594875295276693` bps against an `8` bps guardrail.
- Runtime profitability reported `13,571` TCA samples, realized PnL proxy `-3286.40444948`, average realized
  shortfall `2.826144007757718664799941051` bps, p95 adverse excursion `46.51293116` bps, and max adverse excursion
  `609.20254541` bps.
- Market context remained a live capital blocker even while empirical jobs were healthy.

### Source Evidence

- `services/torghut/app/main.py` is `4145` lines and should stay route assembly, not proof-spend economics.
- `services/torghut/app/trading/proof_floor.py` is `593` lines and already emits blocker dimensions, proof
  dimensions, route state, and repair ladder entries.
- `services/torghut/app/trading/tca.py` is `887` lines and owns execution TCA refresh and metrics.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and owns empirical freshness authority.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and must remain the final deterministic
  submission gate.
- `services/torghut/app/trading/hypotheses.py` is `764` lines and owns hypothesis readiness and capital stage
  semantics.
- Existing tests cover TCA, empirical jobs, proof floor, submission council, strategy hypothesis governance,
  profitability evidence, market context, and runtime readiness. The missing tests are marginal proof-spend ranking,
  repair closure scoring, and Jangar brownout-token consumption.

## Problem

Torghut currently exposes proof-floor blockers, but the blockers do not yet compete for scarce repair budget. When
the system is zero-notional, every repair can sound urgent. That is not enough.

The failure modes are:

1. A TCA recompute can retire staleness while proving execution quality is still too poor for capital.
2. Market-context repair can be necessary for one hypothesis but irrelevant to another.
3. Empirical jobs can be fresh while live submission and alpha readiness remain blocked.
4. Running every repair during a Jangar controller brownout can increase platform risk without improving
   profitability.
5. Paper widening can consume scarce proof capacity unless it is tied to positive post-cost edge.

## Alternatives Considered

### Option A: Keep Capital Closed Until Every Proof-Floor Blocker Is Green

Pros:

- Safest capital posture.
- Easy for deployers to enforce.
- No new ranking model.

Cons:

- Does not tell engineering which repair matters first.
- Can waste time on low-impact proof repairs.
- Prevents paper learning even when a blocker is unrelated to the candidate hypothesis.

Decision: reject as too blunt.

### Option B: Recompute Or Retry Every Proof Surface On A Fixed Schedule

Pros:

- Simple operational model.
- Clears stale evidence eventually.
- Can be implemented mostly with existing scripts and jobs.

Cons:

- Adds load during Jangar controller brownout.
- Does not price provider, database, or ClickHouse query cost.
- Can produce fresh negative evidence without changing the capital decision.

Decision: reject. It creates motion without portfolio discipline.

### Option C: Publish A Marginal Proof-Spend Portfolio

Pros:

- Ranks repairs by expected blocker reduction and post-cost edge.
- Lets Jangar admit only the highest value zero-notional work during brownout.
- Separates measurement repairs from strategy or policy repairs.
- Creates measurable hypotheses for future capital reentry.

Cons:

- Requires scoring calibration.
- Needs new fixtures and operator education.
- Can mis-rank repairs if source evidence is stale.

Decision: select Option C.

## Architecture

Add a `proof_spend_portfolio` reducer outside `main.py`. The reducer consumes proof-floor dimensions, empirical job
freshness, TCA metrics, market-context freshness, hypothesis readiness, and Jangar brownout tokens.

`ProofSpendBid` fields:

- `bid_id`: deterministic hash of dimension, account, hypothesis, source revision, and evidence window.
- `repair_dimension`: `execution_tca`, `market_context`, `alpha_readiness`, `quant_ingestion`, `live_submit_gate`,
  or `forecast_registry`.
- `repair_class`: `measurement`, `policy`, `data_refresh`, `strategy_research`, or `operator_clearance`.
- `hypothesis_ids`: hypotheses affected by the repair.
- `proof_floor_before`: route state, capital state, and blocker list before repair.
- `expected_blocker_delta`: blocker count or severity expected to change.
- `expected_after_cost_bps_delta`: expected post-cost edge change.
- `runtime_cost`: expected compute, API, broker, and queue cost.
- `controller_cost`: requested Jangar spend tokens.
- `data_cost`: provider, ClickHouse, or archive cost.
- `fresh_until`: expiry for the bid.
- `closure_metric`: metric that must move for the repair to claim success.
- `capital_effect`: `none`, `observe_only`, `paper_candidate`, `live_hold`, or `live_candidate`.
- `rollback_target`: safe state if the repair worsens proof quality.

Portfolio scoring:

```text
score =
  expected_blocker_delta_weight
  + expected_after_cost_bps_delta_weight
  + confidence_weight
  - runtime_cost_penalty
  - controller_cost_penalty
  - data_cost_penalty
  - stale_source_penalty
```

Repairs that cannot produce a closure metric receive score `0`. Repairs that require notional exposure are rejected
while proof floor is `repair_only`. Repairs with zero-notional closure can receive Jangar repair tokens.

## Measurable Trading Hypotheses

Hypothesis 1: Execution TCA repair has the highest immediate capital unlock because slippage is the largest measured
live blocker.

- Metric: average absolute slippage must fall from `13.7594875295276693` bps to at or below the `8` bps guardrail or
  be converted into a strategy-specific no-go reason.
- Gate: paper-only replay and fresh TCA measurement over a full session.
- Failure condition: recompute is fresh but slippage remains above guardrail without a new policy repair bid.

Hypothesis 2: Market-context freshness improves alpha readiness only when it changes a hypothesis decision, not when
it merely writes a fresh provider row.

- Metric: promotion-eligible hypothesis count and accepted decision precision after context refresh.
- Gate: fresh market-context domains for the hypothesis evidence window plus a measurable alpha-readiness delta.
- Failure condition: market-context refresh is green but alpha readiness remains unchanged for two consecutive
  sessions.

Hypothesis 3: Brownout-aware proof spending improves throughput of useful repairs by reducing low-value retries.

- Metric: repaired blocker count per admitted proof-spend token.
- Gate: repair-token mode must lower retained failed pods or keep them flat while closing at least one proof-floor
  blocker.
- Failure condition: admitted repairs increase controller restarts, failed pods, or proof query latency without closing
  blockers.

## Guardrails

- No live capital while proof floor is `repair_only`.
- No paper widening unless post-cost edge is positive and the relevant proof-spend bid is closed.
- No repair bid can request notional exposure while `zero_notional_required=true`.
- No TCA measurement repair can claim capital unlock until it either clears the `8` bps guardrail or emits a stronger
  typed blocker.
- No market-context repair can claim success unless it changes durable evidence and a hypothesis-local freshness
  state.
- No Jangar brownout token means the repair waits, except for read-only observe work.

## Implementation Scope

Engineer stage:

- Add `proof_spend_portfolio.py` under `services/torghut/app/trading/`.
- Build bids from existing proof-floor, TCA, empirical, market-context, hypothesis, and submission-council inputs.
- Add portfolio summaries to `/readyz`, `/trading/health`, and `/trading/status`.
- Add Jangar brownout token consumption as an optional input; default to shadow when unavailable.
- Add tests for TCA measurement versus policy repair, market-context freshness with no alpha delta, zero-notional
  enforcement, stale source penalty, and Jangar token absence.
- Add fixtures using the current live blocker shape: TCA slippage above guardrail, market context stale, alpha
  readiness not promotion eligible, and simple submit disabled.

Deployer stage:

- Start in shadow mode and publish bid ranking without admission impact.
- Enable repair-token admission for the highest ranked zero-notional bid.
- Enable paper-gate use only after one full trading day of portfolio output.
- Keep live capital disabled until proof floor, submission council, and Jangar brownout budget all allow live micro
  canary.

## Validation Gates

- Unit: TCA recompute bid clears only measurement debt, not policy debt, when slippage remains above `8` bps.
- Unit: market-context refresh with no hypothesis delta receives lower score than a repair with direct capital
  blocker reduction.
- Unit: no proof-spend bid with notional exposure can pass while proof floor is `repair_only`.
- Unit: missing Jangar brownout token defers repair but does not mark proof data invalid.
- Unit: closed repair must cite a closure metric and source revision.
- Integration fixture: live `/readyz` blocker set produces TCA and market-context bids with zero-notional repair
  required.
- Performance: portfolio reducer completes under 100 ms on production-sized proof-floor and hypothesis fixtures.
- Trading validation: paper widening requires positive post-cost edge, no unresolved freshness blocker for the
  hypothesis, and a closed bid.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: publish proof-spend portfolio, no admission impact.
2. `repair-token`: Jangar admits the top zero-notional repair bid only.
3. `paper-gate`: paper canaries require a closed portfolio bid and positive post-cost edge.
4. `live-micro`: live micro-canary requires proof floor pass, submission council allow, and Jangar brownout budget
   allow.

Rollback:

- Disable bid enforcement first and keep shadow scoring.
- If scoring causes route latency, remove portfolio from `/readyz` and keep it on `/trading/status`.
- If bid ranking mis-prioritizes repairs, set scores to informational and fall back to the proof-floor repair ladder.
- Never roll back by enabling live capital while proof floor is `repair_only`; the safe target is zero notional.

## Risks

- Scoring can become false precision. Mitigation: initial scores are ordinal and tied to closure metrics.
- TCA may dominate all other repairs. Mitigation: cap per-dimension budget share until the first closure result.
- Market-context repairs can look useful without capital impact. Mitigation: require hypothesis-local delta before
  claiming repair dividend.
- Jangar brownout could starve Torghut proof repair. Mitigation: keep one low-cost zero-notional repair lane available
  when controller serving is healthy.

## Handoff Contract

Engineer acceptance gates:

- Portfolio reducer and tests cover all validation gates above.
- Route additions are additive and do not slow `/readyz` beyond the existing readiness cache budget.
- Bid output names source revision, closure metric, cost inputs, and rollback target.
- Zero-notional enforcement is deterministic.

Deployer acceptance gates:

- Shadow portfolio emits stable rankings for one full trading day.
- Repair-token mode closes or converts at least one proof-floor blocker without increasing controller brownout debt.
- Paper-gate mode does not admit paper widening without positive post-cost edge.
- Live remains disabled until proof floor, submission council, and Jangar brownout budget agree.
