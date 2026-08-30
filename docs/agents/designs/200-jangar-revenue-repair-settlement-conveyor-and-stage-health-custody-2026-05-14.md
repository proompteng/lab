# 200. Jangar Revenue Repair Settlement Conveyor And Stage Health Custody (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane admission, Torghut revenue-repair settlement custody, stage health, rollout proof,
duplicate no-delta suppression, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`

Extends:

- `199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- `198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md`
- `193-jangar-cross-plane-closure-board-and-revenue-repair-admission-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

## Decision

I am selecting **revenue-repair settlement conveyor custody with stage-health admission** as the next Jangar
control-plane increment.

The current cluster is serving, but it is not clean enough to treat every green service as launch authority. On
2026-05-14, Torghut, Torghut options, and Symphony Torghut were `Synced/Healthy`, and active Torghut revision
`torghut-00382` was running. At the same time, Jangar and agents were `Synced/Progressing`, the `torghut-quant` swarm
was `Active` but degraded on implement and verify stages, and this plan run had already retried after an OOMKilled
attempt. The system needs more than service health. It needs admission that understands Torghut's top revenue repair,
runner failure debt, and rollout proof.

The live Torghut business evidence is also clear. `/trading/revenue-repair` returned `business_state=repair_only`,
`revenue_ready=false`, accepted routeable candidate count `0`, `zero_notional_or_stale_evidence_rate=1.0`, and top
repair item `repair_alpha_readiness`. The top value gate is `routeable_candidate_count`, not generic dispatch volume.
Jangar should only spend repair capacity on a bounded Torghut settlement if the compact Torghut conveyor ref is
current, zero notional, tied to the live top queue item, and not blocked by an unchanged no-delta release key.

The selected design adds a Jangar custody reducer that consumes Torghut's compact
`torghut.alpha-readiness-settlement-conveyor-ref.v1`, stage health, source-serving rollout proof, retained failure
debt, and Argo/workload health. It does not replace ready truth. It gives ready truth one sharper input: whether a
material Torghut action is allowed, held, or denied for a specific settlement reason.

The tradeoff is that some repair runs will be held even when the cluster looks healthy. I accept that. The business
metric is routeable post-cost profit evidence and live trading readiness without weakening capital safety. Launching
another broad repair while the settlement receipt is missing, stale, or no-delta-locked increases failure rate without
improving `routeable_candidate_count`.

## Governing Runtime Requirements

This contract implements the active cross-swarm validation requirements:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value-gate mapping:

- `failed_agentrun_rate`: deny duplicate repair launches when the compact conveyor has active no-delta debt and an
  unchanged release key.
- `pr_to_rollout_latency`: require deployer handoff to cite PR, image, Argo, workload, service health, and Torghut
  settlement state before claiming ready.
- `ready_status_truth`: keep service readiness distinct from material action authority.
- `manual_intervention_count`: reduce operator triage by choosing one current Torghut settlement lane and one denial
  reason.
- `handoff_evidence_quality`: require every handoff to cite the compact conveyor id, selected hypothesis, value gate,
  validation command, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: Jangar only dispatches repair work if it can plausibly move this value gate or record a
  valid no-delta settlement.
- `zero_notional_or_stale_evidence_rate`: stale compact refs are launch-deny evidence.
- `fill_tca_or_slippage_quality`: Jangar preserves TCA holds after alpha-readiness settlement, but it does not allow
  TCA work to overtake the live top repair.
- `post_cost_daily_net_pnl`: Jangar does not widen capital until Torghut carries post-cost evidence.
- `capital_gate_safety`: any compact ref with `max_notional` other than `0` is denied unless a later capital-release
  design explicitly changes the rule.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, broker
state, trading flags, GitOps resources, AgentRuns, or market data.

### Cluster And Stage Health

- `torghut`, `torghut-options`, and `symphony-torghut` Argo applications were `Synced/Healthy`.
- `jangar` and `agents` were `Synced/Progressing`.
- Torghut live revision `torghut-00382` and sim revision `torghut-sim-00480` were running and available.
- Torghut namespace events showed normal rollout replacement and post-sync job completion, plus transient probe
  failures during revision startup and repeated ClickHouse PodDisruptionBudget ambiguity warnings.
- The `torghut-quant` swarm was `Active`, not frozen, but stage health was degraded for implement and verify.
- The `jangar-control-plane` swarm was `Active`, not frozen, but stage health was degraded for verify.
- Recent AgentRuns showed successful work mixed with verify failures, implement failures, OOMKilled attempts, and
  market-context fundamentals failures. The current plan run had one OOMKilled attempt before the active retry.

### Torghut Business Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, top queue item
  `repair_alpha_readiness`, value gate `routeable_candidate_count`, required output
  `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- Routeability acceptance reported `accepted_routeable_candidate_count=0`,
  `zero_notional_or_stale_evidence_rate=1.0`, and aggregate state `blocked`.
- Alpha readiness reported three hypotheses, zero promotion-eligible hypotheses, and two rollback-required
  hypotheses.
- `H-MICRO-01` is the first viable settlement lane because strategy lineage is ready while the blocker set is bounded
  to stale hypothesis-window evidence, empirical jobs, drift or forecast evidence, schema-lineage escrow, and no
  promotion certificate.
- `/trading/consumer-evidence` was available and current, with a current consumer-evidence canary and route-proven
  profit receipt. It still carried decision `repair`, proof floor `repair_only`, route state `repair_only`, capital
  state `zero_notional`, and `max_notional=0`.

### Database And Data Quality

- Direct Torghut CNPG psql was blocked by least-privilege RBAC; Jangar must not require this worker identity to inspect
  database rows directly.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and
  `schema_graph_lineage_ready=true`.
- The schema witness reported historical parent-fork warnings, so Jangar must consume Torghut's schema-lineage
  settlement state rather than infer lane readiness from DB head alone.
- `/readyz` returned HTTP 503 with degraded status for the correct reason: live submission was closed and proof floor
  was `repair_only`. Postgres, ClickHouse, Alpaca, database schema, static universe, and optional quant evidence were
  healthy.

### Source And Test Surface

- Jangar's high-risk path for this design is `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
  at 784 lines, `control-plane-status.ts` at 757 lines, and `control-plane-ready-truth-arbiter.ts` at 478 lines.
- Torghut's high-risk producer path is `services/torghut/app/main.py`, `revenue_repair.py`,
  `alpha_evidence_foundry.py`, `alpha_repair_closure_board.py`, and `submission_council.py`.
- Existing tests cover Torghut consumer evidence, routeability repair acceptance, revenue repair, alpha evidence,
  alpha repair closure, and Jangar ready truth. The missing test family is cross-plane conveyor custody: current ref
  allow, missing/stale ref hold, nonzero-notional deny, unchanged no-delta deny, stage-health hold, and rollout proof
  merge gate.

## Problem

Jangar can see Torghut repair evidence, but it does not yet have a material-action custody rule that binds repair
dispatch to the current Torghut settlement lane and stage health.

The concrete failure modes are:

1. Service health can be green while swarm implement or verify stage health is degraded.
2. A broad Torghut repair action can launch without proving it targets the live top revenue-repair queue item.
3. Repeated no-delta repair attempts can consume runner capacity when source ref, evidence window, blocker set, and
   required receipt set have not changed.
4. Rollout proof can be split across PR, image, Argo, workload, service health, and Torghut business evidence.
5. Direct database access is intentionally unavailable to this worker role, so Jangar must rely on Torghut's
   application-level DB and schema witnesses.
6. `/readyz` degraded can be misread as a serving failure when it is actually correct capital-safety behavior.

The control plane needs a custody reducer that says exactly when the next Torghut repair action is allowed, held, or
denied.

## Alternatives Considered

### Option A: Keep Existing Ready Truth And Rely On Handoff Text

Jangar would continue to expose ready truth and Torghut consumer evidence separately. Operators and workers would read
handoffs to decide whether to launch the next repair.

Advantages:

- No new reducer.
- Existing status routes remain the only authority surface.
- Low implementation effort.

Disadvantages:

- Keeps manual synthesis in the hot path.
- Does not suppress duplicate no-delta launches.
- Does not map degraded stage health to Torghut repair admission.
- Makes deployer proof depend on narrative rather than a compact machine-readable decision.

Decision: reject.

### Option B: Hard Freeze All Material Work While Any Stage Is Degraded

Jangar would deny every material action whenever Jangar or Torghut stage health is degraded.

Advantages:

- Strong reliability stance.
- Simple to explain.
- Prevents launches while verify debt exists.

Disadvantages:

- Blocks the zero-notional repair work required to clear Torghut's own revenue blockers.
- Increases manual intervention because every stage-health issue becomes a global halt.
- Does not distinguish safe observe/repair work from capital or merge widening.
- Does not name the proof receipt needed to thaw.

Decision: reject as steady state. Keep it as an emergency brake.

### Option C: Revenue-Repair Settlement Conveyor Custody

Jangar consumes Torghut's compact conveyor ref and combines it with stage health, failure debt, and rollout proof to
decide material action admission.

Advantages:

- Targets the live business queue instead of generic repair volume.
- Allows bounded zero-notional repair while holding paper/live capital.
- Suppresses duplicate no-delta repair attempts.
- Makes deployer proof explicit and repeatable.
- Preserves least-privilege DB boundaries.

Disadvantages:

- Adds one reducer and compatibility tests.
- Initially holds some useful work until Torghut emits the compact conveyor ref.
- Requires stable schema naming across Torghut and Jangar.

Decision: select Option C.

## Architecture

Jangar emits `jangar.revenue-repair-settlement-custody.v1`.

```text
jangar.revenue-repair-settlement-custody.v1
  custody_id
  generated_at
  fresh_until
  torghut_consumer_evidence_ref
  torghut_conveyor_ref
  selected_hypothesis_id
  selected_value_gate
  action_class
  decision: allow | hold | deny
  reason_codes[]
  stage_health
  no_delta_release_key
  no_delta_release_state
  rollout_proof
  validation_command
  rollback_target
```

### Admission Rules

Jangar allows `torghut_observe` when Torghut consumer evidence is current, even if material work is held.

Jangar allows `dispatch_repair` only when:

- Torghut consumer evidence is current.
- The compact conveyor ref is present, current, and tied to the live top queue item.
- `selected_value_gate=routeable_candidate_count`.
- `max_notional=0`.
- The selected repair is zero-notional.
- No active no-delta lease exists for the same release key.
- Stage health does not show a current launch-capacity failure for the same stage.
- The handoff names the validation command and rollback target.

Jangar holds `dispatch_repair` when:

- the conveyor ref is missing but Torghut revenue repair is current;
- stage health is degraded but not frozen;
- rollout proof is incomplete for the current source-serving pair;
- the selected Torghut lane is stale or still settling.

Jangar denies `dispatch_repair` when:

- the compact ref is stale;
- `max_notional` is nonzero;
- the no-delta release key is unchanged and active;
- Torghut business state is not `repair_only` or the top queue item is not alpha readiness for this conveyor;
- the requested action is paper or live capital without a later capital-release design.

Jangar holds `merge_ready` and `deploy_widen` until the deployer can prove:

- PR checks are green;
- image promotion completed;
- Argo is `Synced/Healthy`;
- workload rollout is complete;
- `/db-check` is current;
- `/trading/consumer-evidence` carries the compact conveyor state;
- `/trading/revenue-repair` names the improved value gate or smallest blocker.

## Failure-Mode Reduction

This design removes specific current failure modes:

- Duplicate repair launch: unchanged no-delta release key becomes `deny`.
- Stage-health ambiguity: degraded implement/verify health becomes `hold` with stage reason, not silent retry.
- Revenue-priority drift: dispatch must cite Torghut's live top repair queue item.
- Capital safety drift: any nonzero notional is `deny`.
- Rollout proof split: deployer must cite one custody id and one Torghut conveyor id.
- DB access dependency: Jangar accepts Torghut application-level schema witnesses and does not need pod exec.

## Implementation Scope

The next Jangar engineer milestone is bounded:

1. Add a reducer under `services/jangar/src/server/` for
   `jangar.revenue-repair-settlement-custody.v1`.
2. Extend the Torghut consumer-evidence parser to read `torghut.alpha-readiness-settlement-conveyor-ref.v1`.
3. Feed the custody decision into ready truth as additive fields; do not remove existing ready-truth fields.
4. Add stage-health inputs from current swarm conditions and retained failure debt.
5. Add tests for current ref allow, missing ref hold, stale ref hold, no-delta unchanged deny, nonzero notional deny,
   degraded stage hold, and rollout proof gate.
6. Keep `serve_readonly` and `torghut_observe` allowed when consumer evidence is current and capital remains zero.

The implementation must not create AgentRuns, mutate swarms, edit Kubernetes resources, or relax paper/live capital
gates.

## Validation Gates

Local validation for the implementation PR:

```bash
bun run --cwd services/jangar test -- src/server/control-plane-torghut-consumer-evidence.test.ts
bun run --cwd services/jangar test -- src/server/control-plane-ready-truth-arbiter.test.ts
bunx oxfmt --check services/jangar/src/server
```

Post-merge verifier gates:

- PR merged only after required CI is green.
- Image promotion PR is merged and points to the source commit.
- Argo `jangar`, `agents`, `torghut`, `torghut-options`, and `symphony-torghut` are `Synced/Healthy`, or any
  non-healthy application is named as the smallest deploy blocker.
- Jangar status exposes current `jangar.revenue-repair-settlement-custody.v1`.
- Torghut `/trading/consumer-evidence` exposes current compact conveyor ref.
- Torghut `/trading/revenue-repair` still reports `max_notional=0` unless a later capital-release design changes it.

## Rollout

1. Ship Jangar custody parsing and ready-truth fields as additive output.
2. Keep enforcement in shadow for one rollout if Torghut compact conveyor ref has not shipped yet.
3. Promote Jangar through the normal image and GitOps path.
4. Verify Jangar readiness, agents readiness, Argo sync, and Torghut consumer evidence after rollout.
5. Turn the custody decision into launch admission only after Torghut emits current compact conveyor refs.

## Rollback

Rollback is a Jangar source or image revert. If rollback is needed:

- stop emitting `jangar.revenue-repair-settlement-custody.v1`;
- ignore the compact Torghut conveyor ref;
- fall back to existing ready truth, repair-bid admission, stage credit, and consumer evidence leases;
- keep Torghut capital at zero notional;
- do not enable paper or live submission.

Rollback is required if observe-only traffic is blocked, stale compact refs are treated as allow, nonzero notional is
allowed, or ready truth loses existing action-class fields.

## Risks

- Torghut and Jangar schema names can drift. Mitigation: parser tests assert exact schema versions and reason codes.
- Stage-health hold can become too conservative. Mitigation: hold material actions, not `serve_readonly` or
  `torghut_observe`.
- Conveyor ref may not exist immediately. Mitigation: shadow-mode output first, then enforce once Torghut producer
  exists.
- Deployer proof remains multi-surface. Mitigation: custody id becomes the compact audit handle, while detailed proof
  remains in PR, Argo, and service routes.
- OOMKilled runner debt can recur. Mitigation: no-delta and stage-health rules reduce duplicate launch pressure.

## Engineer Handoff

Implement this only after or alongside Torghut's compact conveyor ref. The first useful Jangar PR is additive: parse
the compact ref, emit a custody decision, and keep it in shadow unless the Torghut producer is live. Acceptance is a
testable status object that denies unchanged no-delta repair and nonzero notional while preserving observe access.

2026-05-14 alpha-evidence compatibility follow-up:

- Revenue-repair custody now accepts the later alpha closure-board and executable-alpha receipt surfaces as settlement
  evidence when the older compact conveyor ref is absent.
- Queue-head evidence from Torghut consumer evidence is enough to infer `business_state=repair_only` for custody; the
  reducer should not emit `business_state_missing` or `revenue_repair_top_item_missing` when a current
  `repair_alpha_readiness` queue item is already present.
- Active closure-board no-delta evidence remains a denial, not an allow. The denial must cite the closure board,
  active release key, no-delta budget state, validation command, and rollback target.
- This keeps `ready_status_truth` aligned with `/ready.material_evidence_settlement_spine.business_truth` while still
  reducing duplicate repair launches that would worsen `failed_agentrun_rate`.

## Deployer Handoff

Do not call the Jangar side ready just because `/ready` is HTTP 200. The deployer must prove Argo, workloads, service
health, and Torghut business evidence. If the compact conveyor ref is missing, report that as the smallest blocker and
keep material repair dispatch held. If the ref is present and current, cite the custody id, selected hypothesis,
selected value gate, validation command, and rollback target in the rollout handoff.
