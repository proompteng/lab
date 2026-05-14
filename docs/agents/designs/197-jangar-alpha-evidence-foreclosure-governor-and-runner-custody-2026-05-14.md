# 197. Jangar Alpha Evidence Foreclosure Governor And Runner Custody (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar Torghut evidence admission, alpha evidence foreclosure, no-delta runner custody, repair dispatch safety,
validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/202-torghut-alpha-evidence-foreclosure-and-routeable-candidate-reentry-2026-05-14.md`

Extends:

- `196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md`
- `195-jangar-receipt-backed-alpha-foundry-and-rollout-safety-covenant-2026-05-14.md`
- `194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md`
- `193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`

## Decision

I am selecting a **Jangar alpha evidence foreclosure governor** for the next control-plane reliability increment.

Torghut now publishes enough typed evidence for Jangar to avoid broad repair dispatch. On 2026-05-14 at 04:10 UTC,
the Torghut revenue surface reported `business_state=repair_only`, `revenue_ready=false`,
`accepted_routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=1.0`, and
`max_notional=0`. The top queue item was still `repair_alpha_readiness`, and the current alpha evidence foundry carried
no-delta receipts whose measured routeable candidate delta was `0`.

Jangar's role is not to pick a trading strategy. Torghut owns that decision. Jangar's role is to protect runner
capacity and material-action truth. The selected behavior is to consume Torghut's compact
`alpha_evidence_foreclosure_ref`, deny duplicate zero-notional alpha repair runner launches for unchanged no-delta
keys, and allow a new runner only when Torghut proves that source commit, evidence window, blocker digest, required
receipt set, or terminal settlement changed.

The tradeoff is lower runner throughput. That is intentional. The cluster already shows repeated failed, errored, and
OOMKilled AgentRun pods across Jangar and Torghut lanes. More starts are not leverage unless each start is tied to the
live revenue queue and a terminal after-receipt.

## Governing Runtime Requirements

This design follows the active swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value gates:

- `failed_agentrun_rate`: deny repeat no-delta launch keys before another runner is created.
- `ready_status_truth`: keep Jangar `/ready` separate from permission to dispatch material Torghut work.
- `manual_intervention_count`: convert a broad queue into one current, typed foreclosure decision.
- `handoff_evidence_quality`: require book id, selected hypothesis, no-delta key, release condition, validation
  command, and rollback target in the handoff.
- `pr_to_rollout_latency`: shorten verification by giving deployers one compact Torghut ref to capture.

Torghut value gates carried through Jangar:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

## Read-Only Evidence Snapshot

Evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, trading flags,
GitOps resources, AgentRuns, or broker state.

### Cluster And Control Plane

- The current workspace branch was `codex/swarm-torghut-quant-discover`, based on `origin/main` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- Argo reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at the same revision.
- Agents pods were available, with `agents`, `agents-controllers`, and `agents-alloy` running.
- Jangar pods were running, including `jangar-7b97b57567-45294`, `bumba`, the Jangar database, Open WebUI Redis, and
  Symphony services.
- The agents namespace retained many completed, errored, and OOMKilled Jangar/Torghut AgentRun pods, including recent
  Torghut quant discover, implement, and verify attempts. That tail is the control-plane failure mode this governor
  reduces.
- Torghut live and sim revisions were running on `torghut-00376` and `torghut-sim-00474`; options catalog and enricher
  were running; Postgres, ClickHouse, Keeper, TA, TA sim, WebSocket services, and guardrail exporters were running.

### Torghut Evidence Seen By Jangar

- `/trading/revenue-repair` was the live business evidence surface.
- Business state was `repair_only`; revenue was not ready.
- Top queue item was `repair_alpha_readiness`, selected value gate `routeable_candidate_count`, required output
  `torghut.executable-alpha-receipts.v1`, expected unblock value `4`, capital rule `zero_notional_repair_only`, and
  `max_notional=0`.
- Alpha readiness had 3 hypotheses, 0 promotion-eligible hypotheses, 2 rollback-required lanes, and H-MICRO-01 as the
  only lineage-ready lane.
- Alpha evidence-window receipts preserved blockers and reported `measured_routeable_candidate_delta=0`.
- Routeability acceptance stayed blocked with accepted routeable candidate count `0`.
- Repair-bid settlement exposed 33 raw bids, 6 compacted lots, 5 selected lots, and 3 dispatchable lots.
- Runtime profitability over 72 hours had 68 decisions, 0 executions, 6250 TCA samples, and negative TCA-derived PnL
  proxy. This is evidence for caution, not a reason to loosen capital.

### Database And Source Witnesses

- Direct CNPG reads and pod exec were forbidden to the service account, so Jangar should continue to rely on typed
  Torghut HTTP evidence rather than direct DB reads.
- Torghut `/db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`, with one schema graph
  branch, no missing heads, no unexpected heads, and lineage ready.
- Source modules already exist for alpha evidence foundry, alpha repair closure board, executable alpha receipts,
  routeability repair acceptance, and repair-bid settlement. The missing Jangar behavior is not parsing more fields; it
  is runner custody for unchanged no-delta foreclosure keys.

## Problem

Jangar can admit zero-notional repair work, but it does not yet have a foreclosure governor that prevents unchanged
alpha evidence no-delta work from spending another runner slot.

The concrete failure modes are:

1. A current Torghut evidence packet can be treated as generally dispatchable even when it carries active no-delta debt.
2. Jangar can launch a second runner for the same alpha evidence-window key before Torghut proves that the source or
   blocker set changed.
3. Failed or OOMKilled AgentRuns can repeat against stale work because the launch key is not tied to a terminal
   settlement receipt.
4. `/ready=ok` can be misread as permission to widen action classes, even though Torghut is still `repair_only` and
   `max_notional=0`.
5. Deployer handoffs can prove Argo health and still miss the business truth: routeable candidate count remains zero.
6. Manual operators have to inspect large Torghut payloads instead of one compact foreclosure decision.

Jangar needs to enforce runner custody from typed Torghut evidence while leaving strategy and capital authority inside
Torghut.

## Alternatives Considered

### Option A: Admit Any Dispatchable Torghut Repair Lot

Jangar continues to launch when repair-bid settlement reports dispatchable lots and capital remains zero.

Advantages:

- Simple implementation.
- Uses existing Jangar parsing.
- Keeps the repair system moving.

Disadvantages:

- Ignores active no-delta debt.
- Does not reduce failed or duplicate runner launches.
- Can spend runner capacity without moving routeable candidate count.
- Leaves deployer handoff dependent on large payload inspection.

Decision: reject. Dispatchable is necessary but not sufficient.

### Option B: Freeze All Torghut Alpha Repair Until Routeability Improves

Jangar denies every Torghut alpha repair until routeability acceptance reports a positive candidate count.

Advantages:

- Very conservative.
- Eliminates duplicate alpha runner starts.
- Keeps capital safe.

Disadvantages:

- Deadlocks the system: routeability cannot improve without zero-notional repair work.
- Forces manual exceptions.
- Does not distinguish stale no-delta work from fresh release-key work.

Decision: reject. The governor needs selective denial, not a freeze.

### Option C: Foreclosure Governor With Release-Key Admission

Jangar consumes a compact Torghut foreclosure ref, denies unchanged no-delta launch keys, and allows a new runner only
when Torghut reports a changed release key or a terminal settlement receipt.

Advantages:

- Directly reduces duplicate and failed runner work.
- Keeps Torghut as the strategy and capital authority.
- Gives deployers one compact ref to verify.
- Preserves zero-notional safety while allowing fresh repair work.
- Maps every runner decision to the live revenue queue.

Disadvantages:

- Requires a new Jangar reducer and tests.
- Needs shadow-mode rollout before enforcement to avoid over-denial.
- Depends on Torghut emitting stable foreclosure keys.

Decision: select Option C.

## Architecture

Jangar consumes `torghut.alpha-evidence-foreclosure-ref.v1` from `/trading/consumer-evidence`.

```text
jangar.alpha-evidence-foreclosure-governor.v1
  governor_id
  generated_at
  fresh_until
  mode = observe | shadow | enforce
  torghut_consumer_evidence_ref
  torghut_alpha_evidence_foreclosure_ref
  selected_hypothesis_id
  selected_value_gate = routeable_candidate_count
  no_delta_key
  release_key
  required_after_receipts[]
  admission_decision = allow | hold | deny
  denied_reason_codes[]
  runner_slot_ref
  launch_ticket
  validation_commands[]
  rollback_target
```

Admission allows only when:

1. Torghut consumer evidence is current.
2. Foreclosure ref is current and schema-valid.
3. Selected value gate is `routeable_candidate_count`.
4. Selected hypothesis is the Torghut-selected reentry hypothesis.
5. The selected work has `max_notional=0`.
6. Live submission is disabled and capital stage is shadow.
7. The no-delta key is not active, or the release key changed.
8. Required output receipt is approved for zero-notional repair.
9. Action class is `dispatch_repair`; paper and live action classes remain held.

Admission denies when:

- `torghut_alpha_evidence_foreclosure_ref_missing`
- `torghut_alpha_evidence_foreclosure_ref_stale`
- `torghut_alpha_evidence_foreclosure_not_zero_notional`
- `torghut_alpha_evidence_foreclosure_gate_not_routeable_candidate_count`
- `alpha_evidence_no_delta_key_active`
- `alpha_evidence_release_key_unchanged`
- `live_submission_not_disabled`
- `capital_stage_not_shadow`
- `required_after_receipt_unapproved`

The runner ticket is compact:

```text
alpha_foreclosure_runner_ticket
  ticket_id
  source = torghut.alpha-evidence-foreclosure-ref.v1
  selected_hypothesis_id
  selected_lane_id
  no_delta_key
  release_key
  required_after_receipts[]
  validation_command
  expected_gate_delta
  max_notional = 0
```

Jangar stores enough local state to deny repeats within an enforcement window, but Torghut remains the source of truth
for the foreclosure key and terminal settlement.

## Implementation Scope

M1 consume and observe:

- Add a Jangar parser for `torghut.alpha-evidence-foreclosure-ref.v1`.
- Add a pure reducer that returns allow, hold, or deny in observe mode.
- Add tests for missing ref, stale ref, nonzero notional, wrong gate, active no-delta key, changed release key, and
  capital stage violations.

M2 shadow custody:

- Surface the governor decision in the existing Torghut revenue-repair/status control-plane response.
- Publish deny reasons without blocking runner creation.
- Capture decision counts for duplicate no-delta keys.

M3 enforcement:

- Deny repeat alpha evidence repair AgentRuns when the same no-delta key remains active and the release key is
  unchanged.
- Continue allowing unrelated zero-notional repairs that are not the selected alpha foreclosure key.
- Keep `dispatch_normal`, `deploy_widen`, `paper_canary`, and `live_canary` held.

M4 deployer verification:

- Capture Jangar ready, Torghut consumer evidence, Torghut revenue repair, foreclosure governor decision, and runner
  ticket state after rollout.

## Validation Gates

Local Jangar validation:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- Add a focused test file for the foreclosure governor and run it with the same workspace test command.
- `bunx oxfmt --check services/jangar/src/server`

Cross-plane validation:

- Torghut `/trading/consumer-evidence` includes `alpha_evidence_foreclosure_ref`.
- Jangar governor reports observe or shadow decision without mutating AgentRuns.
- Active no-delta key produces `admission_decision=deny` in shadow mode.
- Changed release key produces `admission_decision=allow` while `max_notional=0`.
- Jangar `/ready` remains about control-plane availability, not material trading readiness.

Business validation:

- Primary metric: `routeable_candidate_count`.
- Intermediate metric: duplicate no-delta runner starts for the same alpha evidence key should go to zero after
  enforcement.
- Safety metric: no paper or live action class opens while Torghut reports `max_notional=0`.

## Rollout

1. Ship parser and reducer in observe mode.
2. Verify Jangar can parse the compact ref from Torghut without changing runner behavior.
3. Enable shadow-mode denial metrics for active no-delta keys.
4. Compare shadow denials against actual launches for at least one deploy cycle.
5. Enable enforcement only for duplicate alpha evidence foreclosure keys.
6. Keep capital and action-class widening controlled by existing Torghut gates.

## Rollback

Rollback is to disable consumption of `alpha_evidence_foreclosure_ref` and return to existing repair-bid settlement
admission.

Safe rollback rules:

- Do not change Torghut capital flags.
- Do not delete local launch history; ignore it while the reducer is disabled.
- Keep Jangar typed consumer evidence admission intact.
- Keep paper and live action classes held unless independent capital gates clear.

Emergency rollback triggers:

- Governor denies changed release keys.
- Governor allows nonzero notional.
- Governor allows a wrong value gate.
- Jangar ready status becomes coupled to Torghut revenue readiness.
- Enforcement blocks unrelated zero-notional repair work outside the selected alpha foreclosure key.

## Risks

- If Torghut emits unstable no-delta keys, Jangar can under-deny duplicate work.
- If Torghut omits a legitimate release condition, Jangar can over-deny fresh work.
- Shadow-mode metrics can be noisy while older Torghut revisions do not publish the compact ref.
- Enforcement has to stay scoped to the selected alpha foreclosure key; broad repair denial would slow recovery.
- The cluster's AgentRun failure tail means the first enforcement should be narrow and easy to disable.

## Handoff

Engineer:

- Implement the parser and reducer as pure TypeScript server code with focused tests.
- Treat Torghut as the authority for selected hypothesis, value gate, no-delta key, release key, and notional.
- Keep enforcement behind a config flag until deployer evidence proves the ref is stable.

Deployer:

- Verify Argo sync, Jangar pod readiness, Torghut consumer-evidence ref presence, governor decision, and unchanged
  Torghut `max_notional=0`.
- In shadow mode, capture at least one active no-delta key and prove Jangar would deny a duplicate launch.
- Do not enable paper, live, or deploy-widen action classes from this rollout.

Next bounded milestone:

- Consume `torghut.alpha-evidence-foreclosure-ref.v1` in observe mode, publish the governor decision, and prepare the
  enforcement flag for duplicate no-delta alpha repair keys.
