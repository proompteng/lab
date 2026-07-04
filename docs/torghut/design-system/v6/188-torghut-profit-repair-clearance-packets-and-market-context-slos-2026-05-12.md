# 188. Torghut Profit-Repair Clearance Packets And Market-Context SLOs (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut profitability, zero-notional repair admission, market-context freshness, route/TCA repair value,
Jangar stage-clearance integration, validation, rollout, rollback, and handoff gates.

Companion Jangar contract:

- `docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md`

Extends:

- `187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`
- `186-torghut-routeability-acceptance-cutover-and-fill-quality-loop-2026-05-08.md`
- `185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`
- `184-torghut-profit-signal-quorum-and-context-routability-handoff-2026-05-08.md`

## Decision

I am selecting **profit-repair clearance packets with market-context SLOs** as Torghut's next profitability
architecture step.

Torghut should not widen capital. The live state says so clearly: `/readyz` is degraded, live submission is disabled,
promotion eligibility is zero, current consumer evidence is repair-only, and Jangar action custody holds paper and live
classes. The opportunity is to make repair work profitable by ranking it against the value gates it can clear and by
requiring Jangar stage-clearance packets before the work is launched.

The selected design makes Torghut emit a `profit_repair_clearance_packet` for each proposed zero-notional repair. The
packet names the hypothesis, account/window, repair class, stale or missing proof, expected unblock value, freshness
SLO, route/TCA requirement, and Jangar packet ref required to launch it. Jangar may launch the repair only as
`repair_only`; Torghut may not translate the repair packet into paper or live notional until a later capital packet is
funded and all blockers are retired.

The tradeoff is that some existing repair jobs will be held until they can name a measurable value gate. That is the
right tradeoff. A repair run that cannot say which proof it retires is not a profitability improvement; it is just more
activity inside a zero-notional system.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags,
GitOps resources, or AgentRun objects.

### Cluster And Runtime

- Argo CD reported `torghut` as `Synced/Degraded` and `torghut-options` as `Synced/Progressing`.
- `torghut-00320-deployment` and `torghut-sim-00418-deployment` were running.
- ClickHouse, Keeper, Torghut DB, options catalog, options enricher, and `torghut-ta` were running.
- Recent events showed `torghut-ta-sim` hitting an image digest not found, then reconciling to a digest present on the
  node. Startup probes and Flink `Job Not Found` warnings continued during reconciliation.
- `http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `status=degraded`.
- `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`, and blocked reasons included
  `hypothesis_not_promotion_eligible`, `empirical_jobs_not_ready`, and `simple_submit_disabled`.
- The active capital stage was `shadow`; live promotion was not configured, and promotion-eligible total was `0`.

### Profit And Data Evidence

- Jangar consumed a current Torghut consumer-evidence receipt at `2026-05-12T16:44:10.650021Z`.
- The receipt decision was `repair`, `max_notional=0`, `route_repair_value=14`, and serving revision `torghut-00320`.
- Receipt reason codes were `empirical_jobs_degraded`, `forecast_registry_degraded`, `simple_submit_disabled`,
  `hypothesis_not_promotion_eligible`, `degraded`, and `market_context_stale`.
- Quant evidence for `PA3SX7FYNUTF/15m` had `180` latest metrics and a recent update, but status was degraded with
  `quant_metrics_update_missing` and `quant_pipeline_stages_missing`.
- The live readiness payload evaluated three hypotheses:
  - `H-CONT-01` lacked window evidence and strategy hypothesis lineage.
  - `H-MICRO-01` had candidate `chip-paper-microbar-composite@execution-proof`, but evidence was stale and `ta-core`
    was blocked.
  - `H-REV-01` lacked window evidence and was blocked by empirical, market-context, and `ta-core` segments.
- The profit-window contract kept decisions at `quarantined` or `underfunded`, not funded.
- Market context was mixed: the sampled readiness payload showed recent checks but stale domain states for
  fundamentals and news in one sample, with technicals/regime ok; earlier status also reported market context stale.

### Database

- Local `psql` was unavailable, and pod exec was forbidden, so database checks used the Torghut app database secret
  from Kubernetes and a Bun Postgres client inside `BEGIN READ ONLY`; no secret values were printed.
- Torghut Postgres schema was `public`.
- `trade_decisions` had `147666` rows; newest decision `created_at=2026-05-08T17:29:45.284Z`, while newest
  `executed_at` remained `2026-04-02T20:59:45.140Z`.
- Trade decision statuses were dominated by `rejected` (`69909`) and `blocked` (`63612`) rows; `filled` rows were
  historical (`13555`, newest created `2026-04-02T19:29:13.609Z`).
- `execution_tca_metrics` had `13775` rows, but its latest created timestamp was historical relative to current
  trading repairs.
- `research_candidates` and `research_promotions` were empty. `strategy_promotion_decisions` had one row.
- Options tables were active: stats estimated `7755` `torghut_options_subscription_state` rows and `6936`
  `torghut_options_watermarks` rows, with recent auto-analyze on the subscription state table.

### Source

- `services/torghut/app/trading/consumer_evidence.py` already builds route-proven consumer evidence and reason codes.
- `services/torghut/app/trading/profit_signal_quorum.py` and `profit_repair_settlement.py` already classify proof and
  repair states.
- `services/torghut/app/main.py` already owns many readiness routes and should not absorb the next scoring reducer.
- Existing tests cover consumer evidence, profit signal quorum, profit repair settlement, proof-floor behavior, and
  trading readiness. The missing invariant is cross-plane: a current consumer-evidence receipt plus Jangar observe
  allowance must not create a repair launch unless the repair packet names value, SLO, and rollback.

## Problem

Torghut has the right capital posture but not yet the right repair admission shape.

The platform can say `repair_only` and can list many blockers. That is not enough. A zero-notional trading system must
spend repair capacity where it improves the probability of a profitable future session. Otherwise, market-context jobs,
empirical jobs, route/TCA repairs, and promotion-table repairs all compete as undifferentiated work while Jangar tries
to reduce failed AgentRuns.

The current failure modes are:

1. A current consumer-evidence receipt can look stronger than it is. It proves route-readable evidence, not paper
   readiness.
2. Fresh latest metrics can hide missing pipeline stages and stale market context.
3. Empty research and promotion tables block capital but are not priced against route repair value.
4. Market-context refreshes can fail repeatedly without a declared freshness SLO or expected unblock value.
5. Jangar can launch Torghut repair under a frozen control-plane stage unless the repair is tied to a stage-clearance
   packet.

## Alternatives Considered

### Option A: Let Current Repair Jobs Continue And Use `/readyz` As The Gate

Keep emitting readiness blockers and allow existing market-context, empirical, and route repairs to run as scheduled.

Advantages:

- No new payload.
- Existing jobs and tests continue without migration.
- Readiness remains the primary operator surface.

Disadvantages:

- Does not price repair work.
- Does not tell Jangar which repair should spend launch capacity.
- Does not reduce failed AgentRuns from repeated stale or unbounded repair attempts.

Decision: reject as the architecture. Readiness is a state report, not a repair market.

### Option B: Hold All Repairs Until Torghut `/readyz` Is Healthy

Stop zero-notional repair work until readiness is green.

Advantages:

- Capital-safe and simple.
- Prevents noisy repairs during image or market-context incidents.

Disadvantages:

- Blocks the work needed to make readiness green.
- Increases manual intervention.
- Loses current route-repair value and market-context signals.

Decision: keep as an incident fallback only.

### Option C: Emit Profit-Repair Clearance Packets With SLOs And Jangar Refs

Each repair proposal becomes a versioned packet. The packet must name the proof debt, expected value-gate movement,
freshness SLO, max attempts, rollback condition, and required Jangar stage-clearance ref.

Advantages:

- Keeps paper/live notional at zero while making repair work economically comparable.
- Lets Jangar launch bounded repairs without accepting normal dispatch.
- Turns market-context freshness into a measurable SLO rather than a vague readiness note.
- Makes empty promotion tables and stale TCA explicit repair classes.
- Gives engineer and deployer stages testable handoff gates.

Disadvantages:

- Adds a payload and reducer to Torghut.
- Requires stable reason codes and value scoring.
- Will hold some existing jobs until they can produce a packet.

Decision: select Option C.

## Architecture

Torghut publishes `profit_repair_clearance_packets` through `/readyz`, `/trading/status`, and
`/trading/consumer-evidence`.

```text
profit_repair_clearance_packet
  schema_version
  packet_id
  generated_at
  fresh_until
  account
  window
  hypothesis_id
  candidate_id
  repair_class                  # market_context | empirical_job | route_tca | promotion_table | quant_pipeline
  decision                      # repair_only | hold | block
  expected_unblock_value
  value_gate_refs[]             # failed_agentrun_rate | pr_to_rollout_latency | ready_status_truth | ...
  market_context_slo_seconds
  current_freshness_seconds
  route_repair_value
  max_attempts
  max_notional
  jangar_stage_clearance_ref
  consumer_evidence_ref
  rollback_condition
  reason_codes[]
```

Repair classes:

- `market_context`: allowed only when the packet names the stale domain, freshness SLO, max attempts, and the symbols
  expected to unblock.
- `empirical_job`: allowed when the stale job refs and dataset snapshot refs are named and the retry budget is bounded.
- `route_tca`: allowed when the route/TCA symbol gap is named and the repair can improve routeable candidate count.
- `promotion_table`: allowed when empty or stale research/promotion rows are the blocker and the repair produces a
  candidate or explicit no-edge receipt.
- `quant_pipeline`: allowed when latest metrics exist but pipeline stages are missing or stale.

Capital rules:

- `max_notional` remains `0` for every repair packet.
- A repair packet can never promote paper or live by itself.
- Paper requires a separate funded profit-window custody packet, current market context, current route/TCA evidence,
  non-empty hypothesis and promotion lineage, and a Jangar packet that allows `paper_canary`.
- Live requires a later live-capital packet and remains outside this design.

## Measurable Hypotheses

H1: Market-context SLO repair.

- If fundamentals and news freshness are brought under `300` seconds for the active account/window symbols, Torghut
  should reduce `market_context_stale` reason-code presence for evaluated hypotheses by at least `50%` in one market
  session.
- Guardrail: no paper/live notional; max two repair attempts per symbol per hour.

H2: Route/TCA repair value.

- If route/TCA gaps tied to the `route_repair_value=14` receipt are repaired, `routeable_candidate_count` should move
  from `0` to at least `1` for a shadow-only candidate, or the packet must emit a no-edge receipt explaining why the
  repair no longer pays.
- Guardrail: packet must include current consumer-evidence ref and Jangar stage-clearance ref.

H3: Promotion-table lineage repair.

- If research and promotion tables are empty for active hypotheses, a promotion-table repair must produce either one
  promotion-eligible candidate receipt or a typed no-edge receipt within the packet TTL.
- Guardrail: a generated candidate cannot bypass `profit_signal_quorum` or Jangar action custody.

## Implementation Scope

Milestone 1: Packet builder.

- Add a pure Torghut reducer that builds `profit_repair_clearance_packets` from consumer evidence, profit repair
  settlement, profit signal quorum, market-context state, route/TCA state, and promotion-table counts.
- Add tests for stale market context, missing promotion lineage, current observe receipt, and zero-notional repair.
- Value gates: `ready_status_truth`, `handoff_evidence_quality`.

Milestone 2: API projection.

- Include packets in `/readyz`, `/trading/status`, and `/trading/consumer-evidence`.
- Keep existing readiness fields stable.
- Value gates: `ready_status_truth`, `manual_intervention_count`.

Milestone 3: Jangar integration.

- Jangar consumes packet refs in stage-clearance packets and permits only bounded `repair_only` launches.
- Torghut repairs launched without a Jangar packet ref cannot count as rollout or profitability evidence.
- Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `handoff_evidence_quality`.

Milestone 4: Profitability review loop.

- Track before/after reason-code retirement per packet.
- Promote only packets that increased routeable candidates, reduced stale evidence, or produced explicit no-edge
  receipts.
- Value gates: `manual_intervention_count`, `handoff_evidence_quality`.

## Validation Gates

Engineer acceptance gates:

- A stale market-context sample returns a `market_context` packet with `repair_only`, `max_notional=0`, SLO fields, and
  reason codes.
- Empty `research_candidates` and `research_promotions` return a `promotion_table` repair packet, not paper readiness.
- A current consumer-evidence receipt with `decision=repair` does not produce a funded packet.
- Packets include the required Jangar stage-clearance ref once Jangar publishes it; before that integration, packets
  declare the ref as missing and stay `hold` for scheduler launch.

Deployer acceptance gates:

- `/readyz` stays capital-safe: live submission remains disabled while repair packets exist.
- `/trading/consumer-evidence` includes current packet refs and keeps `max_notional=0` until funded profit-window
  custody is present.
- Jangar status shows the Torghut packet ref before any Torghut repair AgentRun is counted as accepted evidence.
- A rollout report names the packet IDs, retired reason codes, and whether each packet increased value-gate movement.

## Rollout

Phase 1: Shadow packet emission.

- Emit packets in API payloads.
- Do not change scheduler behavior.
- Record packet counts by repair class and decision.

Phase 2: Jangar shadow consumption.

- Jangar includes packet refs in stage-clearance status.
- Repairs can still run, but missing refs are warnings.

Phase 3: Repair launch enforcement.

- Jangar allows only `repair_only` Torghut launches with current packet refs, bounded attempts, and zero notional.
- Missing or stale packet refs hold the launch.

Phase 4: Profitability review.

- Torghut compares pre/post reason-code state and routeable candidate count.
- Packets that do not improve value gates are repriced or disabled.

## Rollback

- Disable packet enforcement by keeping Torghut packet emission in shadow and setting Jangar to stage-clearance shadow
  mode.
- If market-context SLO scoring misclassifies fresh evidence, hold only `market_context` repairs and leave other
  repair classes shadowed.
- If packet refs are missing because Jangar is unavailable, Torghut remains zero-notional and does not promote paper.
- If repair attempts cause repeated AgentRun failures, reduce the packet max-attempt budget to zero for that repair
  class until a new packet is published.

## Risks And Mitigations

- Risk: expected unblock value becomes subjective. Mitigation: each packet must name the value gate and the measurable
  before/after signal.
- Risk: repair packets become another large readiness blob. Mitigation: keep detailed evidence in refs and expose a
  concise packet summary by class and decision.
- Risk: market-context SLOs overfit to one session. Mitigation: start with shadow scoring and require one full session
  of before/after packet evidence before enforcement.
- Risk: Jangar and Torghut reason codes drift. Mitigation: packet tests assert stable cross-plane reason codes for
  market-context stale, empirical jobs degraded, promotion lineage missing, route/TCA missing, and zero-notional hold.

## Handoff

Engineer next milestone:

- Implement the packet builder and API projection without adding scoring logic to `services/torghut/app/main.py`.
- Add focused tests for the reducer and API shape.
- Keep all packet decisions zero-notional until Jangar stage-clearance integration exists.

Deployer next milestone:

- After rollout, capture `/readyz`, `/trading/consumer-evidence`, Jangar status, Argo health, and workload readiness.
- Confirm every accepted Torghut repair launch cites a current Jangar stage-clearance packet and a Torghut
  profit-repair clearance packet.
- Confirm no paper/live notional is enabled by this change.

The profitability metric this design improves first is not PnL. It is `routeable_candidate_count` and
`zero_notional_or_stale_evidence_rate`, which are prerequisites for any defensible `post_cost_daily_net_pnl` claim.
