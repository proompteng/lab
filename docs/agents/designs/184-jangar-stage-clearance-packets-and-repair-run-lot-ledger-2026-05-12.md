# 184. Jangar Stage-Clearance Packets And Repair-Run Lot Ledger (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, failed AgentRun reduction, stage-clearance emission, repair-run admission,
Torghut capital safety, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-stage-clearance-consumer-and-repair-lot-broker-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-routeability-cutover-backpressure-and-proof-run-admission-2026-05-08.md`
- `169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `../torghut/design-system/v6/187-torghut-profit-window-custody-and-repair-value-market-2026-05-08.md`

## Decision

I am selecting **stage-clearance packets with a repair-run lot ledger** as the next Jangar control-plane architecture
step.

The May 12 live evidence shows that the broad custody direction is right, but the deployable bridge is still missing.
Jangar and agents are serving, Argo reports `agents`, `agents-ci`, and `jangar` as `Synced/Healthy` at revision
`32564cef018d608a7928c80240a70d35f75c5b25`, and the agents deployments are ready. The same control-plane status says
`execution_trust.status=degraded` because the `jangar-control-plane` swarm is frozen for `StageStaleness`; material
action verdicts allow `serve_readonly` and `torghut_observe` but hold `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, and `merge_ready`; `ready_action_exchange` and `stage_clearance_packet` are not emitted; the summary
projection counts `630` AgentRuns with `105` failed; and direct database or secret reads are forbidden to this runner.

Torghut has the sharper capital risk. Argo reports `torghut` as `Degraded` and `torghut-options` as `Progressing`.
The namespace has four current `ImagePullBackOff` pods for Torghut websocket and TA images. Torghut `/healthz` returns
HTTP 200, but `/readyz` is degraded. The live submission gate is blocked by `simple_submit_disabled`, the profitability
proof floor is `repair_only` with `max_notional=0`, empirical jobs are stale, quant latest metrics are current while
ingestion lags are hundreds of thousands of seconds for several strategies, and the consumer-evidence route returns a
current repair receipt.

The important source finding is specific: Torghut already contains code and tests that look for a Jangar
`stage_clearance_packet`, but Jangar does not emit it. This is no longer a naming problem. It is a control-plane
contract gap that lets schedules keep launching and lets Torghut keep interpreting missing clearance as another
readiness blocker instead of a bounded repair market.

The decision is to make Jangar emit a versioned `stage_clearance_packet` for each swarm stage and action class, backed
by a `repair_run_lot` ledger. A scheduled or manual AgentRun must cite either a current clearance packet or a specific
repair lot with bounded runtime, zero notional, and expected value-gate movement. The packet is the deployable form of
the action custody work: it does not replace material action verdicts, source rollout truth, controller witness, or
Torghut proof receipts. It binds them into the one object that stages and consumers already need.

The tradeoff is less permissive scheduling. Some diagnostic work that currently launches will wait until it can name a
lot and a value gate. I accept that because the business metric is fewer failed AgentRuns and faster green
PR-to-healthy GitOps rollout diagnosis, not raw dispatch count.

## Evidence Snapshot

All evidence below was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, database rows, GitOps
resources, trading flags, broker state, or AgentRun objects.

### Cluster And Rollout

- `kubectl auth whoami` used `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset.
- Argo CD reported `agents`, `agents-ci`, `jangar`, `symphony`, `symphony-jangar`, and `symphony-torghut` as
  `Synced/Healthy` at revision `32564cef018d608a7928c80240a70d35f75c5b25`.
- Argo reported `torghut` as `Synced/Degraded` at the same revision and `torghut-options` as
  `Synced/Progressing` at revision `d875cca7addce4a02afd5bb005b26636960f8c35`.
- Agents namespace pod phases were `34 Running`, `18 Completed`, and `20 Error`; the Jangar namespace had
  `8 Running`; Torghut had `17 Running` and `4 ImagePullBackOff`.
- `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and `deployment/jangar` was `1/1`.
- Torghut current failures included `torghut-ws`, `torghut-ws-options`, `torghut-options-ta`, and `torghut-ta-sim`
  in image-pull backoff.
- Recent agents events showed many current schedule-runner and AgentRun pods being created successfully, which means
  dispatch continues even while material action verdicts hold normal dispatch and deploy widening.
- Recent Torghut events showed completed migration/bootstrap jobs, then startup probe failures and image-pull backoff
  for websocket and TA workloads.
- Listing `statefulsets`, `daemonsets`, and secrets from the agents service account was forbidden in the assessed
  namespaces. Direct CNPG SQL via `kubectl cnpg psql` was also forbidden because this runner cannot create
  `pods/exec`.

### Runtime And Source

- `http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 and `leaderElection.isLeader=true`.
- `http://agents.agents.svc.cluster.local/ready` returned HTTP 200.
- Jangar control-plane status reported database healthy with `29/29` Kysely migrations applied and latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Jangar control-plane status reported `execution_trust.status=degraded` on `StageStaleness` for discover, plan,
  implement, and verify.
- Jangar rollout health for the configured agents deployments was healthy, but material action verdicts held
  `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready`.
- The status route had `ready_action_exchange=null` and `stage_clearance_packet=null`.
- Torghut source already consumes the missing packet:
  `services/torghut/app/trading/profit_signal_quorum.py` adds `stage_clearance_packet_missing`, and
  `services/torghut/app/main.py` builds a stage-clearance packet ref from dependency quorum.
- Jangar source has no `control-plane-action-custody.ts`, no `control-plane-stage-clearance.ts`, and no emitted
  `stage_clearance_packet` builder. Existing Jangar modules remain the right inputs: `control-plane-status.ts`,
  `control-plane-material-action-verdict.ts`, `control-plane-negative-evidence-router.ts`,
  `control-plane-controller-witness.ts`, `control-plane-source-rollout-truth-exchange.ts`, and
  `supporting-primitives-controller.ts`.
- Source risk is concentrated: `supporting-primitives-controller.ts` is 3,327 lines, `control-plane-status.ts` is
  793 lines, `control-plane-negative-evidence-router.ts` is 692 lines, and Torghut `main.py` is 5,298 lines. The next
  implementation must add pure reducers and thin integration, not more inline scheduler branching.
- The repo has broad test coverage around these surfaces: 286 Jangar/Torghut server and trading tests were found in
  the scoped test directories. The missing invariant is cross-plane packet emission and consumption.

### Database And Data

- Direct database proof was blocked by RBAC: listing secrets in `jangar` and `torghut` was forbidden, and CNPG
  `pods/exec` was forbidden for `jangar-db-1` and `torghut-db-1`.
- Jangar application database proof was healthy: connected, `kysely_migration`, `29` registered, `29` applied, no
  unapplied or unexpected migrations.
- Torghut `/db-check` returned `ok=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, schema current, branch count `1`, lineage ready, and only
  historical parent-fork warnings.
- Jangar control-plane summary projected `630` AgentRuns: `489 Succeeded`, `105 Failed`, `16 Running`, `7 Pending`,
  `12 Template`, and `1 Unknown`.
- Torghut `/readyz` returned degraded while Postgres, ClickHouse, broker, database schema, and universe dependencies
  were OK.
- Torghut live submission was blocked by `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and
  stale empirical jobs.
- Torghut proof floor was `repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Torghut consumer evidence was current with `route_state=repair_only`, `route_repair_value=14`, and repair decision.
- Quant latest metrics had `180` rows and fresh updates, but three ingestion stages lagged by roughly `956708`,
  `349084`, and `341406` seconds, and two materialization stages were not OK.
- Market context had a fresh bundle for `AMZN`, but technicals, fundamentals, and regime domains were still stale.
- Promotion proof remained thin: the consumer evidence summary reported no research candidates, no research
  promotions, one strategy promotion decision, and no vnext promotion decisions.

## Problem

Jangar already has enough evidence to say "no" to unsafe dispatch and capital. It does not yet have the small
packet that lets every stage act on that answer.

The current failure modes are concrete:

1. A schedule can launch new AgentRuns while `dispatch_normal` and `deploy_widen` are held.
2. Torghut can require a stage-clearance packet that Jangar never emits.
3. A live Torghut route can serve current repair receipts while Argo and pods show rollout/image failures.
4. Database schema can be healthy while execution trust, controller witness, and proof freshness are stale.
5. A repair run can start without naming which value gate it is expected to improve.
6. A deployer can see Argo Healthy for Jangar and still have no compact `merge_ready` or `deploy_widen` clearance ref.

## Alternatives Considered

### Option A: Implement The May 8 Action-Custody Receipt Directly

Jangar would add a broad `action_custody_receipt` projection and let stages consume that.

Advantages:

- Matches the accepted May 8 architecture language.
- Creates a general object for scheduler, deployer, validator, and Torghut.
- Can reuse material action verdicts and Torghut consumer evidence.

Disadvantages:

- Too broad for the current source gap. Torghut is specifically blocked on `stage_clearance_packet`.
- Risks adding another large status payload before the scheduler has a launchable contract.
- Does not force repair work to cite expected value-gate movement.

Decision: reject as the immediate architecture. Keep action custody as the parent concept; implement the narrower
stage-clearance packet first.

### Option B: Add A Blunt Schedule Freeze Until Execution Trust Is Healthy

Jangar would block all scheduled launches while StageStaleness or failed-run debt exists.

Advantages:

- Fastest path to lowering new failed AgentRun creation.
- Easy to explain and easy to verify.
- Avoids cross-service payload design.

Disadvantages:

- Blocks the repair work required to clear the freeze.
- Pushes operators back to manual exceptions.
- Does not give Torghut a usable packet or repair-lot vocabulary.
- Treats zero-notional context repair and deploy widening as the same risk class.

Decision: reject as default. Keep it as an emergency brake if controller quorum or packet integrity fails.

### Option C: Stage-Clearance Packets With Repair-Run Lots

Jangar emits one packet per stage/action class and one ledger of repair lots. Launches must cite a packet or a lot.
Torghut consumes the packet for profit-signal quorum and paper/live holds.

Advantages:

- Closes the current Jangar/Torghut source contract gap.
- Reduces failed AgentRuns by denying uncited launches before pod creation.
- Keeps bounded zero-notional repair available while holding normal dispatch, deploy widening, merge readiness, and
  capital actions.
- Gives deployers a compact action-class decision with validation commands and rollback gates.
- Maps every repair to a value gate rather than more audit volume.

Disadvantages:

- Adds one new reducer and status projection.
- Requires scheduler wiring and Torghut dependency-quorum integration.
- Launch throughput will drop until schedules cite lots correctly.

Decision: select Option C.

## Architecture

Jangar adds two additive control-plane objects.

First, `stage_clearance_packet`:

```text
stage_clearance_packet
  schema_version
  packet_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  action_class
  decision                    # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  material_action_verdict_ref
  execution_trust_ref
  controller_witness_ref
  source_rollout_truth_ref
  rollout_health_ref
  failure_domain_lease_refs[]
  torghut_consumer_evidence_ref
  repair_run_lot_refs[]
  blocking_reason_codes[]
  forbidden_shortcuts[]
  validation_commands[]
  rollout_gate
  rollback_gate
```

Second, `repair_run_lot`:

```text
repair_run_lot
  lot_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  repair_class
  target_value_gate
  expected_unblock_value
  allowed_action_class
  required_input_refs[]
  required_output_refs[]
  max_runtime_seconds
  max_dispatches
  max_notional
  stop_conditions[]
  rollback_target
```

Initial stage/action clearance classes:

- `discover:evidence_refresh`
- `plan:design_contract`
- `implement:repair_only`
- `implement:dispatch_normal`
- `verify:merge_ready`
- `deployer:deploy_widen`
- `torghut:paper_canary`
- `torghut:live_micro_canary`
- `torghut:live_scale`

Rules:

- A packet cannot be upgraded by `/ready`, Argo health, route liveness, or fresh quant latest metrics alone.
- A packet inherits the strongest negative decision from material action verdicts, execution trust, controller witness,
  failure-domain leases, and Torghut consumer evidence.
- If `execution_trust=degraded`, normal dispatch, deploy widening, and merge-ready packets are `hold`.
- If controller witness or watch evidence is stale, dispatch repair can be `repair_only` only when a lot names the
  debt class and max runtime.
- If registry or image-pull evidence is active, deploy widening is `hold` and the lot class is `registry_repair` or
  `image_digest_reconcile`.
- If Torghut proof floor is `repair_only` or live submission is disabled, paper and live packets are `hold` or
  `block` with `max_notional=0`.
- A schedule-runner can create a pod only when it cites a current packet whose `decision` allows that action, or a
  current repair lot whose output receipt is required by a held packet.
- Missing packet is fail-closed for normal dispatch, deploy widening, merge readiness, paper, and live; it is
  observe-only for status views.

## Implementation Scope

Engineer milestone 1:

- Add a pure reducer under `services/jangar/src/server/control-plane-stage-clearance.ts`.
- Feed it from material action verdicts, execution trust, controller witness, source rollout truth, rollout health,
  failure-domain leases, and Torghut consumer evidence.
- Emit `stage_clearance_packets` and a compact `ready_action_exchange` from
  `/api/agents/control-plane/status?namespace=agents`.
- Add tests where Jangar `/ready=ok` but `execution_trust=degraded`; `serve_readonly` can remain allowed while
  `dispatch_normal`, `deploy_widen`, and `merge_ready` are held.
- Add tests where Torghut has current repair consumer evidence but paper/live packets remain zero-notional.

Engineer milestone 2:

- Add `repair_run_lot` generation for the known debt classes: `stage_staleness`, `controller_witness`,
  `workflow_runtime`, `empirical_jobs`, `registry_image_pull`, `market_context`, `quant_ingestion`, and
  `promotion_evidence`.
- Update schedule generation so scheduled AgentRuns must cite either a current packet or a current repair lot.
- Deny uncited normal dispatch before pod creation and emit a concise NATS/Jangar denial naming the missing packet or
  lot.

Engineer milestone 3:

- Wire Torghut dependency quorum to consume Jangar stage-clearance packets instead of treating the packet as missing.
- Keep paper/live blocked until Torghut proof-floor and Jangar packet decisions both allow the requested capital class.

Deployer milestone:

- Extend post-deploy verification to require current `verify:merge_ready` and `deployer:deploy_widen` packets.
- Capture Argo revision, workload readiness, Jangar `/ready`, Torghut `/readyz`, current packet ids, held action
  classes, and rollback gates in the deployer handoff.

## Validation Gates

- `failed_agentrun_rate`: uncited scheduled launches must be denied before creating runner pods; packet-enabled
  schedules should reduce new failures from missing control-plane custody.
- `pr_to_rollout_latency`: deployer handoff must include packet ids for `verify:merge_ready` and
  `deployer:deploy_widen`, plus Argo revision and service readiness.
- `ready_status_truth`: `/ready=ok` remains serving truth only; status must carry held stage-clearance packets when
  execution trust, controller witness, registry, or Torghut proof is degraded.
- `manual_intervention_count`: every held packet must name a repair lot or the smallest missing proof needed to create
  one.
- `handoff_evidence_quality`: implementation, verification, and deployer stages must cite this document or a
  successor before changing scheduler launch admission, stage clearance, or Torghut paper/live gating.

## Rollout

1. Ship reducer and status projection in observe mode with no scheduler enforcement.
2. Compare packet decisions with existing material action verdicts for one schedule window.
3. Generate repair-run lots for the top debt classes and require schedule metadata to cite one lot.
4. Enforce denial for uncited `dispatch_normal`, `deploy_widen`, `merge_ready`, paper, and live classes.
5. Allow `repair_only` dispatch only when lot output receipts map to a held packet.
6. Promote Torghut consumption after `/readyz`, `/trading/status`, and `/trading/consumer-evidence` show the packet
   refs and still keep `max_notional=0` while proof floor is repair-only.

## Rollback

- Disable scheduler enforcement and keep packet projection visible in observe mode.
- Keep material action verdicts, proof floor, live submission gate, and failure-domain leases as the fallback safety
  boundary.
- If packet generation fails, hold `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, and `live_scale`; allow only read-only status and explicit diagnostics.
- Do not loosen Torghut notional, live submission, slippage, alpha readiness, promotion, or proof-floor gates as part
  of rollback.

## Risks And Tradeoffs

- Packet sprawl: each stage/action pair adds an object. Mitigation: keep packets small and ref-heavy.
- False holds: a stale witness can block useful repair. Mitigation: repair lots can allow bounded zero-notional repair
  when they cite the debt class.
- Scheduler churn: schedules need metadata updates. Mitigation: observe mode first, then enforce only high-risk
  action classes.
- Cross-plane coupling: Torghut depends on Jangar packet freshness. Mitigation: Torghut fails closed for paper/live
  and remains observe/repair-only when packets are absent.
- Throughput loss: fewer pods may start. Mitigation: the success metric is fewer failed AgentRuns and faster
  diagnosis, not launch volume.

## Handoff

Engineer handoff: implement `control-plane-stage-clearance.ts`, project packet and lot summaries from the status route,
and add scheduler checks in observe mode first. The first implementation must prove that a healthy `/ready` response
does not create `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, or live clearance while StageStaleness
and Torghut proof-floor debt are active.

Deployer handoff: verify packet freshness after rollout before calling the control plane ready for widening.
Acceptance requires Argo `Synced/Healthy` for Jangar and agents, captured Torghut degraded reasons, packet ids for
held and allowed classes, no new uncited scheduled launches in the sampled window, and unchanged Torghut zero-notional
capital safety.
