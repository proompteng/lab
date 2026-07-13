# 189. Torghut Repair Yield Market And Profit Hypothesis Guardrails (2026-05-12)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

I am selecting a **repair yield market with profit hypothesis guardrails** for the next Torghut architecture increment.

Torghut is running, but the profitable-action surface is not routeable. The current consumer evidence is fresh and
honest: it says zero paper notional, zero live notional, no accepted routeable candidate, seven active repair lots, and
only two of nine freshness dimensions current. That is the right safety posture. The missing architecture is a compact
market packet Jangar can consume without parsing the full trading proof tree.

The selected design turns Torghut's repair lots into measurable, zero-notional hypotheses. Each lot must name the
profit unlock it claims, the evidence clock it repairs, the validation window, and the guardrails that keep paper and
live capital closed. Jangar's clearance market consumes the ranked output and launches only the smallest safe repair.

The tradeoff is that Torghut remains slower to live capital. I accept that. The current blocker is not lack of live
submission courage; it is stale empirical proof, stale signal ingestion, stale TCA, missing feature/drift evidence, and
empty research/promotion inventory. Profitability improves first by repairing evidence quality and routeability, not by
forcing capital through a degraded gate.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, databases,
trading flags, broker state, or AgentRuns.

### Runtime Evidence

- Argo reported `torghut=OutOfSync/Degraded` and `torghut-options=Synced/Degraded` at revision
  `62a8f5f6d634da0478bc5d23aa0b0e6dca10bb2e`.
- Torghut live pods were running, including `torghut-00324`, ClickHouse, ClickHouse Keeper, Torghut DB, TA, options,
  and websocket surfaces. The app being runnable does not mean capital is routeable.
- `/trading/status` reported `enabled=true`, `mode=live`, `pipeline_mode=simple`, `running=true`,
  `autonomy_enabled=false`, and active revision `torghut-00324`.
- The hypothesis registry loaded three hypotheses. Two were `shadow`, one was `blocked`, all had capital multiplier
  `0`, and promotion eligible total was `0`.
- `/trading/consumer-evidence` reported a current receipt and selected repair
  `refresh_stale_market_context_domains`. It also reported zero paper/live notional, `paper_replay_candidate_count=0`,
  `accepted_routeable_candidate_count=0`, and a graduation rule requiring current freshness dimensions, accepted
  routeability, live gate allowance, and existing capital gates.
- Market context was degraded: `technicals` stale at about 5,599 seconds versus a 60-second max, `regime` stale at
  about 5,599 seconds versus a 120-second max, while news and fundamentals were fresher.
- Quant evidence was degraded. Compute was fresh, but ingestion stages were stale with lags up to 971,150 seconds in
  the route payload and up to 1,728,000 seconds in recent Jangar DB pipeline rows.

### Database Evidence

- Torghut Postgres connected read-only as database `torghut` on PostgreSQL 17.0 and exposed 73 sampled non-system
  tables.
- `vnext_empirical_job_runs` had 28 completed, promotion-authority-eligible rows across benchmark parity, foundation
  router parity, Janus event CAR, and Janus HGRM reward. The latest row was `2026-05-08T21:54:41Z`, stale under the
  current consumer-evidence policy.
- `strategy_hypothesis_metric_windows` had three rows, all shadow and empirically validated, latest
  `2026-05-06T22:34:19Z`.
- `strategy_promotion_decisions` had one row and it was `allowed=false`.
- `research_candidates` and `research_promotions` were empty. There is no current research inventory to promote.
- `execution_tca_metrics` had 13,775 rows for account `PA3SX7FYNUTF`, latest computed
  `2026-05-08T02:42:07Z`, average absolute slippage about 13.76 bps.
- `executions` were older than the current proof window, with latest order update `2026-04-03T05:32:38Z`.
- `evidence_receipts` was empty, which means the next profitability contract should make repair output receipts first
  class instead of relying only on derived status JSON.
- `trade_cursor` had a ClickHouse cursor at `2026-05-12T18:48:40Z`, proving some upstream market data was available
  while execution/TCA and empirical proof clocks remained stale.

### Source Evidence

- `services/torghut/app/trading/profit_freshness_frontier.py` already ranks repair lots and exposes
  zero-notional repair posture.
- `services/torghut/app/trading/consumer_evidence.py` exports the current safety summary Jangar consumes.
- `services/torghut/app/trading/evidence_clock_arbiter.py`, `routeability_repair_acceptance.py`, `proof_floor.py`,
  `tca.py`, `market_context.py`, and `empirical_jobs.py` are the right source modules for repair inputs.
- `services/torghut/config/trading/profitability-frontier-*.yaml` shows there are many candidate strategy families,
  but current database evidence does not contain a routeable research/promotion inventory.
- The test surface is broad at 171 files under `services/torghut/tests`, but the missing contract is a single ranked
  repair-yield packet that Jangar can enforce without reading every Torghut detail.

## Problem

Torghut's safety gates are doing their job, but the recovery loop is not explicit enough for Jangar dispatch. The
system knows many things are stale, but it does not yet provide a compact answer to these questions:

1. Which repair should run first?
2. Which value gate does it improve?
3. What is the expected profit unlock and confidence basis?
4. What receipt proves it worked?
5. Which capital gates remain closed during and after repair?
6. When should Jangar stop launching similar repair work because the marginal value is exhausted?

Without that packet, Jangar either launches generic market-context jobs that can pile up failures, or it blocks too
much and waits for a human to infer the smallest repair.

## Alternatives Considered

### Option A: Rerun Every Stale Empirical And Market-Context Job

Launch all stale jobs and let the existing consumer evidence improve as outputs arrive.

Advantages:

- Simple.
- Likely clears some stale proof quickly.
- Uses existing job paths.

Disadvantages:

- It ignores capacity and scheduling pressure already visible in AgentRun events.
- It does not prioritize the repair with the highest routeability or profit unlock.
- It can increase failed AgentRuns and manual intervention if provider capacity or cluster capacity is constrained.

Decision: reject as default; keep as a manual emergency backfill.

### Option B: Trust Current Consumer Evidence And Move To Paper Canary

The current consumer evidence is fresh, so Torghut could let a paper canary run and gather new proof.

Advantages:

- Faster path to new data.
- Exercises the full trading loop.
- May reveal hidden execution issues earlier.

Disadvantages:

- Current evidence explicitly says zero notional and no routeable candidate.
- TCA and execution proof are stale.
- Research and promotion tables are empty.
- It would weaken the capital safety story without improving routeability first.

Decision: reject until repair output receipts clear the necessary gates.

### Option C: Repair Yield Market With Profit Hypothesis Guardrails

Emit a ranked repair market. Each repair is a zero-notional hypothesis with measurable acceptance and explicit capital
holds. Jangar consumes only the ranked packet.

Advantages:

- Allows recovery without bypassing capital gates.
- Converts stale proof into measurable repair hypotheses.
- Gives Jangar a small dispatch contract instead of a large trading payload.
- Directly maps to routeable candidate count, stale evidence rate, TCA quality, and capital gate safety.

Disadvantages:

- Requires a new output receipt or compact route.
- Requires score discipline so expected profit unlock is evidence-backed.
- Can become stale if not tied to fresh data clocks.

Decision: select Option C.

## Architecture

Torghut emits a `repair_yield_market` packet.

```text
repair_yield_market
  schema_version = torghut.repair-yield-market.v1
  market_id
  generated_at
  fresh_until
  account
  proof_window
  active_revision
  capital_posture
  routeable_candidate_count
  stale_evidence_rate
  repair_hypotheses[]
  selected_repair_ids[]
  guardrails
  jangal_clearance_consumer_ref
```

Each `repair_hypothesis` is a zero-notional work contract:

```text
repair_hypothesis
  repair_id
  repair_dimension
  hypothesis_id
  candidate_id
  affected_symbols[]
  blocker_evidence_refs[]
  expected_profit_unlock_bps
  expected_daily_net_pnl_unlock
  confidence_basis
  evidence_cost_class
  capacity_cost_class
  selected
  max_parallelism
  max_runtime_seconds
  paper_notional_limit = 0
  live_notional_limit = 0
  required_output_receipts[]
  success_criteria
  rollback_trigger
```

The initial repair dimensions are:

- `market_context_freshness`
- `empirical_proof_freshness`
- `quant_ingestion_freshness`
- `feature_coverage`
- `drift_checks`
- `tca_fill_quality`
- `routeability_acceptance`
- `forecast_registry`
- `promotion_inventory`

## Measurable Hypotheses

### H1: Market-Context Freshness Repair

Current blocker: technicals and regime are stale while Torghut selected `refresh_stale_market_context_domains`.

Acceptance:

- technicals freshness below 60 seconds for active symbols;
- regime freshness below 120 seconds for active symbols;
- market-context quality score at least 0.70 or explicit degraded-last-good reason;
- no paper or live notional;
- Jangar `dispatch_repair` allowed for this lot and `dispatch_normal` still held until routeability settles.

Value gates:

- `zero_notional_or_stale_evidence_rate`
- `routeable_candidate_count`
- `manual_intervention_count`

### H2: Empirical Proof Renewal

Current blocker: four empirical job families are completed and promotion-authority eligible but stale since
`2026-05-08T21:54:41Z`.

Acceptance:

- benchmark parity, foundation router parity, Janus event CAR, and Janus HGRM reward rerun for the active candidate;
- outputs are truthful, promotion-authority eligible, and newer than the active freshness policy;
- no live promotion occurs unless TCA and routeability gates also pass.

Value gates:

- `routeable_candidate_count`
- `handoff_evidence_quality`
- `capital_gate_safety`

### H3: Quant Ingestion Clock Repair

Current blocker: compute is fresh, but ingestion rows are stale for scoped account/window evidence.

Acceptance:

- max ingestion lag for `PA3SX7FYNUTF` and `15m` falls below 120 seconds during market session or is explicitly
  marked expected closed-session staleness;
- materialization is current for every active strategy;
- Jangar status stops treating compute freshness as sufficient for normal dispatch.

Value gates:

- `ready_status_truth`
- `zero_notional_or_stale_evidence_rate`
- `failed_agentrun_rate`

### H4: TCA And Execution Proof Renewal

Current blocker: latest TCA is `2026-05-08`, latest execution update is `2026-04-03`, and expected-shortfall coverage
is absent in current status.

Acceptance:

- route TCA rows are recomputed for the active symbol set;
- expected shortfall coverage is non-zero or explicitly waived by a no-fill closed-session receipt;
- average absolute slippage is below the hypothesis budget before paper canary unlocks;
- capital remains zero-notional until routeability acceptance is settled.

Value gates:

- `fill_tca_or_slippage_quality`
- `capital_gate_safety`
- `routeable_candidate_count`

### H5: Research And Promotion Inventory Rehydration

Current blocker: `research_candidates`, `research_promotions`, and current promotion decisions are empty or disallowed.

Acceptance:

- at least one candidate has a current research record, promotion evidence bundle, and rollback candidate;
- the candidate maps to a configured hypothesis and dataset snapshot;
- promotion remains paper-only until empirical, TCA, and market-context gates are current.

Value gates:

- `routeable_candidate_count`
- `handoff_evidence_quality`
- `capital_gate_safety`

## Guardrails

- `paper_notional_limit` and `live_notional_limit` remain `0` for every repair hypothesis.
- `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION` must remain false until the live submission gate explicitly allows.
- `simple_submit_disabled` is not cleared by a repair market alone.
- Every repair must emit an output receipt with `observed_at`, `fresh_until`, `reason_codes`, and source evidence refs.
- Jangar may launch only selected repairs and must honor max parallelism.
- If market data providers are degraded, repair output must be marked degraded-last-good and cannot unlock paper/live
  capital.
- If TCA proof is stale, paper canary stays held even if market context and empirical proof are current.

## Implementation Scope

### Milestone 1: Compact Repair Market Route

Add a compact route or payload section that projects `repair_yield_market` from existing profit freshness, consumer
evidence, routeability, TCA, empirical job, and hypothesis data.

Acceptance:

- tests cover selected market-context repair, empirical stale jobs, stale quant ingestion, stale TCA, and empty
  research inventory;
- payload stays compact enough for Jangar to consume directly;
- all repair hypotheses contain notional limits and output receipt requirements.

### Milestone 2: Output Receipts

Persist or expose repair output receipts for completed zero-notional repairs.

Acceptance:

- receipts include `observed_at`, `fresh_until`, `state`, `decision`, and source refs;
- stale receipts do not unlock routeable candidates;
- Jangar can cite receipt ids in the clearance market ledger.

### Milestone 3: Jangar Dispatch Consumption

Let Jangar dispatch one selected repair per dimension when its clearance market allows `dispatch_repair`.

Acceptance:

- failed repair jobs count against the same value gate they were meant to improve;
- successful repair receipts expire the matching failure/staleness debt;
- normal dispatch and deploy widening remain held until all required receipts settle.

## Rollout Plan

1. Ship the repair market in observe mode under a feature flag.
2. Compare ranked repairs against the current full consumer-evidence JSON for two market sessions.
3. Allow Jangar to consume selected zero-notional repairs with max parallelism 1.
4. Add output receipt persistence once the selected repair path is stable.
5. Consider paper canary only after routeable candidate count is positive and capital guardrails pass.

## Rollback Plan

- Disable the new route or payload with `TORGHUT_REPAIR_YIELD_MARKET_ENABLED=false`.
- Keep existing `/trading/consumer-evidence` behavior unchanged.
- Keep paper/live notional at zero if the repair market is unavailable or stale.
- If repair scoring is wrong, fall back to existing profit freshness frontier ordering.

## Risks

- Expected profit unlock can become fictional if not tied to receipts. Mitigation: every score must cite current data
  and output receipt requirements.
- Provider capacity can turn repair dispatch into more failed AgentRuns. Mitigation: Jangar consumes max parallelism,
  cooldown, and failed-run debt before launching.
- Closed-session staleness can look like failure. Mitigation: repair hypotheses must distinguish actionable staleness
  from expected market-closed staleness.
- Compact routes can hide nuance. Mitigation: each repair includes evidence refs back to the full Torghut proof tree.

## Engineer Handoff

Objective: implement a compact, zero-notional repair-yield packet and tests.

Files to inspect first:

- `services/torghut/app/trading/profit_freshness_frontier.py`
- `services/torghut/app/trading/consumer_evidence.py`
- `services/torghut/app/trading/evidence_clock_arbiter.py`
- `services/torghut/app/trading/routeability_repair_acceptance.py`
- `services/torghut/app/trading/tca.py`
- `services/torghut/app/trading/empirical_jobs.py`
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`

Acceptance gates:

- compact packet lists selected repair hypotheses and all capital guardrails;
- no live or paper notional opens from this change;
- tests prove stale empirical proof, stale TCA, empty research inventory, and stale market context remain guarded.

## Deployer Handoff

Objective: verify repair-yield market visibility without changing capital behavior.

Required evidence:

- Torghut route returns current `repair_yield_market` with fresh timestamp;
- Jangar status consumes the selected repair ids;
- Argo health and deployment readiness are recorded;
- `/trading/status` still reports zero notional unless every capital gate explicitly allows;
- rollback flag and current consumer-evidence fallback are documented in the PR.
