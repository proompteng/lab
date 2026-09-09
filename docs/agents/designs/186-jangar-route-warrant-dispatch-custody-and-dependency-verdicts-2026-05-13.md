# 186. Jangar Route-Warrant Dispatch Custody And Dependency Verdicts (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane dispatch custody, Torghut route-warrant consumption, dependency verdict settlement,
zero-notional repair admission, rollout safety, validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/190-torghut-route-warrant-exchange-and-ingestion-proof-reentry-2026-05-13.md`

Extends:

- `185-jangar-clock-settled-repair-dispatch-and-rollout-custody-2026-05-12.md`
- `184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`
- `../torghut/design-system/v6/189-torghut-clock-settled-repair-execution-and-routeability-reentry-2026-05-12.md`
- `../torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`

## Decision

I am selecting **route-warrant dispatch custody with dependency verdict settlement** as the next Jangar architecture
step.

Jangar is healthy enough to serve operators, but not healthy enough to treat Torghut quant as routeable. Current
cluster evidence is split: both swarms report `Active/Ready`, Jangar is `Synced/Healthy`, and Jangar `/ready` returns
HTTP 200. The same control-plane payload reports `execution_trust.status=degraded`, because implement evidence is
stale. Torghut is `Synced/Degraded`; `/healthz` returns HTTP 200, while `/readyz` and `/trading/health` return HTTP 503. Torghut's consumer evidence is fresh but says `decision=repair`, `max_notional=0`,
`accepted_routeable_candidate_count=0`, and `routeability_aggregate_state=blocked`.

The decision is to make Jangar consume Torghut's route warrant as the launch contract for every Torghut quant action.
Jangar may keep read-only status, dashboards, and observe-only assessment running. It may launch a bounded
zero-notional repair only when the Torghut warrant names the dependency split, the target value gate, and the expected
output receipt. It must hold normal implement work, paper support, live support, deploy widening, and merge-ready
claims while the warrant is blocked by stale empirical jobs, missing forecast registry evidence, disabled simple
submission, stale TCA, or stale ingestion/materialization clocks.

The tradeoff is intentional friction. Jangar will dispatch fewer Torghut runs until route warrants are current. I
accept that because the business metric is routeable post-cost profit evidence and live readiness without weakening
capital safety, not raw run volume.

## Governing Runtime Requirements

Every Torghut quant run must cite the governing Torghut design or runtime requirement before changing code.
Implementation stages must improve readiness, profit evidence, data freshness, execution quality, or capital safety.
Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker preventing
revenue impact.

This design maps Jangar dispatch decisions to the value gates:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `capital_gate_safety`
- `post_cost_daily_net_pnl`

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Rollout

- Runtime identity is `system:serviceaccount:agents:agents-sa`; in-cluster Kubernetes reads are authorized even though
  `kubectl config current-context` is unset.
- Argo reports `jangar` `Synced/Healthy`, `torghut` `Synced/Degraded`, and `torghut-options` `Synced/Healthy`.
- Jangar is serving image `registry.ide-newton.ts.net/lab/jangar:8ae0f291` and the control-plane pod is serving
  `registry.ide-newton.ts.net/lab/jangar-control-plane:8ae0f291`.
- Torghut is serving image digest
  `sha256:4ba6741297302675c4947add84fd2905b5420bc4513672022f5661bae402b04e`; the rollout completed, but readiness
  and startup probe failures appeared during the rollout.
- Recent Torghut events include duplicate ClickHouse PodDisruptionBudget warnings, a missing Keeper PDB target, and
  completed migration/backfill jobs.
- Jangar control-plane watch reliability is healthy: the sampled 15-minute window had `2648` events, `0` errors, and
  `0` restarts.

### Runtime And Data

- Jangar `/api/agents/control-plane/status` reports database health, migration consistency `29/29`, and latest
  migration `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Jangar execution trust is degraded because the implement stage is stale. The stale-stage signal is the main
  control-plane blocker, not a serving outage.
- Jangar records fresh Torghut consumer evidence:
  `torghut-route-proven-profit:aa5a577cc116cff0`, generated `2026-05-13T00:13:02.509509+00:00`.
- The same evidence requires repair: `max_notional=0`, `route_repair_value=14`,
  `accepted_routeable_candidate_count=0`, and blockers include `empirical_jobs_degraded`,
  `forecast_registry_degraded`, `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and `degraded`.
- Jangar Postgres has substantial retained run debt: `241` failed AgentRuns, `5` pending, `34` running, and `591`
  succeeded at the sample point.
- Recent Jangar resource state shows `codex-spark-agent` with `92` failed, `6` running, and `520` succeeded resources
  in the last eight hours; Torghut fundamentals and news agents also carry failed/pending resource debt.
- `torghut_control_plane.quant_metrics_latest` is fresh, with `4536` rows and newest
  `updated_at=2026-05-13T00:15:05.655Z`; most rows are still `insufficient_data`.
- `torghut_control_plane.quant_pipeline_health` proves the split: compute rows are current with max lag `3` seconds,
  while ingestion includes max lag `1728000` seconds and materialization has mixed current and non-current rows.

### Source

- `services/jangar/src/server/control-plane-status.ts` is `796` lines and already aggregates execution trust,
  database, watch reliability, and Torghut consumer evidence. It should remain a status reducer, not a Torghut capital
  authority.
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` is the correct integration boundary for
  route warrants. Jangar should consume Torghut receipts there and emit dispatch verdicts beside the existing
  control-plane status.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is `403` lines and
  `torghut-quant-runtime.ts` is `817` lines. They should remain latest/runtime read paths, not proof-history scanners.
- The missing invariant is dispatch custody: a Jangar run that can change source, deploy, widen paper, or support live
  trading must cite a current Torghut warrant or be limited to a zero-notional repair packet.

## Problem

Jangar can be serving and still launch the wrong class of Torghut work.

The failure modes are concrete:

1. Serving readiness can be interpreted as dispatch readiness while execution trust is degraded.
2. Global latest metrics can be fresh while scoped ingestion/materialization clocks are stale.
3. Torghut can publish a fresh consumer evidence receipt whose capital decision is still repair-only.
4. A scheduler can create more implement attempts without naming the stale dependency, target value gate, or expected
   output receipt.
5. Deployer can see a synced image while `/readyz`, `/trading/health`, or capital gates remain blocked.
6. Merge-ready claims can skip live evidence that routeable candidates, TCA, empirical replay, and submission gates
   have settled.

The control plane needs one dispatch verdict that separates read-only visibility, zero-notional repair, normal
implementation, paper support, live support, and deploy widening.

## Alternatives Considered

### Option A: Let Torghut Reject Unsafe Work At Runtime

Jangar would continue launching Torghut runs based on schedules, branch state, and general readiness. Torghut would
reject unsafe routes through `/readyz`, live submission gates, and capital state.

Advantages:

- Keeps capital truth in Torghut.
- Avoids adding a new Jangar reducer.
- Preserves current scheduler throughput.

Disadvantages:

- Jangar still owns run creation and can spend capacity on unfocused work.
- Failed or stale implement attempts increase noise before Torghut rejects them.
- Engineer and deployer stages still lack one launch reference tying work to a value gate.

Decision: reject. Torghut owns capital truth; Jangar owns launch custody.

### Option B: Freeze All Torghut Dispatch Until Readiness Is Green

Jangar would block every Torghut quant run while execution trust is degraded, Torghut is degraded, empirical jobs are
stale, or routeable candidates are zero.

Advantages:

- Strong failure-mode reduction.
- Simple to audit.
- Prevents accidental paper or live widening.

Disadvantages:

- Blocks the repair work required to make readiness green.
- Treats an observe-only ingestion repair and a live capital action as the same risk.
- Creates pressure for manual exceptions outside the proof path.

Decision: reject as the normal posture. Keep it as the emergency brake if route warrant integrity fails.

### Option C: Route-Warrant Dispatch Custody

Jangar consumes Torghut route warrants and emits a dependency verdict per action class. Read-only work may continue.
Zero-notional repair can launch only with a current packet. Normal implement, paper, live, deploy-widen, and
merge-ready actions remain held until route warrants settle.

Advantages:

- Reduces false-ready dispatch while preserving bounded repair.
- Converts schedule pressure into value-gate-priced work.
- Gives engineer, deployer, and verify stages a single evidence reference.
- Keeps capital authority in Torghut and dispatch authority in Jangar.
- Maps directly to the required value gates.

Disadvantages:

- Adds one control-plane receipt and scheduler integration path.
- Requires stage prompts and progress comments to cite warrant ids.
- Lowers apparent run volume while dependency debt exists.

Decision: select Option C.

## Architecture

Jangar publishes `dependency_verdict_v1` for each Torghut action request:

```text
dependency_verdict_v1
  schema_version = jangar.dependency-verdict.v1
  verdict_id
  generated_at
  fresh_until
  repository
  branch
  swarm_name
  stage
  action_class                 # serve_readonly | observe | repair | implement | paper | live | deploy_widen | merge_ready
  decision                     # allow | repair_only | hold | block
  allowed_scope
  max_dispatches
  max_runtime_seconds
  max_notional
  execution_trust_ref
  source_rollout_ref
  argo_health_ref
  controller_watch_ref
  torghut_route_warrant_ref
  torghut_repair_packet_refs[]
  blocking_dependency_names[]
  blocking_reason_codes[]
  required_validation_commands[]
  rollback_gate
```

The reducer rules are deliberately small:

- `serve_readonly` may be `allow` when Jangar serving, database, and watch reliability are healthy.
- `observe` may be `allow` when the run is read-only and cites the current route warrant.
- `repair` may be `repair_only` when the route warrant is fresh, max notional is zero, and each packet maps to one
  value gate.
- `implement`, `paper`, `live`, `deploy_widen`, and `merge_ready` are `hold` while any blocker includes
  `empirical_jobs_degraded`, `forecast_registry_degraded`, `simple_submit_disabled`, stale TCA, stale ingestion, stale
  materialization, or routeable candidates at zero.
- `live` is `block` if the Torghut warrant does not explicitly state `capital_gate_safety=pass` and
  `max_notional>0` under Torghut authority.

## Implementation Scope

The next engineer milestone is bounded:

1. Add a route-warrant reader to `control-plane-torghut-consumer-evidence.ts` that extracts the Torghut warrant id,
   blocker codes, value-gate state, freshness, routeable candidate count, max notional, and repair packet ids.
2. Add a Jangar dependency-verdict reducer under `services/jangar/src/server/` and tests under
   `services/jangar/src/server/__tests__/`.
3. Expose the latest dependency verdict in `/api/agents/control-plane/status` without moving Torghut capital logic into
   Jangar.
4. Update scheduler or stage-admission code so Torghut quant implement/deploy/paper/live actions must cite a current
   verdict id.
5. Keep every repair launch at `max_notional=0` until Torghut publishes an accepted route warrant.

## Implementation Notes

The first Jangar implementation ships the dependency verdict in observe mode:

- `control-plane-torghut-consumer-evidence.ts` extracts route-warrant id, state, freshness, blocker dependencies,
  repair packet ids, target value gates, and value-gate states from Torghut consumer-evidence payloads.
- `control-plane-dependency-verdict.ts` emits per-action `dependency_verdict_v1` records and a
  `dependency_verdict_exchange` status envelope.
- `/api/agents/control-plane/status` exposes the exchange, while stage-clearance packets and schedule-runner stamps
  carry the dependency verdict id in shadow mode.

This does not grant capital authority in Jangar. Paper and live actions remain held or blocked unless Torghut publishes
an accepted, fresh route warrant with positive routeable candidates, explicit capital-gate pass evidence, and positive
max notional for live support.

## Validation Gates

- `capital_gate_safety`: a degraded or missing Torghut warrant must produce `hold` or `block`; no route may increase
  max notional from Jangar.
- `routeable_candidate_count`: normal implement/paper/live dispatch is held while accepted routeable candidates are
  zero.
- `zero_notional_or_stale_evidence_rate`: repair dispatch must name the stale or zero-notional dependency it is
  retiring.
- `fill_tca_or_slippage_quality`: dispatch cannot support paper/live until Torghut reports current active-symbol TCA
  and a slippage budget.
- `post_cost_daily_net_pnl`: live support remains blocked until Torghut publishes current post-cost daily net PnL
  evidence from paper or accepted canary routes.

Required local checks for the implementation PR:

- Targeted Jangar unit tests for the reducer and status payload.
- `bunx oxfmt --check` on touched TypeScript and docs.
- The smallest Jangar type/lint/test command documented by the changed package.

Required deployer checks after image promotion:

- Argo `jangar`, `agents`, and `torghut` application sync and health status.
- Jangar `/ready` and `/api/agents/control-plane/status`.
- Torghut `/healthz`, `/readyz`, `/trading/health`, and `/trading/consumer-evidence`.
- Evidence that Jangar verdicts hold paper/live while Torghut warrants remain repair-only.

## Rollout And Rollback

Roll out in observe mode first. The verdict appears in status and progress comments, but does not change dispatch.
Then enable repair-only enforcement for Torghut quant stages. Finally gate normal implement, paper, live, and
deploy-widen actions on a fresh verdict.

Rollback is simple and safe: disable verdict enforcement and return Jangar to read-only status display, while Torghut
capital gates continue to hold notional. If disabling enforcement is required, publish a NATS update naming the failed
verdict invariant and keep paper/live actions blocked until a follow-up PR restores the guard.

## Handoff

Engineer handoff: implement the Jangar dependency-verdict reducer and status integration. The first accepted PR should
prove that stale implement evidence plus Torghut repair-only warrants produce `repair_only` for repair and `hold` for
implement/paper/live.

Deployer handoff: do not widen Torghut action classes based on Jangar HTTP 200 alone. Require the dependency verdict,
Torghut route warrant, Argo sync, promoted image, and runtime health evidence in the rollout proof.

The next milestone improves `capital_gate_safety` and `zero_notional_or_stale_evidence_rate` immediately. It enables
future `routeable_candidate_count` and `post_cost_daily_net_pnl` movement only after Torghut publishes accepted route
warrants.
