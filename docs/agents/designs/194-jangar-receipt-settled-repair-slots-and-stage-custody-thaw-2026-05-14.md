# 194. Jangar Receipt-Settled Repair Slots And Stage-Custody Thaw (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar stage credit, material reentry, Torghut executable-alpha repair admission, no-delta debt, rollout
verification, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md`

Extends:

- `docs/agents/designs/193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`
- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`
- `docs/torghut/design-system/v6/197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`

## Decision

I am selecting **receipt-settled repair slots** as the next Jangar architecture increment.

The control plane is serving, but the material path is still held. On 2026-05-14, the `agents`, `jangar`, and
`torghut` Argo applications were `Synced/Healthy` at revision `567e9ca3831d028fd2e978ad6dd27b76c87b59f4`.
Deployments were ready: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, and Torghut active revision
`torghut-00371=1/1`. `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election
enabled, execution trust healthy, and Torghut consumer evidence current.

That is not enough to open normal dispatch. The richer control-plane status route reported
`ready_action_exchange.status=block`, stage credit decisions for `discover`, `plan`, `implement`, `verify`,
`deploy_widen`, and `merge_ready` were held by `stage_credit_insufficient`, `controller_heartbeat_not_current`,
`source_rollout_truth_hold`, and `evidence_clock_custody_blocked`, and the evidence-pressure ledger was `pressured`.
The retained AgentRun surface shows why that matters: the cluster currently has 775 AgentRuns, including 119 failed
runs, and recent Jangar/Torghut schedule pods include 43 `Error`, 3 `OOMKilled`, and 1 `ContainerStatusUnknown` in the
filtered control-plane set. More broad dispatch is not the safe response.

At the same time, Torghut now exposes a concrete zero-notional repair receipt. `GET /trading/revenue-repair` returns
`business_state=repair_only`, top queue item `repair_alpha_readiness`, value gate `routeable_candidate_count`,
required output `torghut.executable-alpha-receipts.v1`, and an executable alpha repair receipt selected for
`H-CONT-01` with `max_notional=0`, `capital_rule=zero_notional_repair_only`, and validation command
`uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window`.

The selected design lets Jangar thaw exactly one bounded `dispatch_repair` slot when a current Torghut executable
alpha repair receipt, current Jangar material reentry receipt, and current stage credit ledger agree on the same
repair objective. It does not thaw `dispatch_normal`, `deploy_widen`, `merge_ready`, paper canary, or live canary. It
does not change capital safety. It turns the current design stack from "held with useful proof nearby" into a
specific runner slot with settlement requirements.

The tradeoff is stricter launch accounting. Some useful repair attempts remain held if they cannot bind to the
selected receipt, a fresh source/serving snapshot, and a no-delta settlement key. I accept that tradeoff because the
business metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout time, not higher raw launch
volume.

## Governing Runtime Requirements

This contract implements the active swarm validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: a repair slot is allocated only for one fresh receipt and one dedupe key. A terminal
  no-delta or failed run burns the slot until the receipt, source ref, blocker set, or evidence window changes.
- `pr_to_rollout_latency`: deployer stages may cite the slot as bounded repair evidence, but cannot treat it as
  rollout health until the PR, CI, Argo revision, workload images, `/ready`, and Torghut repair receipt settle.
- `ready_status_truth`: `/ready=ok` remains serving truth. Material readiness stays held except for the named
  zero-notional repair slot.
- `manual_intervention_count`: the operator does not choose from long reason-code lists; the slot names one receipt,
  one command, one max runtime, one rollback target, and one next engineer action.
- `handoff_evidence_quality`: engineer and deployer handoffs must cite the slot id, source revenue-repair digest,
  selected executable alpha repair receipt, material reentry receipt, validation command, and settlement outcome.

## Current Evidence

All runtime evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows,
trading flags, broker state, GitOps applications, AgentRuns, or market data.

### Cluster, Rollout, And AgentRuns

- Local branch: `codex/swarm-jangar-control-plane-plan`, based on `origin/main`.
- Kubernetes context was bootstrapped locally as `in-cluster` because the workspace had no current context. The
  service account is `system:serviceaccount:agents:agents-sa`.
- Argo: `agents`, `jangar`, and `torghut` were `Synced/Healthy/Succeeded` at
  `567e9ca3831d028fd2e978ad6dd27b76c87b59f4`.
- Deployments: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, `torghut-00371=1/1`, and
  `torghut-sim-00469=1/1`.
- Recent events show rollout churn that settled: transient readiness probe failures on replacing `agents`,
  `agents-controllers`, `jangar`, and Torghut Knative revisions, followed by successful pod starts and completed jobs.
- AgentRun objects in `agents`: 775 total, with 628 `Succeeded`, 119 `Failed`, 11 `Pending`, 5 `Running`, and
  12 `Template`.
- Filtered Jangar/Torghut control-plane pods: 173 total, with 121 `Completed`, 43 `Error`, 3 `OOMKilled`,
  5 `Running`, and 1 `ContainerStatusUnknown`.
- Recent failures included a Jangar plan schedule pod, Torghut quant plan schedule pod, Torghut quant discover OOM,
  and verify/implement cron failures. That failure tail argues for receipt dedupe before any new broad dispatch.

### Ready And Control-Plane Truth

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election active, execution trust
  healthy, and Torghut consumer evidence `current`.
- The same `/ready` payload showed the serving process did not run the agents, orchestration, or supporting
  controllers (`enabled=false`, `started=false`). Material authority should therefore come from
  `/api/agents/control-plane/status`, not the serving-process controller fields.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned a
  `ready_action_exchange` in `observe` mode with `status=block`. It allowed `serve_readonly` and `torghut_observe`,
  held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked live
  capital actions.
- Stage credit ledger `0545bac701902318` had `dispatch_repair` held and required a fresh execution TCA receipt inside
  the active observation epoch. Normal stages were held by controller heartbeat, source rollout truth, and stage credit
  insufficiency.
- Evidence pressure ledger `535d7abcfe9a70df` was `pressured`, with pressure sources for controller replica split and
  Torghut freshness. It gave `dispatch_repair` a repair-only budget but kept `dispatch_normal`, `deploy_widen`, and
  `merge_ready` held.

### Torghut Business And Data State

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `status=degraded`.
- Torghut dependencies were not the blocker: Postgres, ClickHouse, Alpaca, universe, empirical jobs, DSPy runtime,
  and optional quant evidence were healthy or acceptable.
- Torghut database schema was current: current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, schema graph lineage
  ready. Known parent-fork warnings remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Direct database reads were blocked for this AgentRun by RBAC and missing local `psql`; that is acceptable for this
  architecture lane because the application database witness is current and read-only.
- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, active revision
  `torghut-00371`, source commit `8d84f9f5ce028214bfb5326e0791638bc35625f5`, live submission disabled, capital stage
  `shadow`, proof floor `repair_only`, and max notional `0`.
- The top repair queue item was `repair_alpha_readiness` with reason `hypothesis_not_promotion_eligible`,
  value gate `routeable_candidate_count`, expected unblock value `4`, required output
  `torghut.executable-alpha-receipts.v1`, and max notional `0`.
- The selected executable alpha repair receipt was
  `executable-alpha-repair-receipt:a0e37a7c9b96f322d6f6bbac` for `H-CONT-01`, repair class
  `evidence_window_refresh`, expected delta `retire_post_cost_expectancy_non_positive`, and no-delta settlement
  required.
- Execution TCA data is populated but still problematic: 7,334 orders, 7,245 filled executions, last TCA computed
  2026-05-13T15:29:49Z, latest execution created 2026-04-02T19:00:29Z, average absolute slippage 13.82 bps, one
  routeable symbol (`AAPL`), four blocked symbols, and three missing symbols.
- Alpha readiness has three repair targets and zero promotion-eligible hypotheses. `H-CONT-01` and `H-REV-01` are
  blocked by non-positive post-cost expectancy; `H-MICRO-01` is blocked by missing drift checks, feature rows, and
  required feature set.

### Source Architecture And Test Gaps

- High-risk Jangar reducer modules are already broad:
  `control-plane-stage-credit-ledger.ts` is 594 lines,
  `control-plane-evidence-pressure-ledger.ts` is 679 lines,
  `control-plane-action-custody.ts` is 595 lines, and
  `control-plane-torghut-consumer-evidence.ts` is 758 lines.
- High-risk Torghut proof modules are also broad:
  `revenue_repair.py` is 1,036 lines,
  `executable_alpha_receipts.py` is 1,146 lines,
  `route_evidence_clearinghouse.py` is 716 lines, and
  `zero_notional_repair_executor.py` is 576 lines.
- Existing tests cover stage credit, evidence pressure, ready truth, action custody, Torghut consumer evidence, and
  executable alpha repair receipts. The missing test family is cross-plane slot settlement: given a current selected
  executable alpha repair receipt and held stage credit, Jangar should allocate exactly one repair slot, stamp the
  governing refs, and block another slot until an after receipt or no-delta settlement appears.

## Problem

The architecture has reached a useful but incomplete point. Jangar can see the Torghut repair receipt, and Torghut can
name the business blocker. Jangar still cannot safely spend the slot.

The current failure modes are concrete:

1. `/ready=ok` can coexist with held material readiness. Operators need a repair exception that is explicit, not
   inferred from serving health.
2. Stage credit sees broad debt and withholds all dispatch credit, even when a current zero-notional receipt names a
   bounded repair.
3. Torghut emits a selected executable alpha repair receipt, but Jangar does not yet convert it into a runner-slot
   future with no-delta settlement.
4. The failure tail includes schedule errors, OOMs, and old AgentRun failures. A repair attempt without a dedupe key
   can become another repeated failed run.
5. Torghut capital is correctly zero-notional. A repair slot must not be confused with paper or live capital release.

The system needs one new boundary: a receipt-settled repair slot that can thaw exactly the selected repair and then
settle as retired, improved, no-delta, invalidated, failed, or superseded.

## Alternatives Considered

### Option A: Keep Stage Credit Fully Held Until All Inputs Are Green

This option leaves stage credit as-is. No dispatch repair runs until controller heartbeat, source rollout truth,
evidence clock, execution TCA, market context, and alpha readiness are all green.

Advantages:

- Maximum safety.
- No new reducer or status object.
- Easy to reason about during incidents.

Disadvantages:

- Deadlocks the selected alpha repair because the repair itself is needed to make Torghut greener.
- Increases manual intervention for a repair with current zero-notional proof.
- Does not reduce failed schedule churn; it only suppresses all work.

Decision: reject as the steady-state architecture. Keep it as emergency rollback.

### Option B: Let Torghut Self-Dispatch Alpha Repair Outside Jangar Stage Credit

Torghut would run the selected executable alpha repair without asking Jangar stage credit for a slot.

Advantages:

- Fastest path to trying the repair.
- Keeps Jangar dispatch logic simpler.
- Avoids waiting on controller heartbeat and source rollout reconciliation.

Disadvantages:

- Splits audit custody from Jangar, the system accountable for AgentRun reliability.
- Weakens the swarm validation requirement that every run cite the governing design or runtime requirement.
- Makes no-delta debt invisible to Jangar stage admission.
- Risks parallel repair launches when the revenue-repair digest refreshes frequently.

Decision: reject. Torghut owns the business evidence; Jangar owns launch custody.

### Option C: Receipt-Settled Repair Slots

Jangar builds a pure read model that consumes stage credit, evidence pressure, material reentry, Torghut consumer
evidence, and Torghut executable alpha repair receipts. It emits one repair slot only when all selected refs agree.

Advantages:

- Lets the top zero-notional repair proceed without reopening normal dispatch.
- Keeps source, readiness, and no-delta evidence in one audit object.
- Reduces failed AgentRun risk by deduping on selected receipt, source ref, blocker set, and evidence window.
- Gives engineer and deployer stages a testable acceptance gate.
- Preserves capital safety by keeping max notional `0` and live submission disabled.

Disadvantages:

- Adds another reducer and status object.
- Requires Jangar to understand the Torghut selected executable-alpha receipt shape.
- The first rollout must run in observe mode before enforcement.

Decision: select Option C.

## Architecture

The new read model is `repair_slot_escrow`.

```text
repair_slot_escrow
  schema_version = jangar.repair-slot-escrow.v1
  escrow_id
  generated_at
  fresh_until
  namespace
  mode = observe | shadow | hold | enforce
  governing_design_refs[]
  selected_slot_id
  slots[]
  blocked_slots[]
  no_delta_debt[]
  scheduler_handoff
  deployer_handoff
  rollback_target
```

Each slot is intentionally small:

```text
repair_slot
  slot_id
  action_class = dispatch_repair
  state = observe_only | open | held | blocked | settled | superseded
  source_revenue_repair_ref
  torghut_selected_receipt_id
  torghut_selected_receipt_schema
  material_reentry_receipt_id
  stage_credit_ledger_id
  stage_credit_account_id
  evidence_pressure_ledger_id
  target_value_gate
  expected_gate_delta
  required_output_receipts[]
  validation_commands[]
  max_parallelism = 1
  max_runtime_seconds
  max_notional = 0
  dedupe_key
  before_refs[]
  after_refs[]
  settlement_state = pending | retired | improved | no_delta | invalidated | failed
  rollback_target
```

Admission rules:

1. A slot can open only for `dispatch_repair`.
2. The Torghut revenue-repair top queue item must be `repair_alpha_readiness`.
3. The selected executable alpha repair receipt must be current, zero-notional, and tied to the same source
   revenue-repair digest.
4. The Jangar material reentry receipt must cite the same Torghut selected receipt and `dispatch_repair`.
5. Stage credit must be in `observe`, `shadow`, or `hold` mode; `enforce` can open the slot only after shadow evidence
   proves no false positives.
6. Evidence pressure can tax the slot but cannot open more than one concurrent dispatch.
7. The dedupe key is a hash of the source revenue-repair ref, selected receipt id, hypothesis id, target value gate,
   before reason codes, source commit, serving revision, and validation command set.
8. A terminal no-delta, failed, or invalidated settlement blocks another slot with the same dedupe key until one input
   changes.
9. Paper and live capital remain blocked until a separate capital reentry receipt exists and ready truth no longer
   blocks those action classes.

## Implementation Scope

M1: Add the Jangar read model and tests.

- Add `services/jangar/src/server/control-plane-repair-slot-escrow.ts`.
- Add data types in `services/jangar/src/server/control-plane-status-types.ts`.
- Wire the object into `/api/agents/control-plane/status` and `/ready` in observe mode.
- Tests:
  - current executable alpha repair receipt opens one observe-only `dispatch_repair` slot;
  - stale receipt blocks the slot;
  - nonzero notional blocks the slot;
  - no-delta debt blocks repeated launch for the same dedupe key;
  - changed receipt, source ref, blocker set, or evidence window reopens the lane.

M2: Stamp repair-slot refs on admitted schedule-runner launches in observe mode.

- Stamp `swarmRepairSlotEscrowId`, `swarmRepairSlotId`, `swarmRepairSlotDedupeKey`,
  `swarmTorghutExecutableAlphaRepairReceiptId`, and governing design refs.
- Do not enforce at first; log and surface the would-have-opened slot.
- Tests: schedule runner carries the fields when the slot is open and omits them when stale or blocked.

M3: Add settlement ingestion.

- Consume terminal AgentRun outcome plus Torghut after receipt.
- Mark the slot as `retired`, `improved`, `no_delta`, `invalidated`, or `failed`.
- Convert no-delta and failed settlements into retained debt for stage credit.
- Tests: no-delta blocks relaunch; improved/retired clears the dedupe key.

M4: Move `dispatch_repair` to hold/enforce only after observe evidence is clean.

- Gate on at least one day with zero false-open slots and no repeated no-delta launches.
- Keep `dispatch_normal`, `deploy_widen`, `merge_ready`, paper, and live blocked by their current gates.

## Validation

Local validation for the first implementation PR:

- `bunx oxfmt --check services/jangar/src/server/control-plane-repair-slot-escrow.ts services/jangar/src/server/control-plane-status-types.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-repair-slot-escrow.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/routes/ready.test.ts`
- `uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window`

Runtime validation after merge and promotion:

- `kubectl -n argocd get applications.argoproj.io agents jangar torghut`
- `kubectl -n agents rollout status deploy/agents`
- `kubectl -n agents rollout status deploy/agents-controllers`
- `kubectl -n jangar rollout status deploy/jangar`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.repair_slot_escrow'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.repair_slot_escrow'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.executable_alpha_repair_receipts.selected_receipt'`

Acceptance gates:

- Exactly one selected repair slot for `dispatch_repair` when Torghut selected receipt is current.
- No slot for nonzero notional, stale receipt, missing material reentry receipt, or mismatched source revenue-repair
  digest.
- No broad `dispatch_normal`, `deploy_widen`, `merge_ready`, paper, or live capital thaw.
- A no-delta terminal run blocks relaunch for the same dedupe key.
- Handoff includes slot id, selected Torghut receipt id, validation command, settlement state, and rollback target.

## Rollout

Phase 0 is documentation and test contract.

Phase 1 emits `repair_slot_escrow` in observe mode on status routes only. This is safe because it does not change
launch behavior.

Phase 2 stamps schedule-runner launches with repair-slot refs in observe mode. It still does not block launches.

Phase 3 changes `dispatch_repair` to hold mode for repeated no-delta keys only. A missing slot records a warning in
observe/shadow, then holds in hold/enforce.

Phase 4 enforces one-slot repair admission for Torghut alpha repair. `dispatch_normal`, deployer, paper, and live
capital remain governed by the existing material-readiness and ready-truth gates.

## Rollback

Rollback is staged:

1. Set `JANGAR_REPAIR_SLOT_ESCROW_MODE=observe`.
2. If status payload generation breaks, set `JANGAR_REPAIR_SLOT_ESCROW_ENABLED=false`.
3. Keep ready truth, stage credit, evidence pressure, material reentry, and Torghut revenue repair active.
4. Do not delete slot, receipt, AgentRun, job, or database evidence. Mark stale or superseded objects in status.
5. Keep Torghut max notional `0` and live submission disabled.

## Risks

- Receipt schema drift: Jangar may parse a Torghut receipt that changes shape. Mitigation: strict schema version checks
  and tests for missing selected receipt fields.
- False-open slot: a slot may open while source rollout truth is still split. Mitigation: observe mode first, require
  material reentry receipt and source revenue-repair digest agreement.
- Repair churn: the selected receipt can refresh every minute. Mitigation: dedupe key includes stable receipt inputs,
  not generated timestamp alone.
- No-delta overblocking: useful groundwork may not move the value gate immediately. Mitigation: allow an engineer to
  attach a new evidence window, changed blocker set, or explicit invalidation receipt to reopen.
- Capital confusion: zero-notional repair could be mistaken for paper approval. Mitigation: slot action class is only
  `dispatch_repair`, max notional is always `0`, and capital actions remain blocked by ready truth.

## Handoff

Engineer handoff:

- Implement M1 first as a pure read model.
- Use the current selected Torghut receipt
  `executable-alpha-repair-receipt:a0e37a7c9b96f322d6f6bbac` as the fixture shape, but keep tests deterministic.
- Do not change scheduler enforcement until the observe payload and tests are green.
- The exact next production PR should add the reducer, types, status exposure, and tests.

Deployer handoff:

- Do not widen based on `repair_slot_escrow` alone.
- Treat a slot as permission for one zero-notional repair attempt only after it is emitted by the promoted image and
  stamped onto a launch.
- Verify Argo, deployment readiness, `/ready`, control-plane status, and Torghut `/trading/revenue-repair` after
  rollout.
- Roll back by disabling the repair slot escrow, not by deleting receipts or AgentRuns.

Final metric target:

- Improve `failed_agentrun_rate` by preventing repeated no-delta repair launches.
- Improve `manual_intervention_count` and `handoff_evidence_quality` by giving engineer and deployer stages one slot
  id and one selected receipt to cite.
- Preserve `ready_status_truth` by keeping serving readiness distinct from material repair-slot admission.
