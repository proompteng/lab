# 110. Torghut Options Hypothesis Leases And Capital Reentry Ladder (2026-05-06)

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

I am choosing **options hypothesis leases with a capital reentry ladder** as the next Torghut architecture step.

The current Torghut system has working service routes and fresh options activity, but the profit loop is not current.
The live and simulation revisions are ready. ClickHouse, Keeper, Torghut Postgres, options catalog, options enricher,
options TA, equity TA, simulation TA, websockets, and guardrail exporters are running. The options catalog returned a
hot set of `160` symbols under a provider cap of `200`, and the options enricher last succeeded at
`2026-05-06T08:11:25Z`.

That data should be exploited, but not with live capital. Torghut readiness is degraded because live submission is
blocked by `simple_submit_disabled`. Capital stage is `shadow`. Empirical jobs are stale from `2026-03-21T09:03:22Z`.
Runtime profitability for the last `72h` has `8` decisions, `0` executions, and `0` TCA samples. The latest sampled
decisions are rejected rows from `2026-05-04T17:25:57Z`, latest sampled executions are canceled rows from
`2026-04-02`, and TCA expected-shortfall coverage is `0`.

The selected design lets Torghut consume Jangar `experiment_lease` decisions before it does hypothesis work. A fresh
options lane can earn leases for `shadow_rank`, `shadow_decide`, and `metric_window` with zero notional. Paper and live
leases require retired empirical debt, current hypothesis metric windows, explicit promotion decisions, fresh
account/window quant latest, current TCA, and clean rollout proof.

The tradeoff is slower live reentry. I accept that because the system currently has fresh data, not fresh profit proof.
We should spend the next increment turning options data into falsifiable hypotheses and bounded shadow evidence.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, broker settings, runtime settings, or trading flags were mutated during this
assessment.

### Cluster Evidence

- Argo reported `torghut`, `jangar`, and `agents` synced and healthy at revision
  `da09882e2f7b2ecb48e45a9a4d6f3427725fdb7d`.
- `torghut-00233-deployment-67bcd45899-f4n8r` was `2/2 Running`; `torghut-sim-00314-deployment-849dccc4f4-4qczs` was
  `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, options catalog, options enricher, options TA, equity TA, simulation TA,
  websocket services, ClickHouse guardrails, LLM guardrails, Symphony, and Alloy were running.
- Recent Torghut events still included ClickHouse multiple-PDB warnings and a Flink status update conflict for options
  TA, so rollout proof remains a deployer gate.
- The wider cluster still had pending Rook Ceph OSD pods and one pending Temporal Elasticsearch pod. These are not
  immediate Torghut route failures, but they matter for artifact durability and workflow confidence.

### Data Evidence

- `/db-check` returned schema current at `0029_whitepaper_embedding_dimension_4096`, with the known lineage warnings
  for parent forks and no duplicate or orphan revisions.
- `/readyz` returned `status=degraded`; Postgres, ClickHouse, Alpaca live account status, database schema, and Jangar
  universe were healthy.
- `/trading/status` reported live mode, simple pipeline mode, stale empirical jobs, live submission disabled, autonomy
  disabled, and quant evidence not required because `quant_health_not_configured`.
- `/trading/health` reported `hypotheses_total=3`, with `2` shadow hypotheses, `1` blocked hypothesis, `0` promotion
  eligible hypotheses, and `3` rollback-required hypotheses.
- Jangar quant health returned `latestMetricsCount=108`, `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and
  `metricsPipelineLagSeconds=52930`; this is reachable but not enough for live sizing.
- `/trading/profitability/runtime?window=72h` showed `8` decisions, `0` executions, and `0` TCA samples in the active
  window.
- The latest sampled decisions were rejected `AAPL` and `AMD` rows from `2026-05-04T17:25:57Z`.
- The latest sampled executions were canceled `MU` rows from `2026-04-02T20:59:45Z`.
- `/trading/tca` reported `13,775` historical orders, expected-shortfall coverage `0`, and
  `last_computed_at=2026-04-02T20:59:45Z`.
- Options catalog health was ready, options hot set returned `160` symbols, and options enricher health was ready with
  current success at `2026-05-06T08:11:25Z`.
- ClickHouse guardrails showed both replicas up, no read-only replica, and high disk-free ratios. TA signal and
  microbar max timestamps were `2026-05-05T20:59:07Z`.

### Source Evidence

- `services/torghut/app/trading/hypotheses.py` defines runtime hypothesis states, capital stages, dependency
  capabilities, entry requirements, promotion gates, and rollback triggers.
- `services/torghut/app/trading/submission_council.py` owns capital stage, empirical readiness, quant evidence, and
  live-submission gate payloads.
- `services/torghut/app/trading/scheduler/pipeline.py` owns the hot path where live sizing must require a current
  experiment lease before notional is produced.
- `services/torghut/app/options_lane/repository.py`, catalog service, enricher service, and settings own the fresh
  options data plane that can produce shadow hypotheses.
- Migration `0021_strategy_hypothesis_governance.py` already introduced hypothesis windows, capital allocations, and
  promotion decisions as durable proof tables.
- Tests exist for hypothesis governance, options lane, empirical jobs, submission council, scheduler safety, quant
  readiness, profitability proof generation, TCA policy, and historical simulation parity. The missing regression is a
  consumer-level test proving fresh options data can create only zero-notional hypothesis leases until empirical,
  quant, promotion, and TCA proof are current.

## Problem

Torghut needs to innovate without confusing data freshness with capital readiness.

The options lane is the freshest current surface. It can produce better hypotheses than the stale equity decision loop
because it exposes contract richness, expiration structure, and option-specific liquidity constraints. But the current
proof state cannot support paper or live promotion. The system has no fresh execution loop, no current TCA samples, no
current empirical proof, no promotion-eligible hypotheses, and no required account/window quant gate.

The architecture must let Torghut learn while keeping live capital closed. It needs to answer:

1. Which options hypothesis can be generated under a zero-notional lease?
2. Which metric window proves or falsifies the hypothesis?
3. Which promotion decision is required before paper?
4. Which account, quant, TCA, and rollout proof are required before live?
5. What evidence retires each blocker?

## Alternatives Considered

### Option A: Reopen Live Capital From Route And Options Freshness

Pros:

- Fastest way to regain market exposure.
- Uses the freshest data plane.
- Avoids new admission plumbing.

Cons:

- Empirical jobs are stale by weeks.
- Runtime profitability has no executions or TCA samples in the active window.
- Latest sampled decisions are rejected and stale.
- Quant latest is not configured as a required Torghut gate.
- This would convert data availability into capital authority without proof.

Decision: reject.

### Option B: Freeze All Torghut Hypothesis Work Until Proof Debt Is Cleared

Pros:

- Strongest capital safety posture.
- Easy for deployer to enforce.
- Prevents growth of proof data.

Cons:

- Wastes a live options hot set and current enrichment path.
- Does not create the missing hypothesis metric windows.
- Does not give engineers a measurable way to retire debt.
- Keeps profitability innovation outside the operating system.

Decision: reject as the normal posture. Keep it as emergency fail-closed behavior.

### Option C: Options Hypothesis Leases With A Capital Reentry Ladder

Pros:

- Allows fresh options data to produce bounded, zero-notional evidence.
- Blocks paper and live capital until proof debt is retired.
- Converts Jangar experiment leases into a single scheduler-admission contract.
- Produces measurable hypotheses, metric windows, and promotion decisions before capital moves.
- Gives deployer explicit rollout, rollback, and widening gates.

Cons:

- Requires Torghut to integrate a new lease consumer before sizing.
- Requires new fixtures for empty or stale proof states.
- Requires a shadow period to tune lease budgets and metric thresholds.

Decision: select Option C.

## Chosen Architecture

Torghut consumes Jangar `experiment_lease` records before each material hypothesis action:

```text
torghut_experiment_lease_view
  lease_id
  account_label
  hypothesis_id
  strategy_id
  data_surface                         # options, equity, market_context, quant_latest, tca
  action_class                         # shadow_rank, shadow_decide, metric_window, paper_canary, live_micro_canary
  decision                             # allow, shadow_only, repair_only, hold, block
  max_symbols
  max_contracts
  max_notional
  metric_window
  fresh_until
  debt_items[]
  reason_codes[]
  evidence_refs[]
```

The first three options hypothesis families are deliberately shadow-only:

1. **Liquidity-filtered options momentum.** Rank hot-set contracts by underlying momentum, quote quality, spread, and
   depth. Metric: post-cost one-session return, fillability proxy, spread drag, and max adverse excursion.
2. **Skew dislocation reversion.** Detect contracts whose relative put/call skew or moneyness bucket diverges from the
   underlying session move. Metric: next-session delta-adjusted return, hit rate, and expected shortfall.
3. **Event-volatility compression.** Use market-context and options freshness to find contracts where realized
   underlying movement is high but option follow-through is weak. Metric: shadow PnL after spread, latency sensitivity,
   and rejection/fillability reasons.

Initial ladder decisions for the current evidence:

```text
shadow_rank                 allow, max_notional=0
shadow_decide               allow, max_notional=0
metric_window               allow, max_notional=0
paper_canary                block
live_micro_canary           block
live_scale                  block
```

Graduation rules:

- `shadow_rank` requires a current options lease, a bounded hot-set size, and no full proof-series scan.
- `shadow_decide` requires a current options lease plus quote-quality and spread filters.
- `metric_window` requires persisted hypothesis windows with sample count, post-cost return, slippage proxy, adverse
  excursion, and freshness timestamps.
- `paper_canary` requires fresh empirical jobs, explicit promotion decision, account/window quant latest within the
  configured session freshness window, and no active Jangar blocker debt for the hypothesis.
- `live_micro_canary` requires paper settlement, current TCA expected-shortfall coverage, broker-event reconciliation,
  buying-power budget, and clean rollout proof.
- `live_scale` requires live micro-canary settlement, positive post-cost edge, drawdown inside guardrail, rollback
  rehearsal, and no unresolved proof debt.

## Implementation Scope

Engineer stage should:

1. Add a Torghut lease consumer boundary that can read Jangar experiment leases and expose an internal decision object
   to the scheduler and submission council.
2. Add a scheduler guard: no paper or live notional can be produced without a current lease whose action class permits
   the requested stage.
3. Add zero-notional options hypothesis generation behind `shadow_rank`, `shadow_decide`, and `metric_window` leases.
4. Persist metric windows for the three initial options hypothesis families with sample counts, post-cost return,
   spread drag, adverse excursion, and evidence refs.
5. Add promotion-decision fixtures that keep paper and live blocked when empirical jobs, quant latest, TCA coverage, or
   Jangar debt items are stale.
6. Keep all admission reads on latest/materialized projections. Full-series reads belong to offline repair jobs.

Deployer stage should:

1. Deploy lease consumption in shadow mode and verify current state maps to zero-notional decisions only.
2. Run one full market session of options shadow ranking and metric-window generation.
3. Confirm new hypothesis metric windows and promotion decisions appear before enabling paper canary.
4. Keep live capital disabled until empirical jobs are fresh, TCA coverage is current, quant latest is required and
   fresh, and Jangar live leases are clean.
5. Roll back by disabling lease enforcement for shadow ranking only; never roll back by reopening live submission.

## Validation Gates

- A consumer test proves fresh options hot set plus stale empirical jobs yields `shadow_only` with `max_notional=0`.
- A scheduler test proves absence of a current lease prevents paper and live sizing.
- A submission council test proves stale TCA or expected-shortfall coverage `0` blocks live micro-canary.
- A hypothesis test proves metric windows include sample count, post-cost return, spread drag, adverse excursion, and
  evidence refs.
- A promotion test proves explicit promotion decisions are required before paper canary.
- A rollback test proves disabling lease enforcement for shadow ranking does not enable live submission.
- A deployer smoke test proves `/readyz`, `/trading/status`, Jangar quant health, and options hot-set status explain
  each action-class decision without direct database credentials.

## Rollout And Rollback

Rollout sequence:

1. Read leases and expose decisions in Torghut status without enforcement.
2. Enforce leases for zero-notional options shadow ranking.
3. Persist metric windows and promotion decisions.
4. Require paper-canary leases before simulated or paper notional.
5. Require live-micro-canary leases before any live notional.

Rollback sequence:

1. Disable lease enforcement for shadow ranking if it blocks evidence generation.
2. Keep `simple_submit_disabled` and shadow capital stage in place.
3. Continue publishing lease and debt decisions for diagnosis.
4. Restore the prior shadow-only scheduler path.
5. Re-enable enforcement only after a post-rollback proof bundle identifies the wrong reducer input or threshold.

## Risks

- The initial hypothesis families may not produce edge. That is acceptable if they produce falsification evidence
  cheaply and quickly.
- Lease thresholds can be too strict. Mitigation: observe-only calibration and reason-code histograms before paper.
- Options hot-set quality can drift. Mitigation: require quote-quality and spread filters in every metric window.
- Scheduler integration can be bypassed. Mitigation: make missing lease a hard test failure for paper and live sizing.
- TCA can remain stale. Mitigation: block live micro-canary until expected-shortfall coverage is current and non-zero.

## Handoff Contract

Engineer acceptance is a merged implementation that consumes Jangar leases, keeps current evidence zero-notional, emits
options hypothesis metric windows, and proves scheduler/submission paths cannot produce paper or live notional without
a current lease.

Deployer acceptance is one market-session shadow report showing lease decisions, generated hypothesis windows,
promotion-decision state, TCA and quant freshness, and explicit proof that live submission remained disabled. Paper and
live reentry stay blocked until the capital ladder gates are current and reviewable.
