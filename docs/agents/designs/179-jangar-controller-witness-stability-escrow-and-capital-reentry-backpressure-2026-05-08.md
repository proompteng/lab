# 179. Jangar Controller-Witness Stability Escrow And Capital Reentry Backpressure (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane reliability, controller witness stability, material action backpressure, Torghut capital
reentry safety, validation, rollout, rollback, and measurable handoff gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/183-torghut-receipt-settled-capital-reentry-cohorts-2026-05-08.md`

Extends:

- `178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `docs/torghut/design-system/v6/182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`

## Decision

I am selecting **controller-witness stability escrow with capital reentry backpressure** as the next Jangar
control-plane architecture step.

The live system has moved past the earlier route-parity failure. At `2026-05-08T08:26Z`,
`/trading/consumer-evidence` on Torghut returned HTTP 200 with schema `torghut.consumer-evidence-status.v1`, and
Jangar control-plane status consumed a current Torghut receipt
`torghut-consumer-evidence:8c654c9fd7b8fac7`. That receipt is deliberately not capital authority: it carries
`max_notional=0` and reason codes `forecast_registry_degraded`, `simple_submit_disabled`, and
`hypothesis_not_promotion_eligible`.

The Jangar problem is now narrower. Argo CD reports `jangar`, `torghut`, and `symphony-torghut` `Synced` and
`Healthy` at current `main`; Jangar pods are ready; `agents` and `agents-controllers` are available. But the status
surface still flickers around controller witness trust. A sample at `2026-05-08T08:25Z` blocked dependency quorum on
`watch_reliability_blocked`; a sample at `2026-05-08T08:27Z` recovered to dependency quorum `allow` and watch
reliability `healthy`, while material action verdicts still held `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, and `merge_ready` because the controller witness was split and controller heartbeats were not current.
That is the correct conservative outcome, but it is not yet a stable engineering contract.

The selected design makes controller witness stability a first-class escrow with hysteresis, action-class scoping, and
explicit Torghut capital reentry backpressure. Serving and Torghut observe can remain open when route, database, and
watch evidence are fresh. Normal dispatch, deploy widening, merge-ready claims, paper canary, and live canary stay
held until the controller witness escrow is current for a defined window. The tradeoff is intentional: Jangar may
wait through a short recovery period even after dependency quorum turns green, but it will not convert a transient
watch recovery into rollout or capital authority.

## Current Evidence

All evidence in this section was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps
manifests, trading flags, or AgentRun objects.

### Cluster And Rollout

- Local branch `codex/swarm-torghut-quant-plan` started clean at `00b0bc2c6`, matching current `origin/main`.
- `kubectl config current-context` was unset, but namespace-scoped reads worked as
  `system:serviceaccount:agents:agents-sa`.
- Argo CD applications reported:
  - `jangar`: `Synced` / `Healthy` at `00b0bc2c6b6591ce061af3efce7f9976e52deb11`.
  - `torghut`: `Synced` / `Healthy` at the same revision.
  - `symphony-torghut`: `Synced` / `Healthy` at the same revision.
  - `torghut-options`: `Synced` / `Healthy` at `819e30031328b4b6f0d5fbc51cd6078589ecee64`.
- Jangar namespace pods were all running, including `jangar`, `jangar-db-1`, `open-webui`, Redis, Symphony, and
  Bumba.
- Jangar deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- Agents pods grouped to 79 `Failed`, 9 `Running`, and 318 `Succeeded` in this observer window.
- Recent Agents events showed readiness probe timeouts on `agents` and both controller pods about 10 minutes before
  the sample. Later Jangar and Torghut quant scheduled jobs completed, which confirms recovery but not stability.

### Jangar Status

- `/api/agents/control-plane/status?namespace=agents` at `2026-05-08T08:25Z` reported dependency quorum `block` with
  reason `watch_reliability_blocked`.
- The same route at `2026-05-08T08:27Z` reported dependency quorum `allow`, watch reliability `healthy`,
  1 observed stream, 1,678 events, 0 errors, and 0 restarts.
- Material action verdicts still held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` with
  controller-witness reasons, including `controller_heartbeat_not_current` and `controller_witness_split`.
- `serve_readonly` and `torghut_observe` were allowed; `paper_canary` was held; `live_micro_canary` and `live_scale`
  were blocked.
- Jangar `torghut_consumer_evidence` was `current`, proving the route-parity issue is no longer the active blocker.

### Source And Data

- `services/jangar/src/server/supporting-primitives-controller.ts` is 3,325 lines and owns schedule rendering,
  launch command generation, status fetch behavior, and Kubernetes API posting. It is the right implementation seam
  for launch backpressure, but it is too broad for another hidden special case.
- `services/jangar/src/server/control-plane-status.ts` already composes dependency quorum, negative evidence, action
  SLO budgets, material action verdicts, recovery warrants, runtime proof cells, and Torghut consumer evidence.
- `packages/scripts/src/jangar/verify-deployment.ts` already validates recovery warrants and runtime proof cells, but
  the deployer gate needs a controller-witness stability assertion that survives the green dependency quorum sample.
- Direct CNPG `psql` through `kubectl cnpg` was blocked by RBAC: this service account cannot create `pods/exec` in
  namespace `torghut`. ClickHouse direct HTTP returned authentication required. Database assessment therefore uses
  Jangar and Torghut typed status surfaces plus `/db-check` until a read-only DB credential is provided.

## Problem

Jangar has good proof surfaces, but controller-witness recovery is still a moving target for material actions.

The failure modes are:

1. Dependency quorum can recover before controller witness stability is durable enough for deploy or capital action.
2. A single watch-reliability sample can oscillate from block to allow inside a few minutes.
3. Material action verdicts already hold on controller witness split, but the handoff does not tell engineers which
   reducer, tests, and rollout gate make that hold durable.
4. Schedule runners can continue to launch observe or repair work while controller witness proof is stale, but normal
   dispatch and deploy widening need explicit backpressure.
5. Torghut now provides a current consumer receipt, so Jangar must stop spending engineering effort on a solved route
   404 and aim at the remaining witness and capital gates.

## Alternatives Considered

### Option A: Trust Dependency Quorum As Soon As It Turns Green

Advantages:

- Smallest change.
- Matches the top-line status route.
- Lets schedules resume quickly after transient watch failures.

Disadvantages:

- Ignores the material verdict evidence that controller witnesses are still stale or split.
- Risks widening rollout or capital work during the unstable part of recovery.
- Makes Jangar's richer verdict model advisory instead of authoritative.

Decision: reject. Dependency quorum is necessary, not sufficient, for material actions.

### Option B: Freeze All Schedule Launches Until Witnesses Are Stable

Advantages:

- Strong and simple safety rule.
- Easy to explain during an incident.
- Avoids retry fanout while controllers recover.

Disadvantages:

- Blocks serve-readonly and Torghut observe work that can safely run at zero notional.
- Slows proof repair that could clear the hold.
- Turns a controller witness issue into a global throughput outage.

Decision: keep as an emergency lever, not the default.

### Option C: Controller-Witness Stability Escrow With Action-Scoped Backpressure

Advantages:

- Keeps serving and zero-notional observe work open while holding deploy and capital authority.
- Converts witness freshness, watch stability, and material verdict state into one bounded deployer gate.
- Gives Torghut a stable upstream reason for paper/live holds without collapsing all work.
- Reduces repeated launch failures by making schedule runners consume a current escrow decision.

Disadvantages:

- Adds a reducer and a small status projection.
- Requires hysteresis tuning so short controller restarts do not hold too long.
- Needs tests across Jangar status, schedule generation, deploy verification, and Torghut material-action consumers.

Decision: select Option C.

## Architecture

Jangar adds a bounded `controller_witness_stability_escrow` projection:

```text
controller_witness_stability_escrow
  escrow_id
  generated_at
  fresh_until
  namespace
  dependency_quorum_ref
  watch_reliability_ref
  controller_witness_ref
  material_action_verdict_epoch_ref
  stable_window_seconds
  recovery_hysteresis_seconds
  action_decisions[]
  rollback_target
```

Each action decision is scoped:

```text
action_decision
  action_class              # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready
                            # torghut_observe | paper_canary | live_micro_canary | live_scale
  decision                  # allow | observe_only | repair_only | hold | block
  max_dispatches
  max_runtime_seconds
  max_notional
  blocking_reason_codes
  required_repair_actions
  evidence_refs
```

Rules:

- `serve_readonly` may allow when route, database, and serving passport evidence are current.
- `torghut_observe` may allow bounded zero-notional work when Torghut consumer evidence is current.
- `dispatch_repair` may allow only when the controller witness escrow is current or when an explicit repair lease
  names the stale witness as the repair target.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require dependency quorum `allow`, watch reliability
  `healthy`, and controller witness stability for two consecutive windows.
- `paper_canary` requires Torghut receipt settlement plus controller witness stability. It cannot inherit authority
  from serve-readonly.
- `live_micro_canary` and `live_scale` require all paper gates plus live capital policy gates; no controller recovery
  shortcut exists.

## Implementation Scope

Engineer stage should implement:

- A pure reducer in Jangar that builds `controller_witness_stability_escrow` from existing status inputs.
- Additive status projection in `/api/agents/control-plane/status?namespace=agents`.
- Schedule-runner admission checks that read the escrow decision before launching normal dispatch or deploy-oriented
  work.
- Deployer verification in `packages/scripts/src/jangar/verify-deployment.ts` that fails deploy widening when the
  escrow is missing, stale, or holding material action classes.
- Tests proving dependency quorum `allow` plus stale controller witness still holds dispatch, deploy, merge, and
  Torghut capital actions.

No implementation step may grant Torghut paper or live notional. This is an authority-separation release.

## Validation Gates

- `capital_gate_safety`: paper and live action classes remain held or blocked while Torghut receipt reasons include
  `forecast_registry_degraded`, `simple_submit_disabled`, or `hypothesis_not_promotion_eligible`.
- `routeable_candidate_count`: Jangar must preserve the current Torghut consumer receipt reference so Torghut can
  prove candidate availability separately from controller witness state.
- `zero_notional_or_stale_evidence_rate`: all controller-witness holds keep `max_notional=0`.
- `fill_tca_or_slippage_quality`: Jangar must not override Torghut TCA evidence or slippage guardrails.
- `post_cost_daily_net_pnl`: no capital release is claimed until Torghut publishes a receipt-settled paper cohort
  with measured post-cost evidence.

Local checks:

- `bun run --filter @proompteng/jangar test -- control-plane-status`
- `bun run --filter @proompteng/jangar test -- supporting-primitives-controller`
- `bun run --filter @proompteng/scripts test -- verify-deployment`
- `bunx oxfmt --check docs/agents/designs/179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`

Cluster checks after rollout:

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` includes
  `controller_witness_stability_escrow`.
- The escrow and material action verdicts agree for `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `paper_canary`, and `live_micro_canary`.
- Two consecutive samples five minutes apart show stable decisions before deploy widening or merge-ready claims.

## Rollout

1. Ship the reducer and status projection in shadow mode.
2. Compare escrow decisions with existing material action verdicts for one full schedule window.
3. Enable schedule-runner backpressure for `dispatch_normal`, `deploy_widen`, and `merge_ready`.
4. Enable paper-canary gating only after Torghut receipt-settled cohorts are visible.
5. Keep live canary and live scale blocked until Torghut capital gates clear separately.

## Rollback

- Disable escrow enforcement and leave the projection in observe mode.
- Revert schedule-runner backpressure to the existing material action verdict behavior.
- Keep Torghut paper and live notional at `0`; rollback must not open capital.
- If the projection itself is expensive or unstable, remove it from the full status route and keep only a bounded
  deployer verification endpoint.

## Risks

- Hysteresis can be too strict and hold useful repair work. Mitigation: `torghut_observe` and targeted witness repair
  remain allowed with zero notional.
- Hysteresis can be too loose and admit rollout too early. Mitigation: deploy widening requires two consecutive stable
  windows and material verdict agreement.
- The full status payload is already large. Mitigation: the escrow is compact and should also be exposed through a
  bounded verification projection.

## Handoff

The next bounded implementation milestone is to ship the Jangar shadow reducer and deployer check. The revenue metric
it protects is `capital_gate_safety`; the revenue metric it enables is `routeable_candidate_count`, because Torghut can
advance receipt-settled paper cohorts only after Jangar stops conflating route health, controller witness recovery,
and capital authority.
