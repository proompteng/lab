# 141. Jangar Controller Witness Escrow And Repair Dividend Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar controller witness reliability, bounded repair authority, action-state graduation, Torghut capital
consumption, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md`

Extends:

- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`
- `136-jangar-controller-authority-settlement-and-endpoint-parity-ledger-2026-05-07.md`
- `133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting **controller witness escrow with repair dividend settlement** as the next Jangar control-plane
architecture step.

The current production state is not a binary outage. At `2026-05-07T10:08Z`, Jangar `/ready` returned `status=ok`,
runtime kits were healthy, execution trust was healthy, and the database was connected with `28` registered migrations,
`28` applied migrations, no unapplied migrations, no unexpected migrations, and `13` ms database latency. The controllers
deployment was available with `2/2` controller pods and leader election had a holder.

The residual risk is that rollout health can still be read as stronger evidence than it is. The control-plane status
route derived agents-controller and supporting-controller health from the available `agents-controllers` rollout, while
`agentrun_ingestion.status=unknown`, `agentrun_ingestion.message="agents controller not started"`, and
`watch_reliability.status=degraded` with `2,764` events, `4` errors, and `8` restarts in the latest 15 minute window.
Kubernetes events also showed recent readiness and liveness probe failures for the serving and controller pods, followed
by restart and recovery. That is acceptable for serving; it is not enough evidence for normal dispatch, merge-ready,
deploy widening, or any downstream capital action.

The selected design turns repair work into a first-class settlement product. Jangar may issue short-lived repair leases
when negative evidence is present, but each lease must name the witness gap it is expected to reduce, the action class it
can graduate, the maximum launch cost it may spend, and the concrete settlement evidence required before any higher
authority moves.

The tradeoff is stricter accounting for repair work. I accept that. We should not block the system from repairing
itself, but we also should not let "repair happened" become a substitute for "the failing witness recovered."

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps serving read-only traffic when runtime kits, leader election, and database projection are healthy.
- `dispatch_repair` remains available during degraded watch windows, but only through repair leases with bounded
  dispatch count, runtime, and freshness windows.
- `dispatch_normal`, `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` require
  settled repair dividends when their prior hold/block reason was watch reliability, AgentRun ingestion, route probe,
  controller heartbeat, or Torghut consumer evidence.
- A repair dividend is not accepted until the degraded witness improves in the source surface, not just in the repair
  job log.
- The control-plane status route exposes the current escrow state, open repair leases, retired dividends, and blocked
  graduation targets.
- Torghut can cite Jangar repair dividend receipts directly when ranking proof repairs and capital reentry.
- Deployer rollback can shadow the escrow without removing the underlying negative evidence and action clocks.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker state,
trading flags, AgentRun records, or empirical artifacts.

### NATS Context

The shared NATS soak still contained the May 5 baseline: Jangar serving was up while execution trust and stage evidence
were degraded, scheduled swarm jobs had failed from a Bun inline import parse error, workspace PVC watching was failing,
and Torghut had healthy schema checks but stale market-context domains. I treated that as historical context and
rechecked the current runtime state before writing this contract.

### Cluster, Rollout, And Event Evidence

- `kubectl -n agents get deploy,pods,svc,job,cronjob,lease -o wide` showed `deployment/agents` available `1/1`,
  `deployment/agents-controllers` available `2/2`, and `lease/jangar-controller-leader` held.
- Current Jangar images were `registry.ide-newton.ts.net/lab/jangar-control-plane:f0ab857e` for the serving deployment
  and `registry.ide-newton.ts.net/lab/jangar:f0ab857e` for controllers and schedule runners.
- Recent scheduled swarm cron jobs for discover, plan, implement, verify, and Torghut quant stages completed on the
  current image; older cron attempts from about six hours earlier remained failed. This indicates the inline import
  failure is no longer the active top risk, but historical job errors still matter to the repair ledger.
- Kubernetes events showed a normal rollout about 20 minutes before assessment, followed by transient readiness probe
  failures for old pods, readiness timeouts for both controller pods, one controller liveness failure, controller
  container restart, and a serving readiness timeout.
- Active AgentRuns existed for this discover lane, implement lane, verify lane, and Torghut quant verify lane, while
  most scheduled runs from the last day had completed successfully.

### Jangar Endpoint And Database Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`.
- `/ready` reported execution trust healthy, memory provider healthy, runtime kits healthy, and fresh admission
  passports for serving, swarm plan, swarm implement, and swarm verify.
- `GET /api/agents/control-plane/status` returned `generated_at=2026-05-07T10:08:27.698Z`.
- Database status was `configured=true`, `connected=true`, `status=healthy`, `latency_ms=13`.
- Migration consistency was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`, and latest registered/applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was degraded with `window_minutes=15`, `observed_streams=5`, `total_events=2764`,
  `total_errors=4`, and `total_restarts=8`.
- The degraded watch streams included AgentRuns, ImplementationSpecs, Agents, ImplementationSources, and
  VersionControlProviders.
- AgentRun ingestion was `unknown` with message `agents controller not started`, even while agents-controller rollout
  status was presented as healthy through rollout-derived authority.
- Material action receipts allowed `serve_readonly` and `torghut_observe`, allowed bounded `dispatch_repair`, held
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked live capital actions.
- Direct secret and database access was unavailable from this service account: listing Kubernetes secrets in `agents`
  was forbidden. The database assessment therefore uses the typed Jangar status route and source schema artifacts.

### Torghut Consumer Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned HTTP `503` with `status=degraded`.
- Torghut dependencies were not uniformly broken: Postgres, ClickHouse, Alpaca, universe, readiness cache, empirical
  jobs, and DSPy informational checks were reachable.
- Live submission was blocked by `simple_submit_disabled` with `capital_stage=shadow`.
- Profitability proof floor was `repair_only`, `capital_state=zero_notional`, with blocking reasons
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Quant evidence was informationally degraded because ingestion lag was stale: latest metrics were current, but max
  stage lag was `59069` seconds and ingestion was not OK.
- TCA was stale from `2026-04-02T20:59:45.136640Z`, average absolute slippage was about `568.61` bps, and the guardrail
  was `8` bps.
- Forecast authority was blocked by `registry_empty`, while LEAN remained `disabled` as a deterministic scaffold.
- Hypotheses were loaded, but all three capital multipliers were `0`, zero hypotheses were promotion eligible, and all
  three required rollback.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation boundary for controller status, database
  status, runtime adapters, watch reliability, execution trust, empirical services, failure-domain leases, runtime
  admission, negative evidence, and action receipts.
- `services/jangar/src/server/control-plane-status.ts` already accepts dependency injection for
  `getWatchReliabilitySummary`, `checkDatabase`, `resolveExecutionTrust`, `resolveEmpiricalServices`, route probes, and
  Kubernetes evidence. That makes a repair escrow reducer testable without live cluster dependencies.
- `services/jangar/src/server/control-plane-watch-reliability.ts` records events, errors, restarts, and top streams in a
  process-local window. It can explain why watch reliability is degraded, but it does not attach recovery to repair
  dividends.
- `services/jangar/src/server/agents-controller/index.ts` already tracks AgentRun ingestion stalls and recovery with
  untouched run counts, watch events, resyncs, and two healthy resyncs before recovery.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already maps watch reliability, AgentRun
  ingestion, Torghut consumer evidence, forecast degradation, and workflow failures into negative evidence and material
  action consequences.
- Focused tests exist for control-plane status, action clocks, controller witness, negative evidence, watch reliability,
  and AgentRun ingestion. The missing test fixture is a repair dividend lifecycle that starts from a degraded witness,
  permits only bounded repair, and graduates the action state only after the witness source recovers.

## Problem

Jangar now has enough status shape to separate serving from material action, but it still lacks a settlement loop for
repair work.

Today the system can say "watch reliability degraded" and "dispatch repair allowed." That is a good start. What it does
not yet say is:

- which exact witness a repair is allowed to spend launch capacity on;
- what action class that repair is expected to graduate;
- how much runtime cost the repair may consume;
- what evidence retires the repair lease;
- what happens if the repair job succeeds but the degraded witness does not recover;
- how Torghut should value a Jangar repair when deciding whether paper or live capital can move later.

Without that loop, repair work can become another unpriced queue. It may improve reliability, or it may only produce
logs. The control plane needs to account for the difference.

## Alternatives Considered

### Option A: Freeze Normal And Repair Dispatch Until Watch Reliability Is Healthy

Pros:

- Safest for material actions.
- Easy to reason about during an incident.
- Avoids spending capacity while controller watches are noisy.

Cons:

- Prevents the exact repair work needed to restore the degraded witness.
- Turns every watch error into a human-operated incident.
- Wastes the current state where serving, database, runtime kits, and observe paths are healthy enough for bounded
  repair.

Decision: reject.

### Option B: Keep Current Action Receipts Without Repair Settlement

Pros:

- Uses the existing material action receipts and negative evidence router.
- Avoids another status payload.
- Keeps implementation smaller.

Cons:

- Allows repair work without measuring whether it reduced the named negative evidence.
- Leaves deployer and Torghut consumers to infer repair value from logs, PRs, and status fragments.
- Does not create a durable handoff between repair dispatch and action-class graduation.

Decision: reject as the complete architecture.

### Option C: Controller Witness Escrow And Repair Dividend Settlement

Pros:

- Keeps serve and observe available while bounding repair work.
- Converts negative evidence into explicit repair leases with cost caps and expiry.
- Requires source-witness recovery before action classes graduate.
- Gives deployer and Torghut one receipt to cite for repair impact.
- Preserves simple rollback: shadow the escrow, keep material actions held, and leave status visible.

Cons:

- Adds a new reducer and fixture set to the control-plane status path.
- Requires careful scoring so repair leases do not starve normal work after recovery.
- Requires engineers to define settlement evidence, not only a repair command.

Decision: select Option C.

## Architecture

Jangar emits one controller witness escrow per namespace and status window.

```text
controller_witness_escrow
  escrow_id
  namespace
  generated_at
  fresh_until
  source_status_ref
  database_projection_ref
  controller_rollout_ref
  controller_heartbeat_ref
  agentrun_ingestion_ref
  watch_epoch_ref
  route_probe_ref
  torghut_consumer_ref
  open_repair_leases[]
  retired_repair_dividends[]
  action_graduation_state[]
```

A repair lease is short-lived and explicit.

```text
repair_lease
  lease_id
  issued_at
  expires_at
  negative_evidence_refs[]
  target_witness
  target_action_class
  max_dispatches
  max_runtime_seconds
  allowed_commands[]
  settlement_gate
  rollback_target
```

A repair dividend is accepted only when the source witness improves.

```text
repair_dividend
  dividend_id
  lease_id
  settled_at
  source_witness_before
  source_witness_after
  action_state_before
  action_state_after
  accepted
  rejection_reason
  evidence_refs[]
```

The first implementation should support five witness classes:

- `watch_reliability`: error and restart counters must return below configured thresholds for two consecutive status
  windows.
- `agentrun_ingestion`: AgentRun ingestion must move from unknown/degraded to healthy and include a fresh watch or
  resync timestamp.
- `route_probe`: serving or consumer route must return expected status with bounded latency for two consecutive probes.
- `database_projection`: database must remain connected with zero unapplied/unexpected migrations.
- `torghut_consumer`: Torghut must provide a fresh health/status/autonomy proof bundle for the relevant capital action.

## Action Graduation Rules

- `serve_readonly`: can stay allowed while escrow is degraded if serving runtime kit, database projection, and route
  probe are healthy.
- `torghut_observe`: can stay allowed while escrow is degraded if it is zero-notional and does not require paper/live
  submission.
- `dispatch_repair`: can be allowed with a repair lease when at least one repairable witness has a settlement gate.
- `dispatch_normal`: must hold until all open repair leases affecting dispatch are retired or expired, and watch plus
  ingestion witnesses are current.
- `merge_ready`: must hold while any deploy, schema, route, or source-schema witness has unsettled negative evidence.
- `deploy_widen`: must hold while watch reliability or route probes are degraded.
- `paper_canary`: must hold until Torghut consumer evidence, Jangar escrow, and proof-floor gates agree.
- `live_micro_canary` and `live_scale`: must block until paper settlement and all capital witnesses are fresh.

## Engineer Handoff

Implementation should be staged in four patches.

1. Add `control-plane-repair-dividend.ts` with pure reducers for escrow, leases, dividends, and action graduation.
2. Add fixtures in `services/jangar/src/server/__tests__/control-plane-repair-dividend.test.ts` for watch degradation,
   AgentRun ingestion unknown, route probe failure, database projection healthy, and Torghut consumer missing.
3. Wire the reducer into `buildControlPlaneStatus` behind `JANGAR_CONTROL_PLANE_REPAIR_DIVIDEND_ENFORCEMENT=shadow`.
4. Add a compact UI section and status type updates only after the reducer payload is stable.

Acceptance gates:

- A degraded watch window can issue only `dispatch_repair` leases, not `dispatch_normal`.
- A succeeded repair job without source-witness recovery produces a rejected dividend.
- Two fresh witness windows retire the lease and allow the action class to graduate.
- Expired leases hold the target action class and require a new lease rather than silently passing.
- Unit tests cover all five witness classes.

## Deployer Handoff

Rollout should stay shadow-first.

1. Deploy with enforcement set to `shadow`.
2. Confirm `/api/agents/control-plane/status?namespace=agents` includes escrow payloads without changing existing
   material action decisions.
3. Trigger or wait for a watch degradation window and verify repair leases are emitted with expiry and settlement gates.
4. Promote to enforcement only after two successful shadow windows where accepted dividends match actual witness
   recovery.
5. Keep live capital action classes blocked until Torghut consumes the paired repair dividend ledger.

Rollback:

- Set `JANGAR_CONTROL_PLANE_REPAIR_DIVIDEND_ENFORCEMENT=shadow` to stop enforcement while preserving evidence.
- Set `JANGAR_CONTROL_PLANE_REPAIR_DIVIDEND_ENABLED=false` only if the payload itself breaks status consumers.
- Do not disable runtime admission, proof-surface checks, or material action receipts as part of this rollback.

## Validation

Local validation:

- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-repair-dividend.test.ts`
- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-status.test.ts -t repair`
- `bun --cwd services/jangar run tsc`
- `bunx oxfmt --check docs/agents/designs/141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`

Cluster validation after deploy:

- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.controller_witness_escrow'`
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.material_action_activation_receipts[] | {action_class,decision,required_repairs}'`
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -80`
- `kubectl -n agents logs deployment/agents-controllers --tail=200 | rg 'repair_dividend|agentrun_ingestion|watch_reliability'`

## Risks

- Repair leases could become noisy if every transient watch restart gets a lease. Mitigation: require action-class
  impact and cap open leases by witness class.
- A repair dividend could accept source recovery caused by unrelated work. Mitigation: record before/after witness
  digests and settlement window; treat correlation as operational evidence, not proof of causality.
- Too much strictness could delay benign dispatch. Mitigation: keep serve, observe, and bounded repair independent from
  normal dispatch and capital authority.
- Torghut may consume the escrow before its own proof floor is ready. Mitigation: companion contract keeps paper and
  live capital at zero notional until TCA, quant ingestion, forecast, hypothesis, and submission gates agree.

## Summary For Engineer And Deployer

The next implementation should not add another broad "healthy/degraded" flag. It should add a settlement loop. Jangar
can let repair work run under degraded evidence, but only if that work carries a lease, names the witness it will fix,
and earns a dividend from source-witness recovery before higher authority graduates.
