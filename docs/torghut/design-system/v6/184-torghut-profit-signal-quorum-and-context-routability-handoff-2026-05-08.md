# 184. Torghut Profit-Signal Quorum And Context-Routability Handoff (2026-05-08)

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

I am selecting a **profit-signal quorum with context-routability handoff** as Torghut's next profitability contract.

Torghut has enough proof to stay safe, but not enough proof to spend capital. At `2026-05-08T12:14Z`, live
`/readyz` returned `status=degraded` with Postgres, ClickHouse, database schema, universe, empirical jobs, and broker
connectivity healthy. The schema was current at head `0030_evidence_epochs`. Live submission was still blocked by
`simple_submit_disabled`, the proof floor was `repair_only`, and alpha readiness had three shadow hypotheses with
zero promotion-eligible hypotheses.

The data plane is split. Jangar's unscoped quant health showed `status=ok`, `latestMetricsCount=4284`, and a
three-second pipeline lag. Scoped proof was weaker: recent pipeline health had ingestion `ok=false` in every sampled
row and materialization mostly false, with max ingestion lag reported up to `1728000` seconds in the last-hour DB
window. Market context also split by route: Torghut readiness saw recent context with `news` stale, while Jangar's
market-context route reported `overallState=down` because ClickHouse ingestion was not configured on that path.

The selected design requires a per-hypothesis `profit_signal_quorum` before any paper or live capital proposal. The
quorum must cite fresh scoped quant evidence, pipeline stage evidence, market-context domain evidence, hypothesis
window evidence, route/TCA evidence, promotion-decision evidence, and a current Jangar `stage_clearance_packet`.
Incomplete quorum can fund zero-notional repair work. It cannot widen capital.

The tradeoff is that Torghut remains conservative while global metrics look healthy. I accept that because global
freshness is not profit authority. Profit authority must be local to account, hypothesis, route, and window.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, or GitOps
manifests.

### Runtime Evidence

- Torghut `/readyz` returned `status=degraded`.
- Dependencies reported healthy: Postgres `ok`, ClickHouse `ok`, database schema `schema_current=true`, broker
  `broker_ok`, and universe loaded from eight static symbols.
- Database schema head was `0030_evidence_epochs`, with expected and current head count both `1`.
- Empirical jobs were healthy, but live submission was blocked by `simple_submit_disabled`.
- The profitability proof floor returned `repair_only`, `capital_state=zero_notional`, and required proof.
- Alpha readiness reported `hypotheses_total=3`, all in `shadow`, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.

### Quant And Context Evidence

- Jangar unscoped quant health returned `ok=true`, `status=ok`, `latestMetricsCount=4284`,
  `latestMetricsUpdatedAt=2026-05-08T12:14:03.913Z`, and `metricsPipelineLagSeconds=3`.
- Recent Jangar DB quant rows reported `4284` latest metrics across `13` strategies and `2` accounts, newest
  `updated_at=2026-05-08T12:17:31.114Z`.
- Recent pipeline stage rows showed compute mostly healthy, ingestion all degraded, and materialization mixed:
  ingestion `ok=false` had `179` rows in the one-hour window; materialization `ok=false` had `164` rows and
  materialization `ok=true` had `15` rows.
- Torghut readiness reported scoped quant evidence as informationally degraded with stage lag in ingestion and
  materialization.
- Jangar market-context health returned `overallState=down`; technicals and regime errored, fundamentals and news
  were missing, and ClickHouse ingestion reported `CH_HOST is not configured`.
- Torghut market-context reference still carried recent bundles, but news was stale and risk flags included
  `news_stale`.

### Profit Evidence

- Hypothesis `H-MICRO-01` had a candidate and dataset lineage, but its metric window was stale and no promotion
  decision existed.
- Hypotheses `H-CONT-01` and `H-REV-01` lacked strategy-hypothesis lineage.
- The generated profit lease projection kept all three leases in `repair_only` with `proof_state=missing`.
- Blocking reasons included `equity_ta_rows_missing`, `hypothesis_not_promotion_eligible`,
  `quant_pipeline_degraded`, `rejection_drag_unmeasured`, `research_candidates_empty`, `research_promotions_empty`,
  and `vnext_promotion_decisions_empty`.
- Market context blocked the event-reversion lane through `market_context_domain_news_stale`.

## Problem

Torghut currently has safe operation without capital authority. The system can say "do not trade", but it cannot yet
rank the exact profit proof that would earn the next paper action.

The failure modes are:

1. Unscoped quant health can look green while scoped ingestion and materialization are degraded.
2. Market-context availability depends on which route is used.
3. Hypothesis lineage is partial: one hypothesis has lineage, two do not.
4. Promotion-decision tables and vNext promotion decisions do not provide current authority.
5. Route/TCA and rejection drag are not bound into one capital decision.
6. Jangar stage staleness and endpoint routability are not yet cited by Torghut profit receipts.

Torghut needs a quorum that converts those facts into explicit repair, paper, and live decisions.

## Alternatives Considered

### Option A: Trust Global Quant Health For Paper Repair

Treat Jangar's unscoped quant health as sufficient to allow paper repair and route probes.

Advantages:

- Uses an existing green surface.
- Fast to implement.
- Keeps dashboards simple.

Disadvantages:

- Ignores scoped ingestion and materialization degradation.
- Allows account/window drift to hide under global counts.
- Does not solve market-context route split.

Decision: reject. Global quant freshness is evidence, not quorum.

### Option B: Block All Torghut Work Until Every Signal Is Green

Hold observe, repair, paper, and live work until quant, context, hypotheses, promotions, route/TCA, and Jangar stage
clearance are all current.

Advantages:

- Strong safety posture.
- Easy to rollback.
- Avoids ambiguous partial receipts.

Disadvantages:

- Prevents zero-notional repair work needed to make the signals green.
- Keeps no-profit and no-repair states indistinguishable.
- Raises manual intervention because operators must decide what to repair first.

Decision: keep for live capital, reject for repair.

### Option C: Profit-Signal Quorum With Context-Routability Handoff

Create a per-hypothesis quorum that admits zero-notional repair with partial evidence, paper proposals only with full
scoped quorum, and live proposals only after a separate capital gate.

Advantages:

- Makes capital authority local to account, hypothesis, route, and window.
- Keeps repair work moving under zero notional.
- Converts missing evidence into a ranked repair queue.
- Lets Torghut cite Jangar's stage-clearance packet before proposing capital work.

Disadvantages:

- Adds a receipt object and tests.
- Requires clear freshness thresholds by signal type.
- May hold paper work while unscoped health looks green.

Decision: select Option C.

## Architecture

Torghut adds a `profit_signal_quorum` receipt beside consumer evidence and proof-floor output:

```text
profit_signal_quorum
  schema_version
  quorum_id
  generated_at
  fresh_until
  account
  hypothesis_id
  candidate_id
  strategy_id
  window
  jangar_stage_clearance_packet_id
  quant_signal
  pipeline_signal
  market_context_signal
  hypothesis_lineage_signal
  promotion_signal
  route_tca_signal
  rejection_drag_signal
  decision
  reason_codes[]
  required_repair_action
  max_notional
```

Decision rules:

- `observe_only`: no capital and no repair launch when route or Jangar packet is missing.
- `repair_only`: zero-notional repair may run when at least one required signal is missing or stale and Jangar admits
  repair.
- `paper_candidate`: all scoped signals are fresh for the hypothesis, but paper submission remains gated by explicit
  trading flags.
- `paper_canary`: paper flags are enabled, route/TCA is under guardrail, and the Jangar packet allows paper.
- `live_blocked`: any live proposal without full quorum, signed capital gate, and manual release remains blocked.

## Implementation Scope

Engineer milestone 1:

- Add a pure `profit_signal_quorum` builder in Torghut that consumes existing readiness, quant, market-context,
  hypothesis, promotion, proof-floor, and route/TCA objects.
- Add tests for global green but scoped degraded, context route down, missing lineage, stale metric window, missing
  promotion decision, and Jangar packet hold.
- Expose the quorum in `/readyz` and `/trading/status` without widening capital.

Engineer milestone 2:

- Teach Jangar's Torghut consumer path to read the quorum and map it into material action verdicts.
- Require a current `stage_clearance_packet` for `paper_canary`, `live_micro_canary`, and `live_scale`.

Deployer milestone:

- Validate live and sim `/readyz`, Jangar quant health, market-context health, and the quorum receipt after rollout.
- Keep live capital at zero until the quorum and independent capital gate both allow.

## Validation Gates

- `failed_agentrun_rate`: zero-notional repair launches must cite a Jangar packet and must not create repeated failed
  AgentRuns from unroutable status endpoints.
- `pr_to_rollout_latency`: Torghut rollout cannot be marked capital-ready until the quorum appears in service health.
- `ready_status_truth`: live `/readyz=degraded` remains truthful while quorum is incomplete.
- `manual_intervention_count`: the quorum must name one required repair action per blocked hypothesis.
- `handoff_evidence_quality`: every Torghut capital handoff must cite account, hypothesis, window, route, quant,
  context, promotion, Jangar packet, decision, and rollback target.

## Rollout

1. Ship the quorum receipt in shadow mode with no capital behavior change.
2. Compare quorum decisions against existing proof-floor and consumer-evidence receipts.
3. Enable repair-only launch admission for missing or stale signals.
4. Enable paper-candidate reporting after all scoped signals are fresh for one market session.
5. Keep live capital blocked until a separate signed capital release is implemented and verified.

## Rollback

- Hide the quorum receipt and keep existing proof-floor behavior.
- Treat all missing Jangar packets as capital block.
- Set Torghut to observe-only if context route state or scoped quant state oscillates.
- Keep `simple_submit_disabled` and zero-notional proof floor as the hard capital stop.

## Risks

- Scoped thresholds may be too strict. Mitigation: shadow-mode comparison before enforcement.
- Context route split may persist. Mitigation: quorum names the exact route and provider state.
- Quorum output may duplicate proof-floor logic. Mitigation: keep proof floor as capital authority and quorum as
  proof-repair admission.
- Jangar packet outages may hold useful repair. Mitigation: allow manual observe-only diagnostics, not capital.

## Handoff

Engineer acceptance:

- A production PR implements the quorum builder with regression tests and cites this document before changing code.
- The quorum is visible in Torghut health/status without widening paper or live capital.
- Jangar consumes the quorum only after the companion stage-clearance packet exists.

Deployer acceptance:

- After rollout, prove Torghut `/readyz`, `/trading/status`, Jangar quant health, market-context health, and the
  quorum receipt.
- If the quorum is incomplete, publish the required repair action and keep capital at zero.
