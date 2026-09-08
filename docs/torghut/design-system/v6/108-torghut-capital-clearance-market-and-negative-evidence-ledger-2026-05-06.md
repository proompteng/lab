# 108. Torghut Capital Clearance Market And Negative Evidence Ledger (2026-05-06)

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

I am choosing a **capital clearance market with a negative evidence ledger** as the next Torghut profitability
architecture.

Torghut is operational, but not capital-ready. Live `torghut-00232` returns `/healthz=200`, `/db-check=200`,
`/trading/status=200`, and `/trading/health=503`. Its `/readyz` is degraded even though scheduler, Postgres,
ClickHouse, Alpaca, database schema, and universe checks are OK; the live submission gate is closed with
`simple_submit_disabled`, `capital_stage=shadow`, three hypotheses, zero promotion-eligible hypotheses, and three
rollback-required hypotheses. Simulation `torghut-sim-00313` is route-healthy, but it has missing empirical jobs and
degraded quant evidence from Jangar's empty latest store.

The profit evidence is also not ready. Live runtime profitability shows an active 72-hour window with 8 decisions, 0
executions, and 0 TCA samples. The first sampled strategy bucket is `microbar-volume-continuation-long-top2-v11`, with
rejected decisions and no executions. Live TCA has 13,775 historical rows, but `last_computed_at` is
`2026-04-02T20:59:45.136640+00:00` and expected-shortfall coverage is zero. Simulation has 0 decisions, 3 canceled
executions in the 72-hour window, and no TCA samples. Empirical jobs are stale in live and missing in sim.

The selected design treats each hypothesis as a bidder for scarce capital clearance. It must bring fresh empirical
evidence, non-empty account quant evidence, current TCA, bounded buying-power-aware sizing, and a Jangar clearance
record before it can receive paper or live capital. Negative evidence is not hidden in status text; it becomes a debt
ledger that reduces or blocks notional until repaired.

The tradeoff is that Torghut will spend more time in shadow and paper until evidence freshness is repaired. I accept
that. The profitable system is the one that prices missing proof before it sizes, not the one that records avoidable
rejections and calls them activity.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were mutated while collecting this evidence.

### Cluster And Runtime Evidence

- Argo reports `torghut`, `jangar`, and `agents` synced and healthy at
  `8a130c3047a48c60c5c8bd96c3d8aeee95b9ac7c`.
- `kubectl get pods,deploy,svc -n torghut -o wide` showed live `torghut-00232` and sim `torghut-sim-00313` at `2/2`
  Running, with ClickHouse, Keeper, Postgres, TA jobs, options services, websockets, guardrail exporters, and Alloy
  running.
- Recent events showed startup/readiness probe flaps during the Knative rollout and then Argo health recovery.
- Options catalog and options enricher returned `/healthz=200` and `/readyz=200`; options enricher had a fresh
  `last_success_ts`.
- Jangar control-plane status is route-healthy but dependency quorum is blocked by `empirical_jobs_degraded`.
- Temporal has one pending Elasticsearch pod and the cluster has pending Ceph OSDs; these are residual durability and
  search-risk signals, not immediate Torghut route blockers.

### Database And Data Evidence

- Direct CNPG status and pod exec into Torghut Postgres or ClickHouse are forbidden to this service account, so this
  pass used service projections and guardrail metrics.
- Torghut `/db-check` returned `ok=true`, schema current at `0029_whitepaper_embedding_dimension_4096`, current and
  expected heads aligned, one root, one branch, no orphan parents, no duplicate revisions, and lineage warnings for the
  known parent forks at `0010` and `0015`.
- Live `/readyz` returned degraded with Postgres, ClickHouse, Alpaca, database, and universe checks OK; quant evidence
  is not required in live and live submission is disabled.
- Sim `/readyz` and `/trading/health` returned OK because the route is paper-mode, but sim quant evidence still reports
  degraded status from Jangar's empty latest store.
- Jangar typed quant health for the scoped query returned `latestMetricsCount=0`, `latestMetricsUpdatedAt=null`,
  `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Live `/trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and stale
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs for candidate
  `intraday_tsmom_v1@prod` and dataset snapshot `torghut-full-day-20260318-884bec35`.
- Sim `/trading/empirical-jobs` returned the same four job types missing.
- Live `/trading/profitability/runtime` returned an active 72-hour window with 8 decisions, 0 executions, 0 TCA samples,
  and rejected decision buckets.
- Sim `/trading/profitability/runtime` returned 0 decisions, 3 canceled executions, and 0 TCA samples.
- Live `/trading/tca` summarized 13,775 historical orders with expected-shortfall sample count 0 and coverage 0; sim
  TCA has no current rows.
- ClickHouse guardrail metrics showed both replicas up, no replicated table read-only flag, high disk-free ratios, and a
  successful last scrape.
- LLM guardrail metrics showed LLM disabled, effective shadow mode on, policy compliant, and governance evidence
  incomplete.

### Source Evidence

- `services/torghut/app/main.py` is 4,051 lines and owns readiness, trading status, trading health, decisions,
  executions, runtime profitability, and TCA projections.
- `services/torghut/app/trading/autonomy/lane.py` is 7,377 lines and owns a large amount of autonomy artifact and gate
  behavior.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and already owns quant evidence, empirical
  readiness, promotion eligibility, active capital stage, and live submission gate payloads.
- `services/torghut/app/trading/empirical_jobs.py` defines the empirical job contract and truthfulness checks for
  benchmark parity, foundation router parity, Janus event CAR, and Janus HGRM reward.
- `services/torghut/app/trading/hypotheses.py` owns source-controlled hypothesis manifests, readiness states, capital
  stages, dependency capabilities, and Jangar dependency quorum.
- The Torghut service has 303 app/test/config files under the app and tests surfaces, 140 test files, and 31 Alembic
  migration files. Coverage exists, but the missing test boundary is a market-clearing reducer that prices negative
  evidence before a live decision can be persisted.

## Problem

Torghut has too many proof facts and too little capital pricing.

1. A healthy route does not mean a hypothesis has earned live notional.
2. Stale empirical jobs are currently a block reason, but not a priced debt with a repair path.
3. Empty Jangar quant latest-store state is visible, but live Torghut does not require it.
4. TCA history exists but is stale and has zero expected-shortfall coverage.
5. Rejected decisions and canceled executions reduce the value of shadow evidence unless the system accounts for them
   explicitly.
6. The scheduler hot path is already large, so profitability logic should enter as a small budget contract before deeper
   refactors.

The next system-level change has to decide how capital is earned, withheld, repaired, and rolled back.

## Alternatives Considered

### Option A: Repair Empirical Jobs And Reopen The Current Simple Lane

Pros:

- Directly addresses the current `empirical_jobs_degraded` block.
- Keeps implementation smaller.
- Preserves the existing simple-lane status surface.

Cons:

- Leaves quant latest-store enforcement optional in live.
- Leaves stale TCA and expected-shortfall coverage outside capital pricing.
- Does not make pre-submit rejects reduce future notional.
- Does not let hypotheses compete for limited repair and capital budget.

Decision: reject as the full architecture. It repairs one blocker but not the capital model.

### Option B: Keep Torghut Shadow-Only Until Every Evidence Surface Is Green

Pros:

- Strong capital safety.
- Simple operational rule.
- Avoids false live readiness while proof is stale.

Cons:

- Does not rank which hypothesis should be repaired first.
- Does not preserve a measurable path from shadow evidence to paper and live micro-canary.
- Treats all negative evidence as binary block instead of a cost that can be retired.
- Gives deployers no notional ladder.

Decision: keep as fallback when the clearinghouse is unavailable, not as the operating architecture.

### Option C: Capital Clearance Market With Negative Evidence Ledger

Pros:

- Converts stale proof, empty quant latest store, missing TCA, rejects, cancellations, and infra pressure into priced
  evidence debt.
- Lets hypotheses bid for repair and capital clearance with explicit post-cost targets.
- Consumes Jangar clearance before sizing and persistence.
- Keeps shadow evidence open while paper/live capital is blocked.
- Defines measurable gates for profitability, not just service health.

Cons:

- Adds a local ledger and clearing reducer.
- Requires careful migration planning if persisted tables are introduced.
- Slows live canary until evidence debt is repaired.

Decision: select Option C.

## Chosen Architecture

Torghut will introduce a local capital clearing layer that consumes Jangar `capital_action_clearance` and emits local
budget decisions before scheduler sizing:

```text
capital_clearance_market
  market_id
  account_label
  session_date
  generated_at
  clearances[]                    # Jangar action-class clearances
  negative_evidence_debts[]        # local and Jangar debts
  hypothesis_orders[]              # candidate bids for paper/live capital
  clearing_decisions[]             # shadow_only, repair_only, paper_canary, live_micro_canary, live_scale
```

Negative evidence debt types:

- `empirical_stale`: required empirical job is older than the freshness window.
- `empirical_missing`: required empirical job is absent for the account/hypothesis/candidate.
- `quant_latest_empty`: Jangar latest-store count is zero for the scoped account/window.
- `quant_latest_stale`: account quant evidence is older than the market-hours threshold.
- `tca_stale`: TCA settlement is older than the evidence window.
- `expected_shortfall_uncovered`: expected-shortfall coverage is below threshold.
- `pre_submit_reject`: decision was rejected before broker submit.
- `broker_canceled`: execution sample is canceled without settled fill evidence.
- `infra_pressure`: Temporal, storage, or artifact durability risk reduces live clearance.

Clearing rules:

- Without Jangar clearance, live notional is zero and the scheduler may only emit shadow evidence.
- With `repair_only`, Torghut schedules or reports the repair objective and records why capital is blocked.
- With `shadow_only`, Torghut records intent, features, forecasts, estimated cost, and would-have-sized notional without
  creating live order intent.
- With `paper_canary`, Torghut may submit paper orders only up to the smaller of Jangar max notional, local hypothesis
  cap, current buying-power cap, and cost-adjusted edge cap.
- With `live_micro_canary`, Torghut must clamp notional before persistence using the same smallest-limit rule.
- With `live_scale`, Torghut must show positive post-cost evidence, current broker-event reconciliation, and no active
  rollback debt.

The market chooses capital by expected post-cost edge after debt:

```text
cleared_edge_bps =
  expected_gross_edge_bps
  - expected_shortfall_bps_p95
  - slippage_debt_bps
  - reject_debt_bps
  - freshness_debt_bps
```

No hypothesis receives paper or live capital unless `cleared_edge_bps > 0` and all hard blockers are absent.

## Measurable Trading Hypotheses

H-CONT-01, continuation:

- Entry repair: refresh benchmark parity and foundation router parity within 24 hours, non-empty account quant latest
  store within 60 seconds during market hours, and no Jangar dependency block.
- Shadow target: at least 40 current-session shadow decisions with reject-debt estimate below 1 percent and feature lag
  <= 90 seconds.
- Paper target: expected shortfall coverage >= 90 percent, average absolute slippage <= 12 bps, and post-cost cleared
  edge >= 6 bps.
- Live micro-canary: max notional starts at the smaller of Jangar clearance, 5 percent of buying power, and hypothesis
  cap.
- Rollback: two windows with cleared edge <= 0 bps, any broker-event reconciliation gap, or quant latest-store empty
  during market hours.

H-MICRO-01, microstructure breakout:

- Entry repair: required microstructure feature rows present, drift checks current, quant latest non-empty, and no
  active empirical missing debt.
- Shadow target: at least 60 decisions with feature coverage >= 99 percent and reject-debt estimate below 1 percent.
- Paper target: expected shortfall coverage >= 95 percent, average absolute slippage <= 8 bps, and cleared edge >= 10
  bps.
- Live micro-canary: max notional starts at the smaller of Jangar clearance, 3 percent of buying power, and hypothesis
  cap.
- Rollback: slippage above 12 bps, feature coverage below 99 percent, or drift incident.

H-REV-01, event reversion:

- Entry repair: market context freshness <= 120 seconds, quant latest non-empty, and stale empirical debt retired.
- Shadow target: at least 30 decisions with no market-context stale alerts and reject-debt estimate below 2 percent.
- Paper target: expected shortfall coverage >= 90 percent and cleared edge >= 8 bps.
- Live micro-canary: max notional starts at the smaller of Jangar clearance, 4 percent of buying power, and hypothesis
  cap.
- Rollback: stale market context, negative post-cost window, or Jangar clearance downgrade.

Portfolio-level hypothesis:

- Moving clearance and debt pricing before sizing should reduce insufficient-buying-power pre-submit rejects below 1
  percent of live decisions and raise paper-to-live conversion above 50 percent for the first cleared micro-canary.

## Validation Gates

Engineer acceptance:

- Add unit coverage for parsing Jangar capital-action clearance and converting it into a Torghut budget.
- Add a local reducer test where stale empirical jobs and empty quant latest store produce `repair_only` or
  `shadow_only`, not paper/live notional.
- Add scheduler coverage proving missing clearance does not persist live notional.
- Add sizing coverage proving Jangar max notional, buying power, hypothesis cap, and cost-adjusted edge all clamp
  notional before persistence.
- Add a negative evidence ledger test proving pre-submit rejects and canceled executions reduce the next clearing
  decision.
- Add TCA coverage proving expected-shortfall coverage below threshold blocks live capital even when route health is
  green.

Deployer acceptance:

- Torghut `/db-check` must remain schema-current and no dependency check may time out.
- Jangar quant health for the target account/window must be non-empty before paper or live capital clears.
- Torghut empirical jobs must be fresh for the target candidate before paper or live capital clears.
- Torghut `/trading/profitability/runtime` must show fresh decision evidence and no unexplained reject spike.
- Torghut `/trading/tca` must show current settlement and expected-shortfall coverage above the hypothesis threshold.
- Jangar `capital_action_clearance` must exist for the account/hypothesis/action class and include `fresh_until`,
  `reason_codes`, and notional caps.

## Rollout

1. Add the market reducer in observe mode and emit clearing decisions beside the current live submission gate.
2. Run one full market-session shadow comparison using live and sim route evidence.
3. Enforce missing or blocked Jangar clearance as shadow-only.
4. Repair empirical jobs, quant latest-store materialization, and TCA freshness before enabling paper canary.
5. Enable one paper canary for the highest cleared-edge hypothesis.
6. Enable one live micro-canary only after paper settlement and broker-event reconciliation are current.
7. Scale by cleared edge and debt retirement, not by route health.

## Rollback

- Missing Jangar clearance: zero live notional and shadow-only evidence.
- Empty or stale account quant latest store: downgrade paper/live to shadow-only.
- Stale or missing empirical jobs: downgrade paper/live to repair-only plus shadow.
- Expected-shortfall coverage below threshold: block live capital.
- Pre-submit rejects >= 1 percent of live decisions: downgrade to paper canary and create reject debt.
- Canceled executions without settlement: block live scale and require reconciliation repair.
- Negative cleared edge for two windows: disable that hypothesis until repaired.

## Risks

- The market can overfit to stale historical TCA. Mitigation: require current settlement windows before live clearance.
- Debt pricing can become opaque. Mitigation: publish debt types and bps deductions in status and audit artifacts.
- Scheduler changes can be risky because the hot path is large. Mitigation: implement a small budget adapter before
  touching deeper pipeline internals.
- The first clearing thresholds can be too strict. Mitigation: keep observe/shadow open and tune only after a full
  market-session comparison.

## Handoff Contract

Engineer stage owns the Jangar clearance consumer, Torghut market reducer, negative evidence ledger, budget adapter,
and regression tests above. Keep the first implementation small: a reducer and budget object ahead of scheduler sizing.

Deployer stage owns evidence repair, shadow comparison, paper canary, live micro-canary, and rollback checks. Do not
enable live capital from Torghut liveness or Jangar rollout health alone. Enable it only from a positive cleared edge,
fresh Jangar clearance, non-empty account quant, fresh empirical jobs, current TCA, and explicit notional caps.
