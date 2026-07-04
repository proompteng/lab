# 184. Torghut Profit Frontier Reclocking And Capital Reentry Guardrails (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `services/torghut/app/observability/posthog.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

Torghut should publish a **profit frontier packet** that ranks repair work by expected capital-unblock value while
keeping all notional capital closed until the existing guardrails pass.

The current runtime is safe but not yet profitable. It is live and serving, but submission is disabled, promotion
eligibility is zero, quant stage evidence is missing, market context is partly stale, and the route-proven profit receipt
is in repair state. The profitable move is not to relax those gates. It is to make the next zero-notional repair
measurable, ranked, and consumable by Jangar before another Torghut stage spends schedule capacity.

The tradeoff is slower capital reentry. Torghut will remain repair-only until it can prove fresh quant stages, forecast
registry health, route rehearsal, and TCA realism for a named hypothesis.

## Evidence Snapshot

This evidence pass was read-only on 2026-05-08.

- Torghut is running in live mode on active revision `torghut-00308`, version `v0.568.5-588-ge87e3d87d`, commit
  `e87e3d87d3b8313f408704e2fa9317bb5a679c8e`.
- `/readyz` and `/trading/health` return HTTP 503 degraded. Postgres, ClickHouse, Alpaca, and schema currentness are
  OK. The current and expected schema head is `0030_evidence_epochs`. Schema lineage is ready but still reports known
  parent-fork warnings at earlier migrations.
- `/trading/status` reports `enabled=true`, `mode=live`, and `running=true`. The live submission gate is not allowed:
  reason `simple_submit_disabled`, blocked by `simple_submit_disabled` and
  `hypothesis_not_promotion_eligible`.
- The hypothesis registry path `/app/config/trading/hypotheses` is loaded with three hypotheses. All three are in
  shadow, all capital multipliers are zero, promotion-eligible total is zero, and rollback-required total is three.
- TCA has 7,334 orders, average absolute slippage around 13.82 bps, and eight symbols in scope, but the latest execution
  timestamp is 2026-04-02. That is useful historical evidence, not enough active-session execution realism.
- `/trading/consumer-evidence` emits schema `torghut.consumer-evidence-status.v1`, active revision `torghut-00308`, and
  a route-proven profit receipt in `repair` state. Reason codes include `forecast_registry_degraded`,
  `simple_submit_disabled`, and `hypothesis_not_promotion_eligible`.
- Consumer evidence reports empirical jobs healthy and ready, but forecast service degraded with `registry_empty`,
  market context degraded with stale `technicals`, `news`, and `regime` domains, and quant evidence degraded with
  `quant_pipeline_stages_missing`. Latest quant metrics count is 144, but pipeline stage count is zero.
- The capital reentry ledger has five zero-notional cohorts and aggregate decision `repair`, with expected unblock value 19. Route repair value is 14. Those are scheduling priorities, not permission to trade.
- Direct database inspection through CNPG is blocked for this agent by RBAC: listing CNPG resources and execing into
  database pods are forbidden. Runtime database evidence therefore comes from the Torghut readiness and consumer
  evidence surfaces for this pass.

## Problem

Torghut has enough evidence to stay safe and not enough evidence to reenter capital.

The control gap is that degraded proof is visible but not shaped into the next most valuable repair action. Jangar sees
Torghut as degraded and can run more work, but the system needs to answer a sharper question first: which zero-notional
repair is expected to move the capital frontier the most, and what proof will retire it?

Without that frontier:

- forecast registry repair, quant pipeline repair, market context refresh, route rehearsal, and TCA collection compete
  informally;
- schedule capacity can be spent on work that does not unblock promotion eligibility;
- capital remains correctly blocked, but the reason does not turn into a measured repair loop;
- stale or historical execution evidence can be overvalued relative to active-session proof.

## Alternatives Considered

### Option A: Reenable Submission Or Promote A Shadow Hypothesis To Paper

Pros:

- Produces direct route and fill data faster.
- Makes profitability outcomes visible sooner.

Cons:

- Violates the current live submission gate.
- Ignores zero promotion eligibility and rollback-required hypotheses.
- Risks treating old TCA evidence as active-session proof.

Decision: reject. Capital should not be used to debug missing proof.

### Option B: Refresh Every Degraded Evidence Source

Pros:

- Simple operator instruction.
- May clear several blocked reasons at once.

Cons:

- Treats forecast registry, quant stages, market context, and route rehearsal as equal value.
- Can waste schedule and data budgets when only one blocker is frontier-moving.
- Does not create an auditable proof that a repair produced capital-unblock value.

Decision: reject as the default. It remains a manual incident response option.

### Option C: Profit Frontier Packet And Reclocked Repair Queue

Pros:

- Converts every blocker into a ranked repair with expected unblock value.
- Gives Jangar a compact consumer evidence object for dispatch admission.
- Keeps notional capital closed until proof gates pass.
- Makes profitability innovation measurable through routeability, TCA freshness, promotion eligibility, and repair yield.

Cons:

- Requires careful scoring so expected unblock value does not become optimism.
- Needs fresh clocks for several evidence surfaces.
- Adds another packet that must remain deterministic and small.

Decision: select Option C.

## Chosen Architecture

Torghut emits one profit frontier packet per evidence window. The packet is a scheduling and admission object. It is not
a capital clearance object.

```text
profit_frontier_packet
  frontier_id
  generated_at
  fresh_until
  active_revision
  schema_head
  hypothesis_snapshot
  forecast_registry_state
  quant_stage_state
  market_context_state
  route_rehearsal_state
  tca_state
  live_submission_gate
  capital_reentry_state
  repair_candidates
  selected_zero_notional_repair
  jangar_consumer_evidence_ref
```

Each repair candidate carries:

```text
repair_candidate
  repair_id
  target_surface
  current_blockers
  expected_unblock_value
  expected_routeability_delta
  expected_tca_freshness_delta
  max_runtime
  data_cost_budget
  success_receipt
  rollback_receipt
  next_reclock_at
```

The ranking function is:

```text
expected_unblock_value
  + expected_routeability_delta
  + expected_tca_freshness_delta
  - data_cost_budget
  - falsification_risk_cost
  - staleness_penalty
```

Scores are used only to pick zero-notional repair order. They must never bypass `live_submission_gate`,
promotion eligibility, or rollback-required status.

## Reclocking Rules

Torghut should track separate proof clocks.

- **Schema clock:** current and expected head match, lineage ready, no unexpected heads.
- **Forecast registry clock:** consumer forecast registry is non-empty and fresh, independent of the static hypothesis
  config load.
- **Quant stage clock:** quant metrics include nonzero pipeline stage coverage and current-stage freshness.
- **Market context clock:** technicals, news, regime, and fundamentals each declare freshness and stale domains.
- **Route rehearsal clock:** selected hypothesis has route universe and route rehearsal proof.
- **TCA clock:** execution samples are recent enough for the active session and slippage is inside declared tolerance.
- **Capital readiness clock:** hypothesis is not rollback-required and is promotion eligible for the requested lane.
- **Jangar rollout clock:** Jangar has a fresh rollout certificate when the action depends on a newly deployed contract.

If any clock is stale, the packet can select a repair. It cannot clear capital.

## Profitability Hypotheses

The first implementation stage should test these hypotheses without notional capital.

1. Rehydrating the consumer forecast registry removes `forecast_registry_degraded` and increases selected repair
   routeability without increasing rollback-required hypotheses.
2. Restoring quant pipeline stage coverage from zero to nonzero reduces `quant_pipeline_stages_missing` and increases
   promotion-candidate explainability.
3. Refreshing stale market context domains during the active session reduces closed-session and stale-context holds for
   at least one shadow hypothesis.
4. Route rehearsal for the highest expected-unblock repair increases routeable candidates while keeping average absolute
   slippage within the declared TCA tolerance.
5. A Jangar-admitted zero-notional repair produces a fresh success receipt and reduces duplicate Torghut schedule
   failures for the same blocker.

## Capital Reentry Ladder

Capital remains fail-closed by default.

- **Level 0: repair-only.** Current state. Maximum notional is zero. Jangar may schedule only named repairs from the
  frontier packet.
- **Level 1: paper rehearsal.** Allowed only after schema, forecast, quant stage, market context, route rehearsal, and
  TCA clocks are fresh enough for the selected hypothesis. Still no live notional.
- **Level 2: guarded live canary.** Allowed only when live submission is enabled, promotion eligibility is positive,
  rollback-required is false for the selected hypothesis, TCA is fresh, and Jangar rollout evidence is current.
- **Level 3: scaled capital.** Out of scope for this milestone. Requires separate design and observed canary profit.

## Implementation Milestones

| Milestone | Scope                                                                                                                                | Value gates                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| T0        | Merge this design and companion Jangar admission contract.                                                                           | `handoff_evidence_quality`                          |
| T1        | Add profit frontier packet builder from existing consumer evidence, status, TCA, and capital reentry ledger data.                    | `ready_status_truth`, `handoff_evidence_quality`    |
| T2        | Add deterministic repair ranking for forecast registry, quant stage, market context, route rehearsal, and TCA blockers.              | `manual_intervention_count`, `failed_agentrun_rate` |
| T3        | Add zero-notional route rehearsal receipts and success/rollback receipt refs for selected repairs.                                   | `failed_agentrun_rate`, `handoff_evidence_quality`  |
| T4        | Feed the selected repair into Jangar dispatch admission and deny non-frontier Torghut work while proof is stale.                     | `failed_agentrun_rate`, `manual_intervention_count` |
| T5        | Add capital reentry checks that separate repair-only, paper rehearsal, guarded live canary, and scaled capital.                      | `ready_status_truth`, `manual_intervention_count`   |
| T6        | Publish profitability movement counters: routeable candidate count, fresh TCA sample count, promotion eligibility, and repair yield. | `pr_to_rollout_latency`, `handoff_evidence_quality` |

## Validation Gates

Engineer stages must add tests for the current degraded proof state:

- `simple_submit_disabled` keeps Level 2 and Level 3 capital closed.
- zero promotion eligibility keeps all notional capital closed.
- `forecast_registry_degraded` creates a forecast repair candidate.
- `quant_pipeline_stages_missing` creates a quant stage repair candidate.
- stale market context domains create domain-specific repair candidates.
- old TCA execution timestamps are not treated as active-session proof.
- positive expected unblock value selects exactly one zero-notional repair.

Deployer stages must verify:

- `/readyz`, `/trading/health`, `/trading/status`, and `/trading/consumer-evidence` expose compatible packet refs or
  exact unavailable reasons;
- Jangar consumes the packet as admission evidence and does not create non-frontier Torghut work while the packet is in
  repair state;
- capital remains closed until the declared clocks pass;
- a fresh repair receipt retires the matching blocker or records the failed falsification check.

## Rollout Plan

1. Emit the profit frontier packet in shadow mode from current runtime evidence.
2. Compare selected repairs with observed operator and schedule-runner behavior for one trading session.
3. Let Jangar read the packet but deny nothing.
4. Enforce only repair-only admission for Torghut stages when the packet is in `repair` state.
5. Add paper rehearsal only after the proof clocks are fresh and capital remains zero.
6. Consider guarded live canary only through a separate PR and separate review.

## Rollback Plan

- Disable frontier packet consumption in Jangar.
- Keep Torghut live submission gate unchanged.
- Keep all hypotheses in shadow or rollback-required state until existing policy checks clear them.
- Fall back to current `/trading/status` and `/trading/consumer-evidence` degraded reasons.
- Do not promote capital as rollback. A failed frontier rollout should reduce automation, not loosen trading safety.

## Risks And Mitigations

- **Risk: expected unblock value is gamed by stale inputs.** Penalize staleness and require success receipts before a
  repair can claim yield.
- **Risk: forecast registry and hypothesis registry are confused.** Track the consumer forecast registry separately from
  static hypothesis config load and report both states.
- **Risk: old TCA looks better than live routeability.** Require an active-session TCA clock for paper or live movement.
- **Risk: Jangar denies useful repair work.** Enforce only the selected frontier repair first; keep all other denials in
  shadow until dispatch evidence proves value.
- **Risk: direct database evidence remains unavailable.** Treat runtime schema evidence as sufficient for repair-only
  work and create a least-privilege database witness milestone before capital-adjacent enforcement.

## Engineer Handoff

Start with T1 and T2. Build the frontier packet from existing runtime projections before adding new persistence. The
first PR should prove the current degraded state produces a selected zero-notional repair and keeps all capital lanes
closed.

Every implementation PR must cite this document and the companion Jangar design. The PR must state which proof clock it
changes and which value gate should move.

## Deployer Handoff

After rollout, collect `/trading/status`, `/trading/consumer-evidence`, Jangar `/ready`, Argo state, and workload
readiness. The acceptance gate is not "Torghut is profitable" after one rollout. The gate is that Torghut names the
highest-value repair, Jangar admits only that repair while proof is degraded, and all notional capital remains closed
until the clocks pass.
