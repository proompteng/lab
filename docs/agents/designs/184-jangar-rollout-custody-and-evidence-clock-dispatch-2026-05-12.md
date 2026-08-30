# 184. Jangar Rollout Custody And Evidence-Clock Dispatch (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, rollout failure-mode reduction, scheduler dispatch safety, Torghut
evidence-clock consumption, deployer validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-routeability-cutover-backpressure-and-proof-run-admission-2026-05-08.md`
- `181-jangar-proof-production-debt-and-routeability-admission-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`

## Decision

I am selecting **Jangar rollout custody with evidence-clock dispatch** as the companion control-plane architecture.

Jangar is currently healthier than Torghut at the app level, but that is not enough. Argo reports `jangar` and
`agents` `Synced/Healthy`, controller heartbeats are fresh, and the unscoped quant health route is current. At the same
time, Torghut is `Synced/Degraded`, several Torghut feeder and simulation pods are in `ImagePullBackOff`, recent
market-context jobs are failing, scoped quant pipeline health is degraded, and Torghut capital gates remain closed.
The control plane must not launch normal dispatch or deploy widening by citing a healthy Jangar surface while the
Torghut evidence clocks or rollout clocks disagree.

The selected design adds a Jangar `rollout_custody_receipt` and an `evidence_clock_dispatch_packet`. Jangar consumes
Torghut's `evidence_clock_arbiter` receipt, combines it with source rollout truth, Argo health, runtime kit state,
controller heartbeat, retained failure debt, and NATS collaboration health, then decides which action class is allowed.
Zero-notional repair dispatch can proceed when it names the clock split and expected value gate. Normal dispatch,
deploy widening, merge-ready claims, and paper/live trading support remain held on stale or split clocks.

The tradeoff is lower apparent throughput during degraded rollout windows. I accept that tradeoff because the failure
mode we need to reduce is false readiness. Jangar's job is not to keep launching work when the cluster is telling us the
source-to-runtime path is split. Its job is to launch the smallest repair that can restore routeable profit evidence.

## Evidence Snapshot

All evidence below was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Rollout

- `kubectl auth whoami` resolved to the `agents` service account.
- `kubectl config current-context` was unset, but Kubernetes reads succeeded through in-cluster authentication.
- Argo CD reported `jangar` and `agents` `Synced/Healthy` at revision `b9137f87f5e14cffab6f841cf5ead38724b95949`.
- Argo CD reported `torghut` `Synced/Degraded` at revision `32564cef018d608a7928c80240a70d35f75c5b25`.
- Jangar deployment was available, with one Jangar pod `2/2 Running`. `bumba` and `jangar` both had recent restarts,
  but service health was available.
- Agents deployments were available: `agents=1/1` and `agents-controllers=2/2`. Jangar DB component heartbeats were
  fresh and healthy for the controller set at `2026-05-12T16:37Z`.
- Torghut live service and live TA were running, but rollout degradation was material: `torghut-ws`,
  `torghut-ws-options`, `torghut-ta-sim`, and `torghut-options-ta` were in `ImagePullBackOff`.
- Recent Torghut events showed private registry DNS failures for `registry.ide-newton.ts.net`, readiness 503s on live
  and sim revisions during the window, and repeated image-pull backoffs.
- Agents namespace events showed successful current plan/discover schedule pods, but also failed market-context jobs
  and failed Jangar control-plane scheduled pods retained in the namespace.

### Runtime And Data

- Jangar quant health returned `ok=true`, `latestMetricsCount=4536`, `latestMetricsUpdatedAt=2026-05-12T16:29:01Z`,
  and one-second global pipeline lag when unscoped.
- Jangar DB showed `torghut_control_plane.quant_metrics_latest=4536` with newest `updated_at=2026-05-12T16:37:20Z`.
  Quality was mixed: `3494` latest metrics were `insufficient_data`, `618` were stale, and `424` were good.
- Recent Jangar DB pipeline rows showed all sampled ingestion rows `ok=false`, materialization mixed, and max ingestion
  lag up to `1,728,000` seconds.
- Market-context runs in Jangar DB were active but not clean: `177` succeeded, `17` running, `9` failed, and stale
  started/partial rows remained.
- Torghut `/readyz` returned HTTP 503. `/trading/status` kept live submission blocked and capital in shadow/observe.
- Torghut ClickHouse TA was fresh for the active eight-symbol lane, but Torghut Postgres execution and TCA clocks were
  stale: newest execution on `2026-04-02`, newest TCA computation on `2026-05-08`, and no expected-shortfall samples.
- Torghut promotion evidence was insufficient: one active hypothesis, three metric windows, one disallowed promotion
  decision, stale empirical jobs, and no current routeable candidate.

### Source

- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` is a compact typed health route and
  should remain a source metric surface, not an action authority.
- Jangar already has control-plane status, material verdict, scheduler, source rollout, and Torghut consumer-evidence
  reducers. The missing control-plane object is a custody wrapper that says which receipt wins when rollout health,
  quant health, Torghut profit evidence, and action scheduling disagree.
- Torghut source already emits several proof surfaces. Jangar should not reimplement Torghut capital logic; it should
  consume the evidence-clock arbiter and enforce dispatch/deploy scope.

## Problem

Jangar can see enough state to be useful, but action classes still risk consuming the wrong state. A healthy Jangar
control-plane route does not mean Torghut is ready for normal quant dispatch. Fresh unscoped quant metrics do not mean
the account/window evidence clocks agree. Green CI does not mean a deploy should widen when live feeder pods cannot
pull images.

The failure modes are concrete:

1. Scheduler dispatch can continue when the target service's rollout clock is degraded.
2. A repair run can cite global quant freshness while the scoped ingestion clock is stale.
3. A deployer can cite Argo sync while image pulls are failing and sim/feeder lanes are unavailable.
4. A merge-ready claim can cite PR checks while the required Torghut evidence-clock receipt is absent.
5. NATS progress can show active collaboration while durable evidence clocks remain split.
6. Market-context jobs can fail repeatedly without being priced against routeable candidate or stale-evidence gates.

## Alternatives Considered

### Option A: Keep Jangar As A Status Surface And Let Torghut Decide Everything

Jangar would display Torghut evidence and run scheduled work, but Torghut would remain the only admission authority.

Advantages:

- Avoids duplicating capital logic.
- Keeps trading safety close to the trading service.
- Requires fewer Jangar changes.

Disadvantages:

- Jangar still owns dispatch, workflow retries, merge/deploy visibility, and user-facing readiness.
- Failed dispatch reduction cannot be solved if Jangar does not understand rollout and evidence-clock custody.
- Deployer stages would still need to stitch together Argo, health, DB, NATS, and Torghut proof manually.

Decision: reject. Torghut owns capital truth, but Jangar must own dispatch and rollout custody.

### Option B: Quarantine All Torghut Work While Any Rollout Is Degraded

Hold every Torghut-related action until Argo reports Healthy and all pods are available.

Advantages:

- Strong failure-mode reduction.
- Very simple to explain.
- Prevents noisy work during registry or rollout incidents.

Disadvantages:

- Blocks the zero-notional repairs needed to recover evidence clocks.
- Treats a stale TCA repair and a live capital action as equivalent risk.
- Slows recovery because the control plane cannot launch bounded repair work.

Decision: keep as emergency posture only.

### Option C: Rollout Custody With Evidence-Clock Dispatch

Jangar emits a custody receipt per action class. It blocks normal dispatch and deploy widening on rollout or evidence
clock splits, but allows named zero-notional repair work when the repair lot cites the split, value gate, input
receipts, output receipts, max runtime, and rollback target.

Advantages:

- Reduces false-ready dispatch and deploy claims.
- Lets recovery proceed through bounded repair work.
- Gives deployers a single handoff object with validation commands and rollback expectations.
- Keeps Torghut capital authority intact.
- Directly maps launch decisions to `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

Disadvantages:

- Adds a new Jangar receipt and reducer.
- Requires careful stage adoption to avoid blocking safe read-only workflows.
- Makes rollout degradation visible as action debt, which can lower apparent throughput.

Decision: select Option C.

## Architecture

Jangar publishes a shadow-first `rollout_custody_receipt`:

```text
rollout_custody_receipt
  schema_version = jangar.rollout-custody.v1
  receipt_id
  generated_at
  fresh_until
  repository
  branch
  target_system = torghut
  action_class                 # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready
  decision                     # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  source_rollout_ref
  argo_health_ref
  runtime_kit_ref
  controller_heartbeat_ref
  retained_failure_debt_ref
  nats_context_ref
  torghut_evidence_clock_ref
  torghut_profit_candidate_exchange_ref
  blocking_clock_names[]
  blocking_rollout_reasons[]
  required_repair_lot_ids[]
  validation_commands[]
  rollback_gate
```

Jangar also publishes an `evidence_clock_dispatch_packet` for repair launches:

```text
evidence_clock_dispatch_packet
  schema_version = jangar.evidence-clock-dispatch.v1
  packet_id
  custody_receipt_id
  repair_lot_id
  target_value_gate
  launch_allowed
  launch_reason
  forbidden_action_classes[]
  required_input_receipts[]
  required_output_receipts[]
  max_runtime_seconds
  max_parallelism
  rollback_target
```

Decision rules:

- `serve_readonly` can remain allowed when Jangar is healthy, even if Torghut evidence clocks are degraded.
- `dispatch_repair` is allowed only for zero-notional repair lots with a current custody receipt, explicit value gate,
  bounded runtime, and no live/paper notional.
- `dispatch_normal` is held when any required Torghut evidence clock is stale, missing, split, or rollout-blocked.
- `deploy_widen` is held when Argo is degraded, image pulls fail, controller heartbeats are stale, runtime kits are
  incomplete, or the Torghut arbiter is stale.
- `merge_ready` may cite green CI, but it cannot claim operational readiness without the custody receipt and deployer
  validation evidence.

## Failure-Mode Reduction

This contract reduces four specific failure modes:

- Source-to-runtime split: an image digest or Git revision can be synced while feeder/sim pods cannot pull. Jangar
  marks that as rollout-clock debt and blocks widening.
- Evidence split: ClickHouse can be fresh while Postgres TCA, empirical proof, or Jangar scoped quant is stale. Jangar
  blocks normal dispatch until Torghut's arbiter agrees.
- Retry storm: market-context or control-plane jobs can fail repeatedly. Jangar prices each retry against a value gate
  and max parallelism instead of relaunching generic work.
- Handoff ambiguity: engineer and deployer stages receive one custody receipt containing validation and rollback
  commands instead of a loose list of dashboards.

## Implementation Scope

Engineer milestone 1:

- Add a Jangar reducer that consumes Torghut's `evidence_clock_arbiter` and current control-plane rollout evidence to
  build `rollout_custody_receipt`.
- Add a dispatch packet builder for zero-notional repair lots.
- Surface the receipt in control-plane status and NATS/Jangar progress summaries without enforcing new blocks.
- Add tests for Torghut Argo degraded, image-pull failures, missing Torghut arbiter, stale scoped quant, and
  zero-notional repair allow.

Engineer milestone 2:

- Gate `dispatch_normal`, `deploy_widen`, and operational ready claims on the custody receipt.
- Keep `serve_readonly` independent from Torghut capital readiness.
- Connect repair dispatch to Torghut repair lot ids and expected value gates.

Deployer milestone:

- Prove the deployed Jangar image emits the custody receipt.
- Prove Argo sync and health for `jangar`, `agents`, and `torghut`.
- Prove live service health and Torghut evidence-clock status.
- Prove repair dispatch stays zero-notional and normal dispatch/deploy widening hold while Torghut rollout or proof
  clocks are split.

## Validation Gates

- `post_cost_daily_net_pnl`: Jangar must not treat a PR, rollout, or repair run as PnL-improving unless the Torghut
  exchange reports a current routeable candidate.
- `routeable_candidate_count`: repair dispatch must cite a candidate-count repair lot or leave the metric unchanged.
- `zero_notional_or_stale_evidence_rate`: every repair dispatch must name which stale clock it is expected to retire.
- `fill_tca_or_slippage_quality`: TCA repair dispatch must cite expected shortfall, symbol coverage, or slippage
  quality receipts as output evidence.
- `capital_gate_safety`: custody receipts keep `max_notional=0` for repair work and block paper/live support when any
  required clock is stale or rollout-blocked.

## Rollout

1. Ship receipt generation in shadow mode.
2. Publish custody decisions in Jangar status and NATS progress with compact reason codes.
3. Compare shadow custody decisions against existing material action verdicts for at least one deploy cycle.
4. Enforce holds for `dispatch_normal` and `deploy_widen`.
5. Enforce repair dispatch requirements after Torghut emits routeable profit exchange repair lots.

## Rollback

Rollback should reduce enforcement, not evidence:

- Disable custody enforcement and keep the receipt visible in status.
- Fall back to existing material action verdicts and Torghut consumer-evidence checks.
- If the reducer causes status route latency or errors, remove it from response assembly and keep tests around the
  failing fixture.
- If rollout evidence is unavailable, default `dispatch_normal`, `deploy_widen`, and capital-adjacent claims to hold.

## Risks

- Jangar could over-block repair work if rollout debt is too broad. Mitigation: allow only named zero-notional repair
  dispatch while holding normal dispatch and deploy widening.
- Receipt freshness could become another clock to maintain. Mitigation: include `fresh_until` and make missing/stale
  receipt a hold with explicit reason codes.
- The reducer could duplicate Torghut capital logic. Mitigation: consume Torghut's arbiter and candidate exchange;
  Jangar owns action custody, not capital truth.
- NATS can show live progress without durable proof. Mitigation: custody receipts cite durable repo, Argo, DB, and
  Torghut references; NATS carries summaries only.

## Handoff

Engineer next action: implement the shadow `rollout_custody_receipt` and `evidence_clock_dispatch_packet` reducers in
Jangar, then add tests for degraded Torghut rollout, stale Torghut evidence-clock receipt, zero-notional repair allow,
and deploy-widen hold.

Deployer next action: after implementation, validate Jangar status, NATS summaries, Argo health, Torghut `/readyz`,
Torghut `/trading/status`, ClickHouse freshness, Postgres proof freshness, and zero-notional repair dispatch before
calling the release ready.

Revenue metric improved: this contract improves `capital_gate_safety` and
`zero_notional_or_stale_evidence_rate` first by preventing false-ready dispatch, then enables
`routeable_candidate_count` through bounded evidence-clock repair.
