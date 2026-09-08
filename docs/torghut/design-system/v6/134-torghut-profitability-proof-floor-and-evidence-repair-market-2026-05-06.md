# 134. Torghut Profitability Proof Floor And Evidence Repair Market (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting **a profitability proof floor with an evidence repair market** as Torghut's next quant architecture step.

The current system is operational, but it is not trade-ready. At `2026-05-06T20:40Z`, live Torghut was serving revision
`torghut-00244`, sim was serving `torghut-sim-00344`, Postgres schema was current at Alembic head
`0029_whitepaper_embedding_dimension_4096`, empirical jobs were fresh, and the dependency quorum said the control plane
was healthy. Those are necessary conditions.

They are not sufficient conditions for profit. Live `/readyz` and `/trading/health` returned `503`. The live submission
gate was closed with reason `simple_submit_disabled`, capital stage `shadow`, and no promotion-eligible hypotheses.
Quant evidence was degraded because ingestion lag was about `10549` seconds. Market context was degraded because all
domains were stale. The TCA view still pointed to `2026-04-02T20:59:45Z` and showed average absolute slippage around
`568.6` bps against hypothesis contracts that expect single-digit to low-double-digit bps. H-MICRO-01 was blocked on
missing drift checks and feature rows; H-REV-01 remained shadow due stale market context; H-CONT-01 had signal lag.

The selected design refuses to spend paper or live notional until Torghut clears a proof floor that is current across
data freshness, execution settlement, market context, hypothesis features, and stable Jangar platform receipts. It does
not freeze the system. Instead, it creates an evidence repair market: zero-notional jobs compete for repair budget based
on expected promotion value, blocker severity, and proof freshness. The tradeoff is slower capital reentry. I accept it
because Torghut's next profitability gain comes from clearing the evidence bottlenecks in the right order, not from
forcing another shadow-gated run through stale settlement.

## Runtime Objective And Success Metrics

This contract increases profitability by making capital admission depend on a current proof floor and by turning
degraded evidence into prioritized zero-notional repair work.

Success means:

- Paper/live capital remains zero until Torghut has current quant ingestion, market context, empirical proof, execution
  settlement, hypothesis feature coverage, and a stable Jangar synthetic readiness receipt.
- Evidence repair jobs are ranked by expected unblock value and measurable trading hypothesis impact.
- Fresh empirical jobs can fund repair work but cannot override stale execution, stale market context, or missing
  feature/drift proof.
- Each hypothesis has a named proof-floor blocker, guardrail, measurement window, and rollback condition.
- Deployer rollout gates require proof-floor receipt freshness before widening Torghut revisions or enabling paper
  canaries.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker state,
GitOps manifests, or ClickHouse tables.

### Cluster And Runtime Evidence

- Torghut live `torghut-00244-deployment-556cc5c594-4kjls` and sim
  `torghut-sim-00344-deployment-68787fcc66-rmdp5` were running with both containers ready.
- Supporting Torghut components were running, including ClickHouse, keeper, Postgres, TA, sim TA, options TA, options
  catalog, options enricher, websocket services, guardrail exporters, and alloy.
- Recent Torghut events showed empirical backfill and whitepaper bootstrap jobs completing, plus the previous live
  revision scaling down.
- A late readiness probe failure still appeared for the previous `torghut-00243` pod. Rollout gates should read the
  current revision and recent event debt, not just the new pod's ready bit.
- The agents service account cannot exec into Torghut pods or directly inspect database pods. Routine validation must
  use routes, projections, and emitted receipts.

### Route And Control-Plane Evidence

- Live `/readyz` returned HTTP `503`.
- Live `/trading/health` returned HTTP `503`.
- Live status reported `mode=live`, `live_submission_gate.allowed=false`, reason `simple_submit_disabled`,
  `capital_stage=shadow`, `configured_live_promotion=false`, and `promotion_eligible_total=0`.
- Quant evidence was informationally allowed but degraded: `latestMetricsCount=144`, latest metrics updated at
  `2026-05-06T20:40:28Z`, `metricsPipelineLagSeconds=7`, and `maxStageLagSeconds=10549`.
- Quant compute lag was `1` second, ingestion lag was `10549` seconds and unhealthy, and materialization lag was `21`
  seconds and unhealthy.
- Market context health was degraded. Technicals, fundamentals, news, and regime were all stale; news freshness was
  about `4410253` seconds against a `300` second limit.
- Empirical jobs were healthy and promotion-authority eligible for `chip-paper-microbar-composite@execution-proof`.
- Hypothesis registry loaded three source hypotheses: H-CONT-01 shadow, H-MICRO-01 blocked, and H-REV-01 shadow. All
  capital multipliers were zero.
- TCA reported `order_count=13775`, average absolute slippage around `568.6` bps, and last compute time
  `2026-04-02T20:59:45Z`.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, and matching current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Earlier route evidence showed migration graph fork warnings even while schema head was current. Proof-floor receipts
  must preserve schema lineage evidence separately from data freshness.
- Direct Postgres and ClickHouse reads through pod exec were blocked by RBAC. The normal product must expose enough
  data-quality and freshness evidence through safe routes.
- Live status and execution routes showed a stale settlement surface: recent decisions existed, but execution/TCA
  settlement still anchored to early April.
- Sim readiness was better at the route layer but sim quant evidence was empty earlier in the lane, which means paper
  parity cannot be inferred from live pods alone.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already builds live submission gate payloads from dependency
  quorum, empirical jobs, DSPy, quant evidence, toggle parity, promotion certificate evidence, and lineage refs.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` blocks live simple submits before order submission when
  live submission is disabled or the gate denies.
- `services/torghut/app/trading/hypotheses.py` already defines hypothesis entry/promotion contracts and converts
  evidence gaps into reasons such as `market_context_stale`, `drift_checks_missing`, and `feature_rows_missing`.
- `services/torghut/app/trading/empirical_jobs.py` already verifies freshness, truthfulness, authority, candidate ids,
  and dataset snapshot refs for empirical jobs.
- The missing architecture layer is a proof-floor reducer and repair market that ranks the next zero-notional work
  rather than letting every blocker compete informally through route status.

## Problem

Torghut has too many individually reasonable gates and not enough settlement around which gate is the highest-value
profitability blocker.

The current failure modes are:

1. **Operational readiness is mistaken for trade readiness.** Running pods and a current schema do not prove profit.
2. **Fresh empirical proof is overpowered by stale execution settlement.** Empirical jobs are current, but TCA and live
   execution settlement are weeks old.
3. **Quant freshness is mixed.** Latest metrics are current while ingestion is hours behind.
4. **Market context is stale across every domain.** Event-reversion and LLM-assisted review cannot price current risk.
5. **Hypothesis blockers are not ranked.** Feature rows, drift checks, signal lag, market context, and TCA all block
   capital, but the system does not price which repair has the fastest route to a valid canary.
6. **Jangar platform receipts are not yet synthetic.** Torghut needs stable platform proof before spending capital, but
   platform proof alone is not profitability proof.

## Alternatives Considered

### Option A: Promote Paper Because Empirical Jobs Are Fresh

Pros:

- Fast path to more recent paper observations.
- Uses the current live and sim revisions.
- Converts fresh empirical jobs into action quickly.

Cons:

- Ignores `/readyz` and `/trading/health` failures.
- Ignores stale market context and quant ingestion lag.
- Ignores stale execution/TCA settlement.
- Risks confusing a fresh backtest artifact with current tradability.

Decision: reject.

### Option B: Freeze All Trading Work Until Every Dependency Is Healthy

Pros:

- Strongest capital safety.
- Easy to explain during incident response.
- Avoids acting on contradictory signals.

Cons:

- Wastes fresh empirical proof and healthy compute stages.
- Produces no repair ordering.
- Slows the feedback loop that should make Torghut profitable.
- Treats zero-notional evidence repair as if it had the same risk as live notional.

Decision: reject.

### Option C: Profitability Proof Floor With Evidence Repair Market

Pros:

- Keeps capital at zero while preserving repair throughput.
- Converts each blocker into a priced repair bid with measurable expected unblock value.
- Separates platform proof from trading proof.
- Lets fresh empirical jobs fund the next best evidence repair without overriding stale settlement.
- Gives engineer and deployer stages concrete gates and rollback conditions.

Cons:

- Requires one more reducer and receipt type.
- Requires calibration for repair value estimates.
- Delays paper reentry until the proof floor is current.

Decision: select Option C.

## Architecture

Torghut emits a proof-floor receipt for each account, revision, and market window.

```text
profitability_proof_floor_receipt
  receipt_id
  generated_at
  account_label
  torghut_revision
  jangar_settlement_id
  market_window
  floor_state              # blocked, repair_only, shadow_ready, paper_ready, live_micro_ready
  proof_dimensions
  blocking_reasons
  repair_bid_refs
  max_notional
  fresh_until
  rollback_target
```

The proof floor is dimensional, not a single boolean:

```text
proof_dimension
  dimension                # platform, route_readiness, quant_ingestion, market_context, empirical, execution_tca, features
  state                    # pass, degraded, fail, missing, stale
  source_ref
  observed_at
  freshness_s
  threshold_s
  severity
  capital_effect           # observe_only, repair_only, paper_hold, live_hold
```

Evidence repair jobs bid for zero-notional repair budget:

```text
evidence_repair_bid
  bid_id
  created_at
  hypothesis_id
  repair_kind              # quant_ingestion, market_context, tca_replay, feature_rows, drift_checks, route_health
  blocker_reason
  expected_unblock_value
  cost_budget
  validation_gate
  rollback_condition
  priority_score
```

Priority scoring is intentionally plain:

```text
priority_score =
  blocker_severity
  * promotion_value_weight
  * evidence_freshness_decay
  / max(cost_budget, 1)
```

The first implementation can use hand-tuned weights. Later versions can learn weights from repair closure and paper
canary outcomes.

## Measurable Trading Hypotheses

H-PF-01, quant ingestion repair should unlock current metric proof:

- Hypothesis: repairing ingestion lag below `120` seconds during market hours will move quant evidence from degraded to
  pass without increasing paper/live notional.
- Measurement: ingestion lag, materialization lag, latest metric count, receipt floor state, and repair closure time.
- Guardrail: paper/live notional remains zero while ingestion lag exceeds the threshold or the receipt is expired.

H-PF-02, market context refresh should improve event-reversion eligibility:

- Hypothesis: refreshing technicals below `60` seconds, regime below `120` seconds, news below `300` seconds, and
  fundamentals below `86400` seconds will remove `market_context_stale` from H-REV-01 and improve event-reversion
  shadow quality.
- Measurement: domain freshness, quality score, H-REV-01 state, event candidate precision, and next-session paper
  readiness.
- Guardrail: event-reversion remains shadow-only until all required domains are fresh and cited.

H-PF-03, execution settlement replay should retire stale TCA debt:

- Hypothesis: replaying and recalibrating execution/TCA settlement from the latest filled decisions will reduce average
  absolute slippage from the stale `568.6` bps view toward each hypothesis promotion contract before any canary.
- Measurement: latest execution settlement time, TCA sample count, average absolute slippage bps, reject/fill ratio, and
  calibration error.
- Guardrail: live micro is forbidden until TCA settlement is current and slippage is within the hypothesis contract.

H-PF-04, feature and drift repair should unlock microstructure proof:

- Hypothesis: materializing microstructure feature rows and drift checks will move H-MICRO-01 from blocked to shadow
  without consuming capital.
- Measurement: feature batch rows, drift detection checks, H-MICRO-01 reason codes, shadow decision quality, and
  post-cost expectancy proxy.
- Guardrail: H-MICRO-01 remains zero notional until feature coverage and drift governance both pass.

H-PF-05, platform receipt stability should reduce false paper starts:

- Hypothesis: requiring Jangar synthetic readiness settlement before paper will prevent paper starts during memory,
  route, quant, or market-context probe degradation.
- Measurement: settlement decision by action class, denied paper starts, repair starts, and receipt age.
- Guardrail: missing or expired Jangar settlement means `repair_only` at most.

## Implementation Scope

Engineer stage should implement:

- A Torghut proof-floor reducer that consumes existing submission-council, hypothesis, empirical-job, quant, market
  context, route-health, TCA, and Jangar receipt evidence.
- A route that exposes the current proof-floor receipt with compact source refs and reason codes.
- Repair bid generation for quant ingestion, market context, execution/TCA replay, feature rows, drift checks, and route
  readiness.
- Tests that prove fresh empirical jobs cannot override stale TCA, degraded quant ingestion, stale market context, or an
  expired Jangar settlement.
- Tests that prove zero-notional repair remains available while paper/live notional is held.

Deployer stage should implement:

- Rollout gate: do not widen Torghut paper/live-capable revisions unless proof floor is at least `shadow_ready` and
  route readiness is not failing.
- Canary gate: require `paper_ready` for two consecutive receipts before enabling paper canary flags.
- Rollback gate: if proof floor drops from `paper_ready` or `live_micro_ready` to `repair_only` or `blocked`, set notional
  to zero and keep repair jobs running.
- Dashboard: proof-floor state by account, top repair bids, blocker age, and latest execution settlement time.

Out of scope:

- Mutating trading flags from the reducer.
- Treating proof-floor repair as permission to trade.
- Widening RBAC for normal database or pod inspection.

## Validation Gates

Engineer acceptance gates:

- Unit test: live `/readyz=503` causes `route_readiness=fail`, `floor_state=repair_only`, and paper/live notional zero.
- Unit test: empirical jobs fresh plus stale TCA still yields `paper_hold` with reason `execution_tca_stale`.
- Unit test: quant compute fresh plus ingestion lag above threshold yields `quant_ingestion=degraded` and creates a
  quant-ingestion repair bid.
- Unit test: stale market context creates a H-REV-01 repair bid and keeps event-reversion shadow-only.
- Unit test: H-MICRO-01 missing feature rows and drift checks creates feature and drift repair bids but no capital
  admission.
- Integration test: an expired Jangar synthetic readiness receipt downgrades the floor to `repair_only`.

Deployer acceptance gates:

- Read-only route validation can show proof-floor state, source refs, repair bids, and freshness without pod exec.
- Paper canary cannot be enabled unless two consecutive proof-floor receipts are `paper_ready`.
- Rollback from `paper_ready` to `repair_only` keeps repair jobs available and notional at zero.
- Dashboard alerts fire when execution/TCA settlement age exceeds the market-window threshold.

## Rollout Plan

1. Ship the proof-floor reducer in shadow mode and compare it with the existing live submission gate.
2. Emit repair bids without scheduling new work; verify rank ordering against the observed blockers.
3. Enable zero-notional repair scheduling for the top bid in each repair kind.
4. Gate paper canary flags on two consecutive `paper_ready` receipts and a stable Jangar synthetic readiness receipt.
5. Gate live micro on paper settlement, current execution/TCA, live simple-submit enablement, and deployer approval.

## Rollback Plan

- If the proof-floor route is unavailable, Torghut treats the floor as expired and holds capital at zero.
- If repair scoring is wrong, disable bid scheduling while continuing to emit proof-floor state.
- If a proof dimension misclassifies evidence, mark that dimension `degraded_probe_disabled` and keep paper/live held.
- If a Torghut rollout widens incorrectly, revert the revision and require a new proof-floor receipt before reentry.

## Risks And Mitigations

- **Risk: repair ranking optimizes for easy blockers instead of profitable blockers.** Mitigate by including promotion
  value and later learning from canary outcomes.
- **Risk: proof-floor receipt becomes another stale artifact.** Mitigate with short `fresh_until`, source refs, and
  receipt-age dashboards.
- **Risk: fresh empirical jobs are undervalued.** Mitigate by allowing them to increase repair priority while still
  blocking notional when other proof dimensions fail.
- **Risk: route-level 503 hides a healthy internal subsystem.** Mitigate by preserving dimensional evidence; one failed
  route does not erase healthy empirical or compute proof, it limits capital effect.
- **Risk: platform and trading proof are conflated.** Mitigate by requiring both Jangar synthetic readiness settlement
  and Torghut proof-floor receipt for paper/live admission.

## Handoff Contract

Engineer handoff:

- Build the proof-floor reducer using existing Torghut evidence producers first.
- Keep repair bid generation deterministic and explainable before adding learned scoring.
- Add regression tests for each observed blocker from this lane: route health `503`, quant ingestion lag, stale market
  context, stale TCA, missing feature rows, missing drift checks, and expired Jangar receipt.
- Do not mutate trading flags from the reducer.

Deployer handoff:

- Treat `blocked` and `repair_only` as zero-notional states.
- Require two consecutive `paper_ready` receipts before enabling paper canary flags.
- Require live micro approval only after paper settlement and current execution/TCA pass.
- Use the proof-floor receipt id, not pod names, as the audit anchor for rollout and rollback decisions.

Owner handoff:

- The next capital question is not "are the pods ready?" It is "which evidence repair buys the fastest valid path to
  a current, post-cost, guarded canary?"
- Start with quant ingestion, market context, and execution/TCA replay because they block multiple hypotheses and have
  direct profit-floor effects.
- Keep paper/live notional at zero until the proof floor and Jangar settlement agree.
