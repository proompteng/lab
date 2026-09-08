# 185. Jangar Clock-Settled Repair Dispatch And Rollout Custody (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut clock-settlement consumption, repair dispatch custody, rollout
failure-mode reduction, deployer validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/189-torghut-clock-settled-repair-execution-and-routeability-reentry-2026-05-12.md`

Extends:

- `184-jangar-rollout-custody-and-evidence-clock-dispatch-2026-05-12.md`
- `184-jangar-stage-clearance-packets-and-repair-run-lot-ledger-2026-05-12.md`
- `184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`
- `../torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`

## Decision

I am selecting **clock-settled repair dispatch with rollout custody** as the next Jangar architecture step.

Jangar is serving again, but it should not treat serving health as proof that Torghut quant can route normal work.
Current `/ready` returns HTTP 200 with leader election healthy, while `execution_trust.status=degraded` because Jangar
and Torghut implement and verify stages are stale. Argo reports Jangar and Agents as progressing during rollout, and
the Agents namespace still carries failed and running scheduled work. In the last six hours Jangar DB records `8`
failed, `7` pending, `9` running, and `24` succeeded AgentRuns.

Torghut is the sharper consumer risk. Argo reports `torghut` `OutOfSync/Degraded`. Torghut `/readyz` is HTTP 503,
live submission is held, and the live arbiter says `routeable_candidate_count=0`. Direct ClickHouse data is fresh, but
the arbiter marks the ClickHouse TA clock as missing. That means Jangar must not dispatch normal quant work by citing
fresh data, global latest metrics, or an HTTP 200 Jangar route. It may dispatch only the zero-notional repair packet
that retires the named clock split.

The decision is to make Jangar consume Torghut's `clock_settlement_receipt` and emit a `clock_settled_dispatch_receipt`
per stage and action class. This receipt is the launch contract. It allows read-only serving, allows bounded repair
when the repair packet is current and zero-notional, and holds normal dispatch, deploy widening, merge-ready claims,
paper support, and live support until Torghut clocks settle.

The tradeoff is lower dispatch volume while stale stages and clock splits exist. I accept that because the current
business metric is routeable post-cost profit evidence without weakening capital safety, not more schedule attempts.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Rollout

- Runtime identity is `system:serviceaccount:agents:agents-sa`; in-cluster Kubernetes reads are authorized.
- Argo reports `torghut` `OutOfSync/Degraded`, `jangar` `Synced/Progressing`, and `agents` `Synced/Progressing`.
- Torghut core pods are running, but recent events include options rollout restarts, readiness probe failures, duplicate
  ClickHouse PDB warnings, and WebSocket options readiness 503.
- Jangar pod rollout moved from connection refused to `/ready` HTTP 200 during the assessment.
- Agents deployments are active, but events show controller readiness/liveness failures, a backoff-limited Jangar
  implement job, fresh market-context repair jobs, and retained failed Torghut quant verify jobs.
- NATS progress is available and was updated during assessment; durable repo artifacts remain the audit source.

### Runtime And Data

- Jangar `/ready` reports leader election healthy and serving passport healthy, but `execution_trust.status=degraded`.
- Jangar memory provider is configured against the self-hosted embedding endpoint, but the repo memory helper returned
  HTTP 500 for retrieve attempts from this workspace.
- Jangar `torghut_control_plane.quant_metrics_latest` has `4536` rows with newest
  `updated_at=2026-05-12 20:22:27.091955+00`.
- Jangar proof history is expensive: `quant_metrics_series` is estimated at `314034592` rows and `114 GB`, while
  `quant_pipeline_health` is estimated at `51237248` rows and `17 GB`.
- Scoped Jangar quant health for `PA3SX7FYNUTF/15m` returns `ok=true`, `status=degraded`, and `latestMetricsCount=180`,
  with missing latest-store and pipeline details.
- Torghut `/healthz` returns HTTP 200, `/readyz` returns HTTP 503, and `/trading/status` reports live mode running but
  not routeable.
- Torghut arbiter reports `clock_count=10`, `current_clock_count=1`, `noncurrent_clock_count=9`,
  `routeable_candidate_count=0`, and `zero_notional_or_stale_evidence_rate=0.9`.
- Direct Torghut data confirms the split: ClickHouse TA is fresh at `2026-05-12 18:48:40`, but Postgres TCA and
  executions are stale, empirical replay is stale, promotion approval is empty, and research/promotion tables are empty.

### Source

- Jangar has the right inputs: control-plane status, material-action verdicts, negative evidence routing,
  source-rollout truth, stage-clearance packet designs, runtime kits, and Torghut quant metric stores.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is a small store boundary at `403` lines; it should
  remain a latest/materialized read path, not a proof-history scanner.
- `services/jangar/src/server/torghut-quant-runtime.ts` is `817` lines and already shapes quant runtime status.
- Jangar `ready.tsx` is `193` lines and is a serving surface, not a dispatch authority.
- Torghut `evidence_clock_arbiter.py` already emits the proof object Jangar should consume. Jangar should not
  reimplement Torghut capital logic.
- The missing Jangar invariant is dispatch custody: a schedule, deploy, merge-ready claim, or paper/live support action
  must cite a current Torghut clock-settlement receipt or a zero-notional repair packet.

## Problem

Jangar can be healthy and still launch the wrong Torghut action.

The failure modes are concrete:

1. Serving readiness can be interpreted as dispatch readiness while execution trust is degraded.
2. Global quant latest metrics can hide scoped degraded health.
3. A direct ClickHouse witness can be fresh while Torghut's published TA clock is missing.
4. Scheduler retries can create new runs without naming the clock split or value gate they retire.
5. Deployer can see a synced image or green PR checks while Torghut rollout and capital clocks are still blocked.
6. Merge-ready claims can skip the evidence-clock proof needed by the engineer and verify stages.

The control plane needs one launch object that separates read-only serving, zero-notional repair, normal dispatch,
deploy widening, merge readiness, paper support, and live support.

## Alternatives Considered

### Option A: Let Torghut Alone Decide Dispatch

Jangar would continue to show health and launch schedules; Torghut would reject unsafe actions at runtime.

Advantages:

- Keeps all trading decisions in Torghut.
- Avoids adding another Jangar reducer.
- Simple to implement short term.

Disadvantages:

- Jangar still owns the scheduler, deployer visibility, and run creation.
- Failed or unfocused AgentRuns can still launch before Torghut rejects them.
- Deployer and verifier still lack a compact custody receipt.

Decision: reject. Torghut owns capital truth; Jangar owns launch custody.

### Option B: Freeze All Torghut Dispatch Until Every Stage Is Healthy

Jangar would block all Torghut quant dispatch while execution trust is degraded, Argo is degraded, or any evidence
clock is stale.

Advantages:

- Strong failure-mode reduction.
- Easy to explain and verify.
- Prevents normal dispatch during rollout or proof splits.

Disadvantages:

- Blocks the repair work required to clear the degraded state.
- Treats a zero-notional clock-wiring repair and a live capital action as equivalent risk.
- Pushes operators into manual exceptions.

Decision: reject as default. Keep it as an emergency brake if settlement receipt integrity fails.

### Option C: Clock-Settled Repair Dispatch

Jangar consumes Torghut settlement receipts and dispatches only the allowed action class. Read-only serving may
continue; zero-notional repair can launch with a current packet; normal dispatch and deploy widening are held until
settlement is current.

Advantages:

- Reduces false-ready dispatch without blocking bounded repair.
- Converts failed-run pressure into value-gate-priced repair work.
- Gives engineer, deployer, and verify stages a single proof reference.
- Keeps capital authority in Torghut.
- Maps directly to `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

Disadvantages:

- Adds one control-plane receipt and scheduler integration path.
- Requires stages to cite packet ids before dispatch.
- Will lower apparent run volume until schedules are packet-aware.

Decision: select Option C.

## Architecture

Jangar publishes `clock_settled_dispatch_receipt`:

```text
clock_settled_dispatch_receipt
  schema_version = jangar.clock-settled-dispatch.v1
  receipt_id
  generated_at
  fresh_until
  repository
  branch
  swarm_name
  stage
  action_class                 # serve_readonly | dispatch_repair | dispatch_normal | merge_ready | deploy_widen | paper_support | live_support
  decision                     # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  execution_trust_ref
  source_rollout_ref
  runtime_kit_ref
  argo_health_ref
  controller_heartbeat_ref
  retained_failure_debt_ref
  torghut_clock_settlement_ref
  torghut_repair_packet_refs[]
  blocking_clock_names[]
  blocking_reason_codes[]
  validation_commands[]
  rollback_gate
```

Jangar also publishes dispatch tickets for individual repair launches:

```text
clock_repair_dispatch_ticket
  ticket_id
  dispatch_receipt_id
  torghut_repair_packet_id
  target_clock
  target_value_gate
  launch_allowed
  launch_reason
  required_input_receipts[]
  required_output_receipts[]
  forbidden_action_classes[]
  max_runtime_seconds
  max_parallelism
  max_notional = 0
  stop_conditions[]
  rollback_target
```

Decision rules:

- `serve_readonly` can stay allowed while Jangar is healthy, even when Torghut clocks are split.
- `dispatch_repair` is allowed only for Torghut packets with `max_notional=0`, a target clock, a target value gate,
  and a bounded runtime.
- `dispatch_normal` is held when Torghut settlement state is `blocked`, `repair_ready`, stale, missing, or split.
- `merge_ready` can cite green CI, but cannot claim operational readiness without a fresh dispatch receipt and Torghut
  settlement receipt.
- `deploy_widen` is held while Argo is degraded, runtime kits are incomplete, controller heartbeats are stale, or any
  required Torghut clock is stale, missing, split, or blocked.
- `paper_support` and `live_support` require Torghut capital approval and Jangar dispatch approval; Jangar cannot
  promote a repair receipt into capital authority.

## Implementation Scope

Engineer milestone 1:

- Add a pure Jangar reducer for `clock_settled_dispatch_receipt`.
- Consume the compact Torghut settlement summary and repair packet ids.
- Add a status projection that exposes the current dispatch decision per swarm stage and action class.
- Add tests that prove `serve_readonly` can be allowed while `dispatch_normal`, `deploy_widen`, `paper_support`, and
  `live_support` are held on a Torghut clock split.

Engineer milestone 2:

- Wire schedule generation to require a dispatch ticket for Torghut repair runs.
- Add denial reasons for uncited normal dispatch.
- Add deployer validation output that records Argo, runtime kit, Torghut `/readyz`, and Torghut clock-settlement refs.

## Validation Gates

Local validation for Jangar PRs:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bunx oxfmt --check services/jangar/src docs/agents/designs/185-jangar-clock-settled-repair-dispatch-and-rollout-custody-2026-05-12.md`

Deploy validation:

- Argo `jangar`, `agents`, and `torghut` are synced and not degraded for the promoted revisions before any widen claim.
- Jangar `/ready` exposes `clock_settled_dispatch_receipt`.
- Torghut `/readyz` exposes `clock_settlement_receipt`.
- A Torghut clock split produces `dispatch_repair=allow` only for matching zero-notional repair tickets and holds
  `dispatch_normal`, `deploy_widen`, `paper_support`, and `live_support`.
- Failed AgentRuns do not increase from uncited Torghut quant repair schedules after enforcement is enabled.

## Rollout And Rollback

Roll out in shadow mode first:

- Emit receipts and tickets without denying existing schedules.
- Compare predicted deny decisions against actual scheduled runs for at least one market session.
- Enable deny mode only for Torghut normal dispatch and deploy widening after shadow evidence is stable.
- Keep zero-notional repair available for clock-wiring, scoped quant, TCA, empirical, promotion, and rollout proof
  packets.

Rollback:

- Disable dispatch receipt enforcement.
- Keep Jangar serving and Torghut capital at `max_notional=0`.
- Fall back to existing material-action verdicts and Torghut evidence-clock arbiter.
- If settlement receipts become stale or malformed, block normal dispatch and allow only read-only serving until the
  prior stable Jangar revision is restored.

## Risks

- Scheduler adoption can lag receipt emission; keep shadow mode until uncited schedules are visible.
- The Jangar reducer must stay on latest/materialized proof paths. The `quant_metrics_series` and
  `quant_pipeline_health` history tables are too large for synchronous admission reads.
- A dispatch receipt can become a second capital authority if wording is loose. The contract explicitly keeps capital
  approval in Torghut.
- Memory retrieval failed with HTTP 500 during this run; mission handoff should capture that connectivity issue and
  retry memory save after merge.

## Handoff

The next Jangar implementation improves `capital_gate_safety` and `zero_notional_or_stale_evidence_rate` by preventing
uncited normal dispatch when Torghut clocks are split. The first measurable revenue-adjacent effect is fewer stale
repair runs and a clearer path to increase `routeable_candidate_count`. The smallest blocker preventing revenue impact
is the unresolved Torghut clock split: fresh ClickHouse TA is not settled into a current published clock, and Jangar
must dispatch only the zero-notional packet that fixes that path.
