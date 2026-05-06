# 106. Jangar Proof Repair Clearinghouse And Brownout Priority Queue (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, proof repair prioritization, degraded dependency brownouts, rollout widening,
database projection safety, and Torghut capital-admission repair gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/110-torghut-evidence-freshness-repair-market-and-capital-reentry-2026-05-06.md`

Extends:

- `105-jangar-evidence-pressure-runways-and-profit-proof-budgets-2026-05-06.md`
- `104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`
- `101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`
- `92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`

## Decision

I am choosing a **ProofRepairClearinghouse** with a **brownout priority queue** as the next Jangar control-plane
architecture step.

The May 6 evidence is not an availability outage. Jangar is serving. `/ready` returns `status=ok` with leader election
healthy, execution trust healthy, memory embeddings configured, runtime admission passports allowed, and NATS
collaboration tooling present. `/api/agents/control-plane/status?namespace=agents` reports healthy execution trust,
healthy database migration consistency, healthy rollout health for `agents` and `agents-controllers`, healthy watch
reliability with thousands of AgentRun watch events and zero watch errors, and fresh discover, plan, implement, and
verify clocks for `jangar-control-plane`.

That is exactly why another broad readiness gate would be the wrong move. The live risk is dependency proof decay under
healthy service surfaces. Torghut `/readyz` and `/trading/health` return HTTP 503 with structured degraded payloads.
Empirical jobs are truthful but stale. The scoped paper quant latest query returns `latestMetricsCount=0` and
`emptyLatestStoreAlarm=true`. Jangar market-context health is degraded with stale technicals, fundamentals, news, and
regime domains. The global quant latest path is fresh, but the account/window path that a capital consumer needs is
empty. Jangar database schema is current, but direct CNPG SQL and pod exec are forbidden to this service account, so the
design must rely on safe service projections.

The selected architecture makes stale proof an owned work item, not just a block reason. Jangar will materialize repair
claims for each failing evidence domain, rank them by material-action impact, and brown out only the action classes that
need the missing proof. Serving, observe, and bounded repair stay open. Dispatch, deploy widening, paper canary, and
live capital remain held until the repair claim has fresh evidence and a settlement receipt.

The tradeoff is that Jangar becomes more opinionated about what gets repaired first. I accept that. A healthy control
plane that cannot tell Torghut whether to repair empirical jobs, market context, quant latest, or TCA first is still
leaving system risk on the floor.

## Read-Only Evidence Snapshot

All Kubernetes, service, and database/data checks in this pass were read-only. No Kubernetes resources, database rows,
broker settings, trading flags, or runtime objects were mutated.

### Cluster And Rollout Evidence

- Branch and repository: `codex/swarm-jangar-control-plane-discover` in `proompteng/lab`, based on `main`.
- Jangar namespace pods were running: `jangar`, `bumba`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI, Symphony,
  and Symphony-Jangar.
- Jangar deployment rollout was available: `deployment.apps/jangar 1/1`, running image
  `registry.ide-newton.ts.net/lab/jangar:a4403261`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents CronJobs were active for Jangar discover, plan, implement, and verify stages on hourly schedules.
- The `jangar-control-plane` Swarm was `Active`, `Ready=True`, with `requirements_pending=0`.
- Current Jangar stage clocks were fresh at the time of assessment: discover last ran at
  `2026-05-06T07:05:04.802Z`, plan at `2026-05-06T07:20:08.877Z`, implement at
  `2026-05-06T06:35:05.689Z`, and verify at `2026-05-06T07:50:53.610Z`; all were non-stale with high data confidence.
- Agents namespace AgentRun projection showed 122 total AgentRuns: 96 succeeded, 10 failed, 4 running, and 12 templates.
- Recent Agents events showed successful scheduled job creation and completion, but also readiness probe timeouts during
  rollout transition on old `agents` and `agents-controllers` pods. The replacement `a4403261` deployments are healthy.
- Torghut namespace pods were running for ClickHouse, Keeper, Torghut Postgres, live and sim revisions, options catalog,
  options enricher, options/equity TA, websocket services, guardrail exporters, Symphony, and Alloy.
- Torghut rollout was operational but noisy: recent events showed Knative live and sim revisions becoming ready after
  readiness probe failures, and repeated ClickHouse multiple-PDB selection warnings.
- Listing StatefulSets and CNPG clusters, and execing into Postgres pods, is forbidden to
  `system:serviceaccount:agents:agents-sa`. The architecture therefore cannot require privileged shell access for
  normal proof admission or deployer acceptance.

### Jangar Control-Plane Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- Jangar `/ready` reported `execution_trust.status=healthy`, no blocking windows, and allowed runtime passports for
  serving, swarm plan, swarm implement, and swarm verify classes.
- `GET /api/agents/control-plane/status?namespace=agents` reported `database.configured=true`,
  `database.connected=true`, `database.status=healthy`, and `latency_ms=11`.
- Jangar Kysely migration consistency was healthy: 28 registered migrations, 28 applied migrations, zero unapplied,
  zero unexpected, and latest applied `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for `agents` and `agents-controllers`, with two configured deployments observed and zero
  degraded deployments.
- Watch reliability was healthy over a 15-minute window, with 3,623 total events, zero errors, and zero restarts.
- The control-plane summary route reported 122 AgentRuns, 24 ImplementationSpecs, 12 Schedules, 6 Signals, and 2
  Swarms in the `agents` namespace.
- The global Torghut quant health route returned `status=ok`, `latestMetricsCount=3780`, and
  `latestMetricsUpdatedAt=2026-05-06T08:08:48.271Z`.
- The scoped paper/day query returned `status=degraded`, `latestMetricsCount=0`, `latestMetricsUpdatedAt=null`, and
  `emptyLatestStoreAlarm=true`. The global health signal is not enough for a capital consumer.

### Torghut Data And Dependency Evidence

- Torghut `/readyz` returned `status=degraded` with scheduler OK, Postgres OK, ClickHouse OK, Alpaca broker OK,
  database schema current, and universe fresh.
- The same `/readyz` response reported the live submission gate closed by `simple_submit_disabled`, `capital_stage`
  `shadow`, empirical jobs degraded, DSPy live runtime not active, and quant health not configured for that route.
- Torghut `/trading/health` returned the same capital posture: three hypotheses, one blocked and two shadow, zero
  promotion eligible, three rollback required, and dependency quorum blocked by `empirical_jobs_degraded`.
- Torghut database projection was current through the service route: expected and current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one expected/current head, no missing heads, no unexpected heads, and
  lineage ready. It still reports known parent-fork warnings at the `0010` and `0015` migration branches.
- Torghut empirical jobs were truthful but stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward`, all tied to candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Jangar market-context health returned `overallState=degraded`, `bundleFreshnessSeconds=128935`, and
  `bundleQualityScore=0.4575`.
- Market-context domain states were stale: technicals at 128,935 seconds against a 60-second budget, fundamentals at
  4,731,913 seconds against an 86,400-second budget, news at 4,365,099 seconds against a 300-second budget, and regime
  at 128,935 seconds against a 120-second budget.
- The NVDA context route returned stale domains as well: technicals and regime around 40,696 seconds old,
  fundamentals from `2026-03-12`, and news from `2026-03-16`.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,882 lines and owns schedule materialization,
  Swarm stage dispatch, requirement dispatch, freezes, workspace PVC status, and status reconciliation.
- `services/jangar/src/server/control-plane-status.ts` is 629 lines and is the right reducer boundary for controller
  authority, runtime adapters, database health, rollout health, watch reliability, workflow reliability, empirical
  services, and dependency quorum.
- `services/jangar/src/server/control-plane-execution-trust.ts` is 506 lines and already computes stale stage clocks,
  pending requirements, freezes, and recent failures into execution trust.
- `services/jangar/src/server/torghut-market-context.ts` is 748 lines and already has domain-level freshness,
  quality, provider health, risk flags, and ingest health concepts.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` is 128 lines and already exposes
  account/window-scoped latest-store emptiness and pipeline health.
- `services/torghut/app/main.py` is 4,051 lines and still carries readiness, trading health, empirical jobs,
  profitability runtime, TCA, market-context, whitepaper, simulation, and live submission behavior.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and already has the proof-aware submission gate
  concepts Jangar should consume for capital-adjacent action decisions.
- Test inventory is broad: 138 Jangar server/Torghut API TypeScript test files in the checked paths and 140 Torghut
  Python test files. The missing regression is not a route shape test. It is a cross-domain repair-priority reducer
  proving which stale proof should be repaired first and which action classes must remain brownout-held.

## Problem

Jangar has crossed an important line: serving health and execution trust can be green while Torghut remains unsafe for
capital because its proof dependencies are stale or empty.

If Jangar only reports "blocked" or "degraded", the operator still has to infer the repair order from several routes:
market context, empirical jobs, quant latest, readiness, trading health, database schema, and retained AgentRun debt.
That inference is slow and inconsistent. Worse, a future deploy could widen healthy controller pods while the dependency
that would make Torghut profitable is still weeks stale.

The control plane needs a durable answer to five questions:

1. Which proof defect is currently blocking the most valuable material action?
2. Which actions can stay open while that defect is repaired?
3. Which repair is safe to dispatch under least-privilege evidence?
4. Which deploy widening or capital action must remain held until settlement?
5. Which stale proof is old but truthful, and which proof is missing, empty, or not credible?

## Alternatives Considered

### Option A: Keep Current Readiness And Dependency Quorum Semantics

Jangar keeps serving readiness, execution trust, dependency quorum, market-context health, and quant health as separate
surfaces. Operators and Torghut continue joining them locally.

Pros:

- No new projection.
- Existing tests keep passing.
- Good enough for human diagnosis when the system is quiet.

Cons:

- Does not rank proof repair.
- Lets consumers disagree about whether market-context, empirical, or quant latest is the next blocker.
- Does not produce a repair settlement receipt that deployers can cite.
- Keeps capital-adjacent decisions coupled to manual interpretation.

Decision: reject as the next architecture. Keep these as inputs.

### Option B: Freeze All Dispatch And Capital Until Every Proof Surface Is Green

Any stale market context, stale empirical job, empty scoped quant latest, readiness probe debt, or migration warning
would freeze schedules, deploy widening, and capital.

Pros:

- Strong fail-closed posture.
- Easy to explain during an incident.
- Reduces chance of accidental live widening.

Cons:

- Blocks the repair runs that need to produce fresh evidence.
- Treats a stale news bundle like a broken database.
- Encourages manual bypasses because the gate is too coarse.
- Does not use healthy Jangar execution trust to make repair safer.

Decision: retain as an emergency brake, not the operating model.

### Option C: ProofRepairClearinghouse With Brownout Priority Queue

Jangar materializes proof defects as repair claims, ranks them by action-class impact and repair cost, and emits
brownout decisions per action class. Repair can proceed while deploy widening and capital remain held.

Pros:

- Turns stale evidence into assigned work with a freshness target.
- Keeps serving, observe, and bounded repair open during proof degradation.
- Gives deployer and engineer stages concrete acceptance gates.
- Lets Torghut consume one repair-priority contract before sizing or promotion.
- Works under least-privilege RBAC because consumers read service projections and receipts.

Cons:

- Adds a reducer and durable projection.
- Requires shadow calibration so low-value warnings do not starve important repair.
- Requires new tests across Jangar and Torghut proof domains.

Decision: select Option C.

## Chosen Architecture

Jangar adds a materialized `proof_repair_clearinghouse` projection and a `brownout_priority_queue`.

```text
proof_repair_claim
  claim_id
  namespace
  consumer                         # jangar, torghut
  evidence_domain                  # market_context, empirical_jobs, quant_latest, tca, rollout, database, schedule
  subject_ref                      # account/window, hypothesis, strategy, stage, route, or deployment
  current_state                    # fresh, stale, empty, missing, degraded, blocked, unknown
  truthful                         # true, false, unknown
  blocks_action_classes[]          # deploy_widen, schedule_dispatch, paper_canary, live_micro_canary, live_scale
  allows_action_classes[]          # serve, observe, repair, shadow_decide
  repair_objective
  repair_cost_class                # small, medium, large
  stale_age_seconds
  max_freshness_seconds
  evidence_refs[]
  negative_evidence_refs[]
  first_observed_at
  last_observed_at
  fresh_until
```

```text
brownout_priority_queue
  queue_id
  generated_at
  namespace
  consumer
  ranked_claims[]
  action_class_decisions[]
  total_blocked_value_score
  total_repair_cost_score
  next_repair_dispatch
  rollback_floor
```

Initial action classes:

- `serve`: Jangar and Torghut route serving.
- `observe`: read-only operator/API observation.
- `repair`: bounded proof-refresh or evidence-replay work.
- `schedule_dispatch`: routine scheduled stage launch.
- `deploy_widen`: increasing rollout exposure or promoting a new digest.
- `shadow_decide`: Torghut zero-notional or shadow evidence generation.
- `paper_canary`: paper orders or simulated capital-bearing checks.
- `live_micro_canary`: smallest live capital lane.
- `live_scale`: widened live capital.

Reducer rules:

- Healthy Jangar serving and execution trust allow `serve`, `observe`, and `repair`.
- Stale market context allows `shadow_decide` only when the strategy explicitly tolerates last-good context; otherwise
  it emits `repair_only` for the affected symbols/domains.
- Stale empirical jobs block `paper_canary`, `live_micro_canary`, and `live_scale`, but allow empirical replay repair.
- Empty scoped quant latest blocks all paper and live capital for that account/window, even if the global quant latest
  store is fresh.
- A current database schema projection allows repair, but migration warnings and forbidden direct DB access require
  service-owned proof receipts for deployer acceptance.
- Retained historical AgentRun failures do not block serving; active repeated failures in the same stage increase
  schedule-dispatch brownout pressure.
- Deploy widening is held when the top repair claim blocks a downstream consumer that would be widened by the deploy.

Priority scoring:

```text
repair_priority =
  blocked_action_weight
  + consumer_value_weight
  + stale_age_weight
  + truthful_repairability_weight
  - repair_cost_weight
  - blast_radius_weight
```

For the current evidence, the expected queue order is:

1. scoped quant latest repair for `paper/1d`, because it directly blocks paper/live capital and is empty;
2. empirical job replay for `intraday_tsmom_v1@prod`, because the jobs are truthful but stale;
3. market-context refresh for technicals/regime/news/fundamentals, because the domains are stale and reduce
   hypothesis quality;
4. TCA/expected-shortfall settlement, because it is required before live classes but comes after fresh inputs;
5. retained AgentRun debt cleanup, because current stage clocks are healthy and the debt is not the top capital
   blocker.

## Implementation Scope

Engineer stage should:

1. Add a pure Jangar reducer that compiles proof repair claims from control-plane status, quant health, market-context
   health, empirical-services summaries, AgentRun phase debt, and database projection status.
2. Emit the first projection in shadow mode through a typed API and in the control-plane status payload.
3. Add fixtures for the current evidence: healthy Jangar, degraded Torghut `/readyz`, stale empirical jobs, empty scoped
   paper quant latest, degraded market context, and current database schemas.
4. Add reducer tests proving `serve`, `observe`, and `repair` remain open while `paper_canary`, `live_micro_canary`,
   `live_scale`, and affected `deploy_widen` decisions are held.
5. Add a settlement receipt shape that records the repair command, evidence before/after, and action classes reopened.

Deployer stage should:

1. Deploy the clearinghouse in observe-only mode.
2. Compare the queue against existing Jangar dependency quorum and Torghut live submission gate for one market session.
3. Enforce repair-priority brownout for `paper_canary` and `live_micro_canary` before enforcing deploy widening.
4. Keep serving and bounded proof repair available unless Jangar execution trust becomes blocked.
5. Treat missing projection freshness as fail-closed for capital and fail-open for observe-only diagnostics.

## Validation Gates

- A regression test proves healthy Jangar execution trust plus stale empirical jobs produces `repair_only` for empirical
  repair and `block` for live capital.
- A regression test proves global quant latest `ok` plus scoped paper/day `emptyLatestStoreAlarm=true` blocks the scoped
  capital tuple.
- A regression test proves degraded market-context domains rank behind empty quant latest and stale empirical jobs for
  capital reentry, but ahead of retained historical AgentRun debt.
- A status contract test proves every repair claim has `fresh_until`, `blocks_action_classes`, `allows_action_classes`,
  `evidence_refs`, and `negative_evidence_refs`.
- A least-privilege acceptance test proves deployer can verify the queue without `pods/exec`, CNPG cluster listing, or
  direct database shell access.

## Rollout

1. Ship the reducer and API in shadow mode.
2. Publish repair claims in the control-plane UI/status surface without changing dispatch.
3. Enable brownout for Torghut paper/live capital classes.
4. Enable deploy-widen holds only when a repair claim blocks the widened consumer.
5. Add automated settlement receipts for repaired proof domains.

## Rollback

1. Disable brownout enforcement with a flag while keeping claim emission and receipts.
2. Revert capital decisions to the current dependency quorum and Torghut live submission gate.
3. Keep serving and observe routes unchanged.
4. Preserve repair receipts for audit; do not delete claim history on rollback.

## Risks

- A bad priority model can starve low-cost repairs. The first rollout must cap queue age and force periodic repair of
  older low-cost claims.
- Market-context freshness is session-sensitive. The reducer must use market-hours budgets and not treat closed-market
  technicals like live-session technicals.
- Repair claims can grow noisy if every transient probe failure becomes a claim. Only repeated or action-class relevant
  failures should enter the priority queue.
- Least-privilege projections can lag raw database truth. Every claim needs explicit source freshness and expiry.

## Handoff Contract

Engineer handoff:

- Build the clearinghouse as a pure reducer first.
- Use the current evidence fixtures exactly: Jangar healthy, Torghut capital degraded, empirical stale, scoped quant
  empty, market context stale.
- Keep proof reads on service-owned projections and latest/materialized paths.
- Add settlement receipts before any enforcement PR.

Deployer handoff:

- Require one shadow comparison window before enforcement.
- Do not widen deploys based only on healthy rollout if the widened consumer has a blocking repair claim.
- Keep capital classes fail-closed when the queue is missing or stale.
- Roll back enforcement by flag while preserving repair claims and receipts.
