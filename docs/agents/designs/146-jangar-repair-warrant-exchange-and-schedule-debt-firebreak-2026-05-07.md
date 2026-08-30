# 146. Jangar Repair Warrant Exchange And Schedule Debt Firebreak (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, schedule noise reduction, proof-backed repair admission, Torghut capital
readiness, validation, rollout, rollback, and engineer/deployer handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/150-torghut-repair-dividend-order-book-and-capital-warrants-2026-05-07.md`

Extends:

- `145-jangar-observation-epoch-tripwire-and-capital-contradiction-arbiter-2026-05-07.md`
- `144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `docs/torghut/design-system/v6/149-torghut-profit-evidence-convergence-epochs-and-quant-stage-arbitrage-2026-05-07.md`

## Decision

I am selecting **a Jangar repair warrant exchange with a schedule debt firebreak** as the next control-plane
architecture step.

The live system has moved past the crude outage state. At `2026-05-07T12:23Z`, Jangar and Agents were serving,
Argo CD reported `jangar`, `agents`, and `torghut` as `Synced` and `Healthy`, the Jangar database projection was
connected and migration-current, workflow debt was zero in the 15 minute control-plane status window, dependency
quorum was `allow`, and watch reliability was healthy. That is enough to continue ordinary control-plane work.

The remaining problem is different: repair work is not yet a settled product. Agents still had `60` Error pods in
history beside `175` Completed pods and `8` Running pods. Recent Agents events showed `/ready` timeouts after the
rollout. Torghut live `/readyz` returned HTTP `503`, while `/trading/status` returned HTTP `200` and proved that the
system is correctly holding capital at zero notional. The proof floor named concrete blockers: alpha readiness is not
promotion eligible, execution TCA is stale, market context is stale, live submit is disabled, and quant ingestion is
degraded. Jangar action budgets still reduce the Torghut paper hold to `torghut_consumer_evidence_missing`.

That gap causes two bad outcomes. Operators see repeated scheduled work and have to infer which failures are
superseded by later successes. Engineers see several Torghut repair facts but do not get a control-plane warrant that
states which zero-notional repair is admitted, how long it may run, which evidence closes it, and which capital gate it
can unlock. Deployer gates then remain conservative for the right reason, but the repair loop is slower than it needs
to be.

The design makes Jangar the owner of repair warrants. Torghut may price repair value, but Jangar issues the warrant
that admits work into the shared control plane. A warrant is not a ticket and not a capital approval. It is a bounded,
zero-notional work authorization with a source epoch, resource budget, expiry, validation command, closure receipt,
and rollback target.

The tradeoff is another settlement layer. I accept it because the alternative is repeated schedule churn plus vague
capital blockers. Jangar should spend complexity where it reduces failure modes and gives deployers a single receipt
to trust.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes a `repair_warrant_exchange` section in control-plane status.
- Each active warrant has a stable `warrant_id`, `source_epoch_id`, `repair_code`, `account_label`,
  `torghut_revision`, `admission_state`, `fresh_until`, `max_dispatches`, `max_runtime_seconds`, `max_notional=0`,
  `expected_unblock_value`, `risk_tier`, `validation_refs`, and `closure_requirements`.
- Jangar admits at most one active warrant per account, repair dimension, and rollout epoch unless the older warrant
  is closed or expired.
- Schedule-driven lanes consult the warrant exchange before creating repair AgentRuns for Torghut capital blockers.
- Failed schedule attempts are netted against later successful attempts inside a schedule debt window instead of
  becoming an unbounded negative evidence pile.
- `torghut_observe` remains allowed when the control plane is healthy.
- `paper_canary` can move from `shadow_only` only after the matching repair warrant closes inside a fresh
  observation epoch.
- `live_micro_canary` still requires paper settlement from a prior clean epoch.
- `live_scale` remains blocked until live micro settlement and expected shortfall coverage exist.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- The work branch `codex/swarm-jangar-control-plane-plan` was fast-forwarded to fresh `origin/main` at
  `2d48027cca6e5d3f907222f129e38cff7617a9a9`.
- The in-cluster identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get applications.argoproj.io -n argocd jangar agents torghut -o wide` reported `jangar`, `agents`, and
  `torghut` as `Synced` and `Healthy`.
- `kubectl get pods -n jangar -o wide` showed `jangar-98f54c787-xwwzs` `2/2 Running` on image
  `registry.ide-newton.ts.net/lab/jangar:817b46ca@sha256:729353bc...`.
- Recent Jangar events showed the `817b46ca` pod initially refused `/health` and then became ready.
- `kubectl rollout status -n agents deployment/agents` and `deployment/agents-controllers` both succeeded.
- `kubectl get pods -n agents --no-headers` counted `175 Completed`, `60 Error`, and `8 Running` pods.
- Recent Agents events showed `/ready` timeouts against both controller pods and the API pod after the rollout.
- `kubectl get pods -n torghut --no-headers` counted `27 Running` and `5 Completed` pods.
- Torghut live revision `torghut-00257` and simulation revision `torghut-sim-00357` were running.
- Recent Torghut events still showed duplicate ClickHouse PodDisruptionBudget matches, a Keeper PDB `NoPods` event,
  and FlinkDeployment status-modified warnings.

### Jangar Control-Plane Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200.
- Database projection was configured, connected, healthy, and reported `latency_ms=12`.
- Migration consistency was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Workflow status reported `active_job_runs=0`, `recent_failed_jobs=0`, and `backoff_limit_exceeded_jobs=0` in the
  15 minute window.
- Watch reliability was healthy with `2` observed streams, `2474` total events, `0` errors, and `1` restart.
- Dependency quorum was `allow` with all listed segments healthy.
- Action SLO budgets allowed `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  and `torghut_observe`.
- Torghut paper remained `shadow_only` because `torghut_consumer_evidence_missing`; live micro was held for the same
  reason, and live scale was blocked by `paper_settlement_required`.

### Torghut And Data Evidence

- Torghut live `/db-check` returned HTTP 200 with current Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Torghut schema lineage was ready, branch count was `1`, and duplicate revisions were empty.
- The same schema check still warned about the two historic parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- CNPG cluster, backup, and scheduled backup listing was RBAC-blocked for this service account in both `jangar` and
  `torghut` namespaces.
- Torghut live `/readyz` returned HTTP 503 with `status=degraded`.
- Torghut live `/trading/status` returned HTTP 200 for active revision `torghut-00257`, build commit
  `81b8231d014c94dc2c70173f35fb53bb279749cf`, mode `live`, pipeline `simple`, and `submit_enabled=false`.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- Live execution TCA had `13,775` orders, `avg_abs_slippage_bps=568.6138848199565249`, an `8` bps guardrail, and
  `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Live empirical jobs were fresh and truthful for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Jangar direct quant health for live account `PA3SX7FYNUTF` showed `latestMetricsCount=144`,
  `latestMetricsUpdatedAt=2026-05-07T12:24:38.579Z`, but degraded stages: ingestion lag `67203` seconds and
  materialization unhealthy.
- Torghut simulation `/readyz` returned HTTP 200, but simulation proof floor was also `repair_only` with
  `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and `0` promotion-eligible hypotheses.
- Jangar direct quant health for `TORGHUT_SIM` showed `latestMetricsCount=0`, no update timestamp, and no stage rows.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and remains the aggregation boundary for
  runtime, database, watch, execution, empirical, material-action, and admission evidence.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already classifies
  degraded Torghut readiness, stale market context, quant alerts, and rollout ambiguity.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is `473` lines and merges dependency quorum,
  SLO budgets, and action clocks into material action decisions.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and contains the existing action-clock
  surface that should consume warrant closure before paper/live gates widen.
- `services/jangar/src/server/control-plane-empirical-services.ts` is only `129` lines and reduces Torghut empirical,
  forecast, and LEAN state. It should not become the repair warrant reducer.
- Focused tests already exist for control-plane status, negative evidence routing, material-action verdicts, action
  clocks, failure-domain leases, controller witness, runtime admission, empirical services, and watch reliability.
- `services/torghut/app/main.py` is `4145` lines, so companion Torghut logic must stay out of the route assembly file.
- `services/torghut/app/trading/proof_floor.py` is `593` lines and already emits proof dimensions and a repair
  ladder, but Jangar does not yet admit those repairs as first-class warrants.

## Problem

The control plane can now tell us that capital should stay closed, but it cannot yet tell the system which repair is
authorized to run and what evidence retires it.

The failure modes are:

1. Schedule lanes can produce an Error pod and then a Completed pod for the same hourly intent, leaving historical
   noise that looks like active risk.
2. Torghut proof-floor repair facts are visible, but they are not bounded by Jangar dispatch budgets.
3. Generic blockers such as `torghut_consumer_evidence_missing` do not tell an engineer whether to repair TCA, market
   context, quant ingestion, materialization, or hypothesis readiness first.
4. A repair can run without a closure receipt that deployers can use for paper or live capital gates.
5. RBAC rightly blocks privileged database and CNPG inspection from this runner, so the durable contract must work
   through typed runtime evidence instead of privileged shell access.

## Alternatives Considered

### Option A: Keep The Current Schedule And Capital Gates

Pros:

- No new control-plane reducer.
- Existing SLO budgets remain stable.
- Repair work can continue manually.

Cons:

- Repeated schedule errors remain hard to net.
- Engineers still infer priority from several unrelated status fields.
- Paper/live gates stay conservative but slow because closure evidence is not first-class.

Decision: reject.

### Option B: Let Torghut Self-Admit Proof-Floor Repairs

Pros:

- Torghut is closest to TCA, market context, hypothesis, and proof-floor state.
- Faster implementation inside the trading service.
- Less Jangar trading-specific code.

Cons:

- Torghut should not grant itself control-plane dispatch or rollout authority.
- It cannot see Agents schedule debt, Jangar watch reliability, runtime kits, or deployment health with the same
  authority as Jangar.
- Deployer gates would still need to join Torghut and Jangar evidence by hand.

Decision: reject as the authority layer. Torghut should price repairs; Jangar should admit them.

### Option C: Add A Jangar Repair Warrant Exchange

Pros:

- Converts repair facts into bounded, zero-notional work authorizations.
- Gives every repair a source epoch, expiry, validation command, and closure receipt.
- Lets Jangar throttle repeated schedules without blocking read-only serving or normal healthy dispatch.
- Gives Torghut a measurable route from observe to paper without weakening live guards.
- Preserves least privilege because the contract uses typed routes and status projections.

Cons:

- Adds another status section and fixture set.
- Requires careful timeout and cache budgets so Torghut proof routes do not slow Jangar serving.
- Requires the companion Torghut repair dividend object to be stable enough for Jangar to trust.

Decision: select Option C.

## Architecture

Jangar adds a `repair_warrant_exchange` reducer outside `control-plane-empirical-services.ts`.

```text
repair_warrant_exchange
  generated_at
  namespace
  status
  schedule_debt_window
  active_warrants[]
  closed_warrants[]
  expired_warrants[]
  suppressed_candidates[]
```

Each active warrant has:

```text
repair_warrant
  warrant_id
  source_epoch_id
  source_budget_id
  repair_code
  repair_dimension
  account_label
  torghut_revision
  action_class
  admission_state
  max_dispatches
  max_runtime_seconds
  max_notional
  expected_unblock_value
  risk_tier
  fresh_until
  owner_lane
  validation_refs[]
  closure_requirements[]
  rollback_target
```

The initial repair dimensions are:

- `execution_tca`: recompute or invalidate stale TCA and produce a fresh TCA receipt.
- `market_context`: refresh domains or record a closed-session deferral receipt.
- `quant_ingestion`: reduce live ingestion lag below the configured stage budget.
- `quant_materialization`: restore materialization freshness for live latest metrics.
- `quant_latest_store`: restore simulation latest metrics and stage rows.
- `alpha_readiness`: clear hypothesis blockers only after the required data receipts are current.
- `forecast_registry`: load a calibrated forecast registry before it can be used for promotion.

The schedule debt firebreak computes a debt window per schedule lane:

- A later successful job with the same schedule lane, source branch, image, and objective supersedes earlier errors in
  the same window.
- If errors outnumber successful completions for the same lane by more than `2` inside four hours, Jangar downgrades
  new repair candidates to `observe_only`.
- If current deployment readiness is timing out, Jangar admits only one repair warrant per namespace.
- If watch reliability becomes degraded, Jangar expires active non-critical warrants and preserves read-only serving.

## Validation Gates

Engineer acceptance gates:

- Add a pure reducer for `repair_warrant_exchange`; do not grow `control-plane-status.ts` with business logic.
- Add fixtures for healthy control plane with Torghut proof-floor blockers, schedule error netting, degraded watch,
  RBAC-blocked CNPG, stale live TCA, empty simulation quant latest store, and fresh empirical jobs.
- Unit tests must prove that `torghut_observe` remains allowed, `paper_canary` remains closed until the warrant closes,
  and live gates remain held or blocked.
- Add tests showing that a later successful schedule run supersedes earlier errors only when the schedule lane, image,
  branch, and objective match.
- Expose warrant IDs in status and material-action verdict evidence refs.

Deployer acceptance gates:

- Do not widen paper or live capital from a repair warrant alone.
- Before paper, require a closed warrant, fresh observation epoch, Torghut proof floor not `repair_only`, current TCA,
  current market context when required, current quant stages, and at least one promotion-eligible hypothesis.
- Before live micro, require a prior paper settlement epoch and live submit still disabled until the live guard opens.
- Before live scale, require live micro settlement, expected shortfall coverage, and no rollback-required hypothesis.
- Roll back by disabling warrant enforcement and returning to dependency quorum plus action SLO budgets.

Suggested local validation:

```bash
bun --cwd services/jangar run test -- src/server/__tests__/control-plane-status.test.ts src/server/__tests__/control-plane-material-action-verdict.test.ts src/server/__tests__/control-plane-negative-evidence-router.test.ts
bun --cwd services/jangar run lint
```

## Rollout

Roll out in three phases:

1. `observe`: compute warrants and suppressed candidates, but do not affect dispatch.
2. `admit-zero-notional`: let schedules use active warrants for zero-notional repair only.
3. `gate-paper`: require closed warrant evidence before paper can move out of `shadow_only`.

No phase changes live capital. Live remains governed by paper settlement and expected shortfall gates.

## Rollback

Rollback is to disable warrant enforcement and keep the current dependency quorum, negative evidence router, action
SLO budgets, and material-action verdicts. Existing warrants become informational. No database record, Kubernetes
object, or broker state should need manual mutation for rollback.

## Risks

- A warrant exchange can become another stale surface. Mitigation: every warrant has `fresh_until` and an explicit
  `expired` state.
- Torghut repair dividends can overstate value. Mitigation: Jangar treats expected value as priority, not authority.
- Schedule netting can hide a real recurring failure. Mitigation: net only when lane, image, branch, and objective
  match, and preserve the raw Kubernetes events.
- Paper could be widened from a closed repair that fixes only one blocker. Mitigation: paper requires a clean
  observation epoch, not a single closed warrant.

## Handoff

Engineer handoff: build the Jangar warrant reducer, status projection, material-action evidence refs, and schedule
debt netting tests. Keep Torghut-specific scoring in the companion Torghut dividend object and keep Jangar authority
focused on admission, expiry, throttling, and closure.

Deployer handoff: treat active warrants as repair permission only. Treat closed warrants as one input into paper
readiness, never as sufficient capital authority. Preserve zero-notional live state until paper settlement, live submit
gate, expected shortfall, and rollback posture all agree.
