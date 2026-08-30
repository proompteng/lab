# 145. Jangar Observation Epoch Tripwire And Capital Contradiction Arbiter (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane reliability, Torghut capital admission, evidence-clock convergence, rollout safety,
validation, rollback, and engineer/deployer handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/149-torghut-profit-evidence-convergence-epochs-and-quant-stage-arbitrage-2026-05-07.md`

Extends:

- `144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`
- `143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `docs/torghut/design-system/v6/148-torghut-profit-evidence-reactivation-scheduler-and-paper-gate-receipts-2026-05-07.md`

## Decision

I am selecting **a Jangar observation epoch tripwire with a capital contradiction arbiter** as the next control-plane
architecture step.

The evidence says Jangar has recovered enough to serve, but not enough to trust mixed-clock capital evidence. At
`2026-05-07T12:12Z`, `deployment/jangar` was `1/1`, `deployment/agents-controllers` was `2/2`, runtime kits were
healthy, execution trust was healthy, database projection was healthy, and the collaboration runtime finally included
`/usr/local/bin/nats`. The same window still showed recent readiness probe timeouts on Jangar, Agents, and Torghut
rollouts, failed hourly schedule jobs next to successful retries, and a watch-reliability restart in the current 15
minute window.

The stronger finding is a capital-evidence contradiction. Torghut `/db-check` is now schema-current, empirical jobs
are fresh, and quant latest metrics are current. But direct Jangar quant health shows the ingestion stage lagging
`66,462` seconds, Torghut TCA is `2,992,365` seconds stale, market context has no fresh timestamp, signal continuity
has an active `cursor_ahead_of_stream` alert, and no hypothesis is promotion eligible. Jangar already holds paper and
live capital, but the blocking reason is still too coarse: `torghut_consumer_evidence_missing` plus
`forecast_service_degraded`.

The design makes Jangar the owner of a same-epoch tripwire. Every material action reads one `observation_epoch` that
joins controller health, rollout health, database projection, watch reliability, Torghut status, Torghut health,
Jangar quant stage health, market-context freshness, TCA freshness, empirical job truth, and hypothesis readiness. If
any current receipt contradicts another receipt, Jangar allows read-only serving and zero-notional repair, but it holds
paper and blocks live until the contradiction is retired in a newer epoch.

The tradeoff is that paper remains closed even when one proof surface looks good. I accept that. Fresh empirical jobs
without current ingestion, market context, TCA, and hypothesis readiness can improve research confidence, but they do
not justify capital.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes one `capital_observation_epoch` per namespace, Torghut account, Torghut revision, and market
  window.
- Each epoch has a stable `epoch_id`, `observed_at`, `fresh_until`, source route hashes, source status codes, and
  per-source freshness ages.
- The epoch includes receipt states for Jangar controller, rollout, database, watch reliability, runtime admission,
  Torghut health, Torghut status, Torghut db-check, quant latest-store, quant stages, market context, execution TCA,
  empirical jobs, forecast registry, and hypothesis readiness.
- Jangar emits explicit contradiction codes instead of one generic Torghut consumer-evidence blocker.
- `serve_readonly`, `dispatch_repair`, `dispatch_normal`, and `torghut_observe` can continue when contradictions are
  non-capital or repair-scoped.
- `paper_canary` requires a contradiction-free epoch with current Torghut proof floor, current quant stages, current
  TCA, current market context, at least one promotion-eligible hypothesis, and no active signal-continuity alert.
- `live_micro_canary` additionally requires paper settlement from a prior clean epoch.
- `live_scale` additionally requires live micro expected shortfall coverage and no open rollback-required hypothesis.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- Local branch `codex/swarm-torghut-quant-discover` was at fresh `main` commit `ef36fad05`.
- The in-cluster identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar` showed `jangar-98f54c787-xwwzs` `2/2 Running` on image
  `registry.ide-newton.ts.net/lab/jangar:817b46ca@sha256:729353bc...`.
- `kubectl get pods -n agents` showed `agents-controllers-77bbbc7799-2m7zc` and
  `agents-controllers-77bbbc7799-s8swj` both `1/1 Running`.
- Recent Agents events still showed readiness probe timeouts against both new controller pods and the API pod.
- Recent Jangar events showed the new `817b46ca` pod became ready after an initial readiness refusal on `/health`.
- Recent Torghut events showed successful revision creation for `torghut-00256` and `torghut-sim-00356`, with startup
  and readiness timeouts before readiness.
- The hourly schedule lane is not clean: failed schedule jobs remain in history next to successful retries for Jangar
  control-plane and Torghut quant discover/plan/implement/verify stages.
- RBAC blocks some direct verification: this service account cannot list Torghut Knative services, CNPG CRDs, PDBs,
  FlinkDeployment CRDs, or Jangar StatefulSets.

### Jangar Control-Plane Evidence

- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200.
- Leader election was enabled, required, and leader-held by `jangar-98f54c787-xwwzs`.
- `agents-controller`, `supporting-controller`, and `orchestration-controller` were healthy from authoritative
  heartbeat rows.
- Workflow, job, and Temporal runtime adapters were configured.
- Database projection was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy overall with `1,539` AgentRun events, `0` errors, and `1` restart in the current 15
  minute window.
- Runtime kit collaboration was healthy and included `codex-nats-publish`, `codex-nats-soak`, `nats`, the Jangar
  workspace path, and `NATS_URL`.
- Material action receipts allowed read-only, repair, normal dispatch, deploy widen, merge ready, and observe, while
  holding paper and live micro and blocking live scale.

### Torghut And Data Evidence

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200.
- `GET http://torghut.torghut.svc.cluster.local/db-check` returned HTTP 200 with current head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, branch count `1`, and parent-fork warnings for the two
  historic migration forks.
- Direct CNPG psql was RBAC-blocked because `pods/exec` is forbidden in namespace `torghut`.
- Direct CNPG cluster, backup, and scheduled backup listing was RBAC-blocked.
- `GET /trading/health` returned HTTP 503 with `status=degraded`.
- `GET /trading/status` returned HTTP 200 with active revision `torghut-00256`, build commit
  `81b8231d014c94dc2c70173f35fb53bb279749cf`, `mode=live`, `pipeline_mode=simple`, and `submit_enabled=false`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, `capital_stage=shadow`.
- Proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Proof blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- Execution TCA had `13,775` orders, `avg_abs_slippage_bps=568.6138848199565249`, an `8` bps slippage guardrail, and
  `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Signal continuity had an active alert for `cursor_ahead_of_stream`; feature-quality rejects included
  `feature_staleness_exceeds_budget=65`.
- Empirical jobs were fresh and truthful for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, all on candidate `chip-paper-microbar-composite@execution-proof`.
- Direct Jangar quant health reported `latestMetricsCount=144`, `latestMetricsUpdatedAt=2026-05-07T12:12:30.445Z`,
  and three stage rows. The compute stage was healthy, materialization was not healthy, and ingestion lag was
  `66,462` seconds.
- Forecast registry remained `registry_empty`, with authority blocked.
- Alpha readiness had `3` hypotheses, all in `shadow`, `0` promotion eligible, and `3` rollback required.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation boundary for controller, runtime, database,
  watch, execution-trust, empirical-services, action-clock, verdict, and runtime-admission evidence.
- `services/jangar/src/server/control-plane-empirical-services.ts` reduces Torghut `/trading/status` into forecast,
  LEAN, and empirical job status. It does not reduce proof floor, signal continuity, TCA age, quant stage lag, or
  hypothesis promotion into a single epoch.
- `services/jangar/src/server/control-plane-action-clock.ts` has a `torghut_capital` action class, but its Torghut
  consumer debt currently derives from empirical service summaries.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` merges dependency quorum, SLO budgets, and
  action clocks, but capital contradiction reasons are still inherited from coarse inputs.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already has tests for degraded Torghut
  readiness, stale market context, quant alerts, and rollout ambiguity. That is the right place to keep repair
  admission conservative while the new epoch reducer feeds paper/live verdicts.

## Problem

Jangar has enough control-plane health to admit ordinary work, but paper and live capital are still unsafe because
evidence clocks do not agree.

The failure modes are:

1. A healthy database projection and a healthy `/db-check` can coexist with stale TCA, stale market context, and
   stale signal features.
2. Jangar direct quant health can see stage lag while Torghut status treats quant evidence as non-blocking or
   informational.
3. Fresh empirical jobs can coexist with zero promotion-eligible hypotheses.
4. Schedule jobs can fail and then succeed, leaving operators to infer whether the latest success superseded the
   failed attempt.
5. Capital action receipts hold paper correctly, but the reason is too coarse to drive repair automation.

## Alternatives Considered

### Option A: Continue With Generic Torghut Consumer Evidence Holds

Pros:

- Minimal new implementation.
- Keeps existing material-action receipts stable.
- Avoids another reducer in the control-plane status path.

Cons:

- Keeps repair work vague.
- Hides whether the current hold is from forecast, quant stage, TCA, market context, signal continuity, or hypothesis
  readiness.
- Makes schedule retries hard to audit because the reason space does not point to the stale source.

Decision: reject.

### Option B: Let Torghut Own All Capital Contradiction Logic

Pros:

- Torghut is closest to trading state.
- Reduces Jangar trading-specific code.
- Keeps hypothesis and proof-floor logic in Python.

Cons:

- Loses Jangar's cross-plane view of controller health, rollout stability, runtime-kit admission, schedule retry
  history, and watch reliability.
- Forces deployers to manually reconcile Jangar route health and Torghut capital state before rollout.
- Makes paper/live admission depend on one service's view of its own dependencies.

Decision: reject.

### Option C: Add Jangar Observation Epoch Tripwires

Pros:

- Produces a single capital evidence object for material action verdicts.
- Keeps Torghut as producer of trading proof while letting Jangar arbitrate cross-plane contradictions.
- Converts generic capital holds into concrete repair reasons.
- Works under least-privilege validation because it uses typed routes and Kubernetes object evidence.
- Preserves read-only and zero-notional repair while making paper and live stricter.

Cons:

- Adds a new reducer and fixture set to Jangar.
- Requires careful timeout budgets so a slow Torghut route does not degrade Jangar serving.
- Requires Torghut to expose stable receipt fields for the companion epoch contract.

Decision: select Option C.

## Architecture

Jangar adds a capital observation epoch reducer.

```text
capital_observation_epoch
  epoch_id
  observed_at
  fresh_until
  namespace
  account_label
  torghut_revision
  market_window
  route_receipts[]
  data_receipts[]
  quant_stage_receipts[]
  trading_receipts[]
  contradiction_codes[]
  allowed_action_floor
  required_repairs[]
  rollback_target
```

The reducer reads existing surfaces first:

- Jangar control-plane status internals for leader, controller, runtime, database, watch, rollout, and execution trust.
- Torghut `/healthz`, `/db-check`, `/trading/health`, and `/trading/status`.
- Jangar `/api/torghut/trading/control-plane/quant/health`.
- Existing material-action SLO budgets and action clocks.

The first implementation should be additive:

- Add `observation_epoch` to Jangar control-plane status.
- Add `observation_epoch_ref` and `capital_contradiction_codes` to `paper_canary`, `live_micro_canary`, and
  `live_scale` material-action verdicts.
- Keep existing action decisions unchanged until fixture coverage proves parity.
- Then move paper/live reason generation from generic consumer evidence to epoch contradiction codes.

Contradiction codes must be explicit:

- `quant_stage_ingestion_lagged`
- `quant_stage_materialization_lagged`
- `torghut_quant_status_nonblocking_but_jangar_stage_lagged`
- `tca_evidence_stale`
- `market_context_stale`
- `signal_continuity_alert_active`
- `forecast_registry_empty`
- `hypothesis_promotion_absent`
- `schedule_retry_not_settled`
- `db_schema_current_but_capital_data_stale`

## Validation Gates

Engineer gates:

- Unit tests for the epoch reducer covering the `2026-05-07T12:12Z` evidence shape.
- Fixture where fresh empirical jobs plus stale TCA still holds paper.
- Fixture where Torghut quant evidence is informational but Jangar quant ingestion stage is lagged, producing
  `torghut_quant_status_nonblocking_but_jangar_stage_lagged`.
- Fixture where schedule retries have a newer success, producing no `schedule_retry_not_settled`.
- `bun run --filter @proompteng/jangar test -- control-plane-observation-epoch`.
- `bunx oxfmt --check services/jangar docs/agents/designs`.

Deployer gates:

- `kubectl get deploy -n jangar` shows `jangar` available.
- `kubectl get deploy -n agents` shows `agents-controllers` available.
- Jangar status returns HTTP 200 and includes `observation_epoch`.
- `paper_canary` remains `hold` while any capital contradiction code is present.
- `torghut_observe` and `dispatch_repair` remain allowed when only zero-notional repair contradictions exist.
- NATS/Jangar progress updates cite the epoch id and contradiction codes, not raw JSON payloads.

## Rollout

1. Ship the reducer in shadow mode and log epoch ids plus contradiction codes.
2. Add the epoch block to the control-plane status payload behind a feature flag.
3. Enable material-action verdict references to the epoch while keeping existing decisions as the authority.
4. Compare verdict parity for at least three hourly schedule windows.
5. Make epoch contradictions authoritative for paper/live holds only.
6. Later, allow epoch cleanliness to release paper canary when Torghut companion receipts pass.

## Rollback

Rollback is simple and must stay simple:

- Disable the epoch feature flag.
- Remove epoch-derived contradiction codes from material-action verdicts.
- Fall back to existing action clocks and generic consumer-evidence holds.
- Keep `paper_canary`, `live_micro_canary`, and `live_scale` at zero notional until a newer clean epoch is present.

## Risks

- A too-aggressive timeout could mark a slow route as a contradiction during normal load. Mitigation: preserve
  read-only serving and repair, and require repeated capital contradictions before escalation.
- The first reducer can become another large status aggregator. Mitigation: implement it as a separate module with
  fixtures, not inside `control-plane-status.ts`.
- Direct DB and CNPG validation remains RBAC-blocked for this runner. Mitigation: the deployer contract uses typed
  routes and allowed Kubernetes objects, while platform owners can add privileged audit checks separately.

## Handoff

Engineer:

- Own `services/jangar/src/server/control-plane-observation-epoch.ts` and companion tests.
- Do not put the reducer directly into `control-plane-status.ts`; import it.
- Keep the first release additive and fixture-driven.
- Preserve current decisions until parity is proven, then make epoch contradictions authoritative for paper/live only.

Deployer:

- Validate the epoch from Jangar status after rollout.
- Keep paper/live blocked while any capital contradiction is present.
- Use Torghut companion receipts to clear contradictions.
- Roll back by disabling the epoch feature flag and keeping zero-notional capital.
