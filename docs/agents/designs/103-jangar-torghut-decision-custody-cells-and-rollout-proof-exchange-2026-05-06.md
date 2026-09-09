# 103. Jangar Torghut Decision Custody Cells And Rollout Proof Exchange (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, rollout-safe dispatch, Torghut capital proof exchange, stale proof repair,
decision custody, and action-class rollback behavior.

Companion Torghut contract:

- `docs/torghut/design-system/v6/107-torghut-decision-custody-cells-and-capital-reentry-2026-05-06.md`

Extends:

- `102-jangar-dual-authority-dispatch-ledger-and-capital-proof-firewall-2026-05-06.md`
- `101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`
- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`

## Decision

I am choosing **decision custody cells with a rollout proof exchange** as the next Jangar architecture step for the
Torghut quant lane.

The current runtime is healthier than the earlier soak. Jangar is serving, the `agents-controllers` rollout is `2/2`,
runtime kits include `codex-nats-publish`, `codex-nats-soak`, and `nats`, execution trust is healthy, and workflow/job
adapters are configured. Torghut is also serving on `torghut-00231`, with Postgres, ClickHouse, Alpaca, and Jangar
universe checks healthy.

The system still must not convert this recovered route health into capital authority. Jangar's dependency quorum is
blocked by stale empirical jobs. Torghut live readiness is degraded because live submission is disabled, all hypotheses
are shadow or blocked, current account quant health is not configured as a required proof, and the most recent decisions
were rejected before submit because the intended notional exceeded live buying power. The failure mode to remove is not
"service down." It is "partly recovered control plane creates decisions without a fresh, bounded, account-scoped capital
warrant."

The selected architecture adds a custody cell between rollout proof and material action. Jangar can keep observation and
repair open when rollout health is good. Jangar can only issue Torghut capital warrants when rollout proof, heartbeat or
rollout-derived authority, empirical freshness, quant health, and failed-run debt all reduce to an action-class decision.
Torghut then consumes one warrant per hypothesis, account, and window before it sizes a decision.

The tradeoff is stricter admission. Some decisions that would have become rejected rows will be held earlier as
shadow-only evidence. I accept that because rejected live decisions are not harmless; they spend operator attention,
hide sizing defects, and make profit evidence harder to interpret.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were mutated while collecting this evidence.

### Cluster And Rollout Evidence

- The run identity is `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` is unset, but cluster
  auth works through the service account.
- `kubectl get pods -n jangar -o wide` showed Jangar, Bumba, Alloy, Redis, Open WebUI, Symphony, Symphony-Jangar, and
  `jangar-db-1` running.
- `kubectl get deploy -n jangar -o wide` showed Jangar and supporting services available, but listing Jangar
  StatefulSets is forbidden to this service account.
- Jangar events showed a recent rollout with a transient readiness probe failure before the new pod became ready.
- Jangar `/health` returned HTTP 200.
- Jangar `/api/agents/control-plane/status` at `2026-05-06T06:10Z` reported `agents-controller` and
  `supporting-controller` healthy from the available `agents-controllers` rollout, `orchestration-controller` healthy
  from heartbeat, `execution_trust.status=healthy`, `database.status=healthy`, workflow/job/Temporal runtime adapters
  configured, and `rollout_health.status=healthy`.
- The same status payload kept `dependency_quorum.decision=block` with reason `empirical_jobs_degraded`.
- `kubectl get deploy -n agents -o wide` showed `agents=1/1` and `agents-controllers=2/2`.
- The Agents namespace still retained failed historical jobs for Jangar and Torghut quant plan/verify/discover runs.
- `kubectl get pods -n torghut -o wide` showed live `torghut-00231`, simulation `torghut-sim-00312`, ClickHouse,
  Keeper, Torghut Postgres, equity TA, simulation TA, options TA, options catalog, options enricher, websockets,
  guardrail exporters, and Alloy running.
- Torghut events included repeated ClickHouse multiple-PDB warnings, startup/readiness probe flaps during the latest
  Knative rollout, and a Flink status modification conflict for options TA.
- Listing Knative services and StatefulSets in `torghut` is forbidden to this service account, so the design relies on
  Deployment, Pod, event, service, and HTTP-route evidence for this read-only pass.

### Database And Data Evidence

- Torghut `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with current
  and expected head signatures aligned.
- The database contract still reports lineage warnings for the known parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; no orphan or duplicate
  revisions were reported.
- Direct CNPG and ClickHouse exec reads are forbidden to `system:serviceaccount:agents:agents-sa`; direct ClickHouse
  HTTP without credentials returns `REQUIRED_PASSWORD`.
- Torghut `/readyz` and `/trading/health` returned degraded while Postgres, ClickHouse, Alpaca, and universe checks were
  healthy.
- Torghut `/trading/status` reported `mode=live`, `pipeline_mode=simple`, `active_revision=torghut-00231`,
  `capital_stage=shadow`, `TRADING_AUTONOMY_ENABLED=false`, `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`, and
  `simple_submit_disabled`.
- Jangar typed quant health for account `PA3SX7FYNUTF` returned `status=ok`, but `latestMetricsUpdatedAt` was
  `2026-05-05T17:28:03.839Z`, with account-stage rows omitted for the current window and quant enforcement not required
  by Torghut.
- Torghut empirical jobs remained stale from `2026-03-21T09:03:22Z` for `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Torghut `/trading/profitability/runtime` showed an active 72-hour window with 8 decisions, 0 executions, and no TCA
  samples in that window.
- The latest `/trading/decisions` sample came from `2026-05-04T17:25Z`, used
  `microbar-volume-continuation-long-top2-v11`, and was rejected before submit for `insufficient_buying_power`.
- Torghut `/trading/executions` showed the latest broker executions from `2026-04-02`, all canceled in the sample.
- Torghut `/trading/tca` still has 13,775 historical rows with `last_computed_at=2026-04-02T20:59:45Z` and no fresh
  expected-shortfall calibration sample.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the right reducer boundary: it composes controller authority,
  runtime adapters, database status, rollout health, execution trust, workflows, empirical services, runtime admission,
  and failure-domain leases.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already exposes typed Torghut
  quant-health state, including latest-store lag, stage health, runtime status, and market-hours-aware missing-update
  alarms.
- `services/torghut/app/main.py` is 4,051 lines and owns readiness, trading health, trading status, decisions,
  executions, runtime profitability, and TCA APIs.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4,288 lines and owns live-submission gate consumption,
  strategy runtime, risk, sizing, signal continuity, market context, and submission.
- `services/torghut/app/trading/submission_council.py` is 1,196 lines and owns quant evidence, capital stage,
  empirical readiness, promotion eligibility, and live submission gate payloads.
- Test coverage exists across control-plane status, runtime admission, Torghut quant-health routes, Torghut readiness,
  strategy runtime, empirical jobs, submission council, TCA, order feed, and risk. The missing regression is a
  cross-system reducer proving rollout health plus stale empirical jobs plus stale account quant plus buying-power
  rejects cannot produce a live capital warrant.

## Problem

Jangar and Torghut have moved past a simple liveness incident. The active failure mode is authority confusion.

1. A healthy rollout proves that pods are available. It does not prove a Torghut hypothesis has fresh empirical and
   account-scoped proof.
2. A live trading route with Alpaca connectivity can still be a shadow-only capital state.
3. Generic quant metrics can be fresh while the account and strategy window that would authorize live capital is stale
   or not required.
4. Decisions can be generated and persisted before the system has a bounded capital warrant, which turns sizing defects
   into pre-submit rejects instead of early shadow evidence.
5. Historical failed AgentRuns and stale empirical jobs are useful audit evidence, but they should reduce capital
   authority until a repair lane retires the debt.

The architecture has to reduce these facts to one small answer per material action: observe, repair, shadow decide,
paper canary, live micro-canary, scale live, or block.

## Alternatives Considered

### Option A: Treat Jangar Recovery As Permission To Reopen Torghut Capital

Pros:

- Fastest operational path.
- Uses recovered Jangar rollout, runtime-kit, and execution-trust evidence.
- Avoids new projections.

Cons:

- Ignores `empirical_jobs_degraded`.
- Lets stale account quant proof hide behind generic route health.
- Does not stop notional sizing defects before decision persistence.

Decision: reject. It is route recovery, not profit recovery.

### Option B: Freeze Torghut Until Every Proof Gap Is Manually Cleared

Pros:

- Conservative and easy to explain.
- Prevents accidental live orders.
- Gives engineers time to repair empirical jobs and quant health.

Cons:

- Does not create a durable repair ledger.
- Blocks useful shadow decisions that would measure the next hypotheses.
- Encourages manual exception paths because the system cannot express repair-only authority.

Decision: keep as an emergency posture, not the operating model.

### Option C: Decision Custody Cells With Rollout Proof Exchange

Pros:

- Separates rollout proof, repair authority, shadow decision authority, and capital authority.
- Gives Torghut a warrant before sizing, not after rejection.
- Converts stale empirical jobs and stale account quant into explicit repair lanes.
- Preserves Jangar repair throughput while preventing rollout health from widening live capital.
- Creates one acceptance contract for engineer and deployer stages.

Cons:

- Adds a reducer and a projection contract.
- Requires shadow operation before enforcement.
- Requires Torghut to stop sizing live decisions without a current warrant.

Decision: select Option C.

## Chosen Architecture

Jangar will project a custody cell for each material action class and Torghut consumer tuple:

```text
decision_custody_cell
  cell_id
  namespace
  consumer                         # torghut
  account_label
  hypothesis_id
  strategy_id
  action_class                     # observe, repair, shadow_decide, paper_canary, live_micro_canary, live_scale
  rollout_authority_state          # allow, repair_only, hold, block
  controller_authority_state
  dependency_quorum_decision
  empirical_freshness_state
  account_quant_state
  failed_run_debt_count
  decision                         # allow, repair_only, shadow_only, hold, block
  max_notional
  max_order_count
  fresh_until
  reason_codes[]
  evidence_refs[]
```

Reducer rules:

- `observe` is allowed when the route is reachable.
- `repair` is allowed when Jangar rollout health is fresh and the repair scope is bounded.
- `shadow_decide` is allowed when Torghut dependencies are healthy but one or more profit proofs are stale.
- `paper_canary` requires fresh account quant, fresh empirical jobs, and no active rollout hold.
- `live_micro_canary` requires `paper_canary` plus a valid capital proof firewall decision, a hypothesis-specific
  notional cap, and a current broker-event reconciliation feed.
- `live_scale` requires live micro-canary settlement, positive post-cost edge, and rollback rehearsals.
- Any `empirical_jobs_degraded`, stale account quant during market hours, failed rollout proof, or missing broker-event
  reconciliation downgrades live action to `shadow_only` or `repair_only`.

Torghut must consume the custody cell before sizing. If no valid cell exists, the scheduler may create shadow evidence
but must not generate a live notional that can become an Alpaca pre-submit reject.

## Validation Gates

Engineer acceptance:

- Add a Jangar reducer test where rollout is healthy but empirical jobs are stale; expected Torghut action is
  `shadow_only`, not `live_micro_canary`.
- Add a reducer test where account quant is stale during market hours; expected live capital warrant is blocked.
- Add a Torghut scheduler test where no current warrant exists; expected result is a shadow decision with no live
  notional.
- Add a Torghut sizing test where buying power is lower than desired target notional; expected budgeted notional is
  clamped before decision persistence.

Deployer acceptance:

- Jangar `/api/agents/control-plane/status` must keep `execution_trust.status=healthy`.
- Jangar must expose a custody-cell projection for `PA3SX7FYNUTF` with explicit `fresh_until` and reason codes.
- Torghut `/readyz` must report schema current and no dependency timeout.
- Torghut `/trading/status` must show `active_capital_stage` no wider than the custody-cell decision.
- Torghut `/trading/profitability/runtime` must show fresh decisions and no unexplained pre-submit rejection spike.

## Rollout

1. Ship the custody-cell reducer in shadow mode and compare it with the current Jangar dependency quorum and Torghut
   live submission gate for one full market session.
2. Enforce the reducer for `live_micro_canary` only; observation, repair, and shadow decisions remain open.
3. Wire Torghut sizing to consume the warrant before creating a live notional.
4. Enable one hypothesis at micro-canary size after empirical jobs and account quant are fresh.
5. Scale only after post-cost settlement and broker-event reconciliation are current for the same account and window.

## Rollback

Rollback is a state transition, not a manual argument:

- If Jangar rollout health degrades, all live custody cells become `hold`.
- If Jangar execution trust degrades, live custody cells become `block` and repair cells remain scoped.
- If empirical jobs exceed their freshness window, live cells become `shadow_only`.
- If account quant is stale during market hours, live cells become `shadow_only`.
- If Torghut pre-submit rejects exceed 1 percent of budgeted live decisions, live cells become `paper_canary`.
- If broker-event reconciliation is missing after an order submit, live cells become `block` until reconciliation is
  restored.

## Risks

- The reducer can be too strict and starve useful shadow experiments. The mitigation is to keep `shadow_decide` open
  when route and data dependencies are healthy.
- The reducer can be too loose if account quant is optional. The mitigation is to require account-scoped quant for
  `paper_canary` and wider action classes.
- Large modules make implementation risky. The mitigation is to put the reducer in a small Jangar module and a small
  Torghut adapter, then test the boundary before touching scheduler internals.
- Historical failed-run debt can dominate the current signal. The mitigation is to separate retained audit debt from
  current blocking debt with explicit windows.

## Handoff Contract

Engineer stage owns the reducer, projection schema, Torghut warrant adapter, and regression tests above.

Deployer stage owns shadow rollout, custody-cell freshness verification, live micro-canary enablement, and rollback
checks. No deployer should widen capital from Jangar rollout health alone.

The first live candidate is not "Torghut is healthy." It is "one hypothesis, one account, one fresh custody cell, one
bounded notional, one rollback path."
