# 175. Jangar Failure-Debt Clearance And Action Reentry Frontier (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, retained failure debt, source and GitOps settlement, observer-rights gaps,
database evidence provenance, rollout safety, Torghut capital handoff, validation, rollout, rollback, and acceptance
gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`

Extends:

- `174-jangar-observer-rights-and-source-settled-capital-ledger-2026-05-08.md`
- `173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
- `172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md`
- `docs/torghut/design-system/v6/178-torghut-route-sample-mint-and-capital-proof-ratchet-2026-05-08.md`

## Decision

I am selecting a **failure-debt clearance contract with an action reentry frontier** as the next Jangar control-plane
architecture step.

The current system is serving, but serving is not the same as being action-authoritative. On 2026-05-08 at 02:21Z to
02:25Z, the in-cluster assessment account was `system:serviceaccount:agents:agents-sa`. Argo CD reported `agents`,
`jangar`, and `torghut` `Synced` and `Healthy`. Jangar had 8 running pods and all listed deployments available.
Torghut live revision `torghut-00292` and sim revision `torghut-sim-00391` were running. Jangar `/ready` returned
`status=ok`, execution trust was healthy, runtime kits were present, and serving plus `swarm_plan`, `swarm_implement`,
and `swarm_verify` admission passports were `allow`.

The evidence also shows why material action should stay gated. The Agents namespace retained 244 completed pods, 53
failed pods, and 6 running pods. Current rollout events still showed readiness probe timeouts against `agents`,
`agents-controllers`, and the Jangar app during rollout warmup. The source rollout truth exchange was in shadow mode
with healthy desired/live image convergence, but both `source_head_sha` and `gitops_revision` were null. The controller
heartbeat was a split projection: controller deployment and watch evidence existed, but controller ingestion authority
was not fully settled. Direct CNPG metadata and `pods/exec` reads were not allowed for the assessment identity, so
database proof depended on application projections. Torghut was reachable, but live `/readyz` returned HTTP 503
`degraded` because the proof floor was `repair_only`, capital was `zero_notional`, and live submission remained
disabled.

The decision is to stop treating these facts as independent warnings. Jangar should compile them into a small
failure-debt clearance book per control-plane epoch. Each debt item must identify the evidence class, current
relevance, owning action class, clearance cost, expiry, and rollback owner. The action reentry frontier then decides
which actions may proceed: read-only serving and Torghut observation can continue under bounded debt, repair dispatch
can proceed only when it pays down named debt, and normal dispatch, deploy widening, merge readiness, paper canary,
live micro, and live scale remain held until their debt budget is cleared.

The tradeoff is that the platform will expose more red or amber state while it is otherwise serving. I accept that.
The six-month risk is not an unavailable service. It is a healthy-looking control plane that carries old failed jobs,
missing source settlement, and projection-only database evidence into deploy or capital decisions without pricing that
debt.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Workspace branch: `codex/swarm-jangar-control-plane-plan`, based on `main`, with no local file changes before this
  document set.
- `kubectl auth whoami` resolved to `system:serviceaccount:agents:agents-sa` after bootstrapping the in-cluster
  context from the mounted service-account token.
- Argo CD reported `agents`, `jangar`, and `torghut` `Synced` and `Healthy`. Peripheral applications still had
  unrelated debt: `rook-ceph` was `Degraded`, and `forgejo-runners`, `keycloak`, and `temporal` were `Progressing`.
- Jangar pods were all running: `bumba`, `jangar`, `jangar-alloy`, `jangar-db`, `jangar-openwebui-redis`,
  `open-webui`, `symphony`, and `symphony-jangar`.
- Jangar deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available. Listing
  StatefulSets in `jangar` was denied to the assessment account.
- Agents deployments were available: `agents=1/1`, `agents-alloy=1/1`, and `agents-controllers=2/2`.
- Agents pod status counts were 244 `Completed`, 53 `Error`, and 6 `Running`.
- Agents events still showed readiness probe timeouts for `agents`, both current `agents-controllers` pods, and older
  controller pods during rollout. Current cron schedules were creating and completing jobs, so this is not a hard
  outage; it is retained failure debt plus rollout warmup fragility.
- Torghut live and sim pods were running, including `torghut-00292` and `torghut-sim-00391`. Torghut events showed
  startup/readiness probe failures followed by `RevisionReady`, repeated ClickHouse multiple-PDB warnings, and a
  completed daily CNPG backup.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` has 787 lines and is already the aggregation surface for
  dependency quorum, execution trust, runtime kits, admission passports, source rollout truth, and action evidence.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` has 632 lines and already emits
  receipts for `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `torghut_observe`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` has 528 lines and already translates source
  truth and material action policy into verdicts.
- `services/jangar/src/server/supporting-primitives-controller.ts` has 3314 lines. It now uses
  `JANGAR_SCHEDULE_NAMESPACE` and includes Workspace/PVC reconciliation, so older schedule namespace and PVC gaps have
  repair evidence in source. The risk is proving current schedules are using the repaired runtime.
- `services/jangar/src/server/primitives-kube.ts` now includes `PersistentVolumeClaim` aliases and tests cover PVC
  reads/lists/deletes. That closes a prior source gap, but it also proves the clearance contract needs source-settled
  runtime evidence before widening.
- `services/torghut/app/main.py` has 4222 lines and joins proof floor, route reacquisition, empirical jobs, quant
  evidence, market context, and database status. Jangar should not push more capital policy into route-local joins.

### Database And Data Evidence

- Direct observer rights were incomplete: `kubectl auth can-i list clusters.postgresql.cnpg.io -n jangar` returned
  `no`, the same check in `torghut` returned `no`, and `create pods/exec` was denied in both namespaces.
- Jangar control-plane status projected database health as healthy through the application status surface and cited
  latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and one known graph branch with
  historical parent-fork warnings.
- Torghut live `/readyz` returned HTTP 503 and `status=degraded`: Postgres, ClickHouse, Alpaca, universe, database,
  empirical jobs, and quant evidence were readable, but `live_submission_gate` failed with `simple_submit_disabled`
  and profitability proof floor was `repair_only`.
- Torghut proof floor blockers were `hypothesis_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.

## Problem

Jangar has several good status projections, but the platform still lacks an action-grade answer to one question:
which specific debt must clear before this action is allowed?

The current failure modes are:

1. Retained failed pods and jobs can coexist with current successful cron runs without relevance classification.
2. Source and GitOps revision truth can be missing while desired/live image digests have converged.
3. Controller deployment and watch evidence can be fresh while controller ingestion authority is split.
4. Direct database observer rights can be unavailable while application projections remain healthy.
5. Torghut can be operationally reachable while its capital proof floor is repair-only.
6. A deployer can see several status sections but still lack a single clearance reason, owner, and next gate.

The control plane needs a clearance contract that lets safe observation continue while preventing normal dispatch,
rollout widening, merge readiness, and capital promotion from spending unsettled evidence.

## Alternatives Considered

### Option A: Global Freeze On Any Failed Pod Or Degraded Consumer

Block every launch-capable schedule, deploy widening, merge readiness, and Torghut repair action whenever the namespace
contains any failed pod or any dependent route is degraded.

Advantages:

- Simple to explain during an incident.
- Strongly reduces accidental promotion from degraded evidence.
- Easy to enforce from existing Kubernetes status.

Disadvantages:

- Retained historical failed pods can freeze unrelated healthy work indefinitely.
- It blocks zero-notional repair that would reduce the debt.
- It treats a projection-only database witness and a current failed schedule as the same class of risk.

Decision: reject as the primary model. Keep freeze as an emergency mode, not the normal architecture.

### Option B: Continue With Independent Ledgers And Operator Interpretation

Expose source rollout truth, observer rights, runtime admission, material verdicts, and Torghut proof floor as separate
status sections and rely on deployers to interpret them.

Advantages:

- Lowest implementation cost.
- Keeps existing reducer boundaries intact.
- Gives engineers detailed diagnostics.

Disadvantages:

- Consumers reconstruct action authority differently.
- Retained failures remain noisy instead of being priced and assigned.
- Missing source/GitOps truth can be diagnosed but not cleared through an action-specific gate.

Decision: keep the existing projections as inputs, but add a clearance authority above them.

### Option C: Failure-Debt Clearance And Action Reentry Frontier

Compile every relevant failure, observer gap, source gap, controller split, and downstream capital blocker into a
clearance book. Then compute one action reentry frontier that names allowed, repair-only, held, and blocked actions.

Advantages:

- Preserves read-only service under bounded debt.
- Lets repair dispatch proceed only when it retires named debt.
- Converts retained failures into scoped debt instead of global noise.
- Gives deployers and Torghut one clearance receipt per material action.
- Makes least-privilege RBAC gaps visible without granting broad observer rights by default.

Disadvantages:

- Adds a new reducer and schema.
- Requires careful relevance classification so stale debt does not block unrelated actions.
- Needs source/GitOps refs and controller ingestion self-report to graduate beyond shadow mode.

Decision: select Option C.

## Architecture

Jangar adds a status-first `failure_debt_clearance_book` and `action_reentry_frontier`.

```text
failure_debt_item
  debt_id
  debt_class                 # retained_failure | source_settlement | controller_split | observer_right | db_projection | proof_floor | rollout_probe
  evidence_ref
  subject_ref
  first_seen_at
  last_seen_at
  fresh_until
  current_relevance          # stale | background | repair_relevant | action_blocking | capital_blocking
  owning_action_classes
  clearance_owner            # engineer | deployer | controller | torghut | operator
  clearance_cost             # low | medium | high
  clearance_gate
  rollback_target
```

The frontier consumes those debt items and existing Jangar projections:

```text
action_reentry_cell
  action_class               # serve_readonly | torghut_observe | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | paper_canary | live_micro | live_scale
  decision                   # allow | allow_repair | hold | block
  debt_budget
  active_debt_ids
  stale_debt_ids
  source_settlement_ref
  controller_witness_ref
  database_evidence_ref
  torghut_proof_floor_ref
  required_clearance_gate
  fresh_until
  rollback_target
```

Decision rules:

- `serve_readonly` can allow when serving health, runtime admission, database projection, and execution trust are
  healthy, even if non-serving material debt exists.
- `torghut_observe` can allow when Torghut routes and data projections are readable and no capital action is implied.
- `dispatch_repair` can allow only for runs that carry a debt-retirement target and do not create paper or live
  capital exposure.
- `dispatch_normal` requires source/GitOps refs, current controller ingestion authority, clean current schedule debt,
  and fresh database projection.
- `deploy_widen` and `merge_ready` require source/GitOps settlement, desired/live image convergence, current
  controller ingestion, no action-blocking retained failure debt, and explicit observer-right disposition.
- `paper_canary`, `live_micro`, and `live_scale` additionally require matching Torghut capital clearance from the
  companion frontier.

The clearance book should start in shadow mode. It does not delete failed pods, change schedules, mutate database
records, or change capital behavior in the first release. It makes the next action contract explicit.

## Implementation Scope

Engineer stage:

- Add a pure reducer, tentatively `control-plane-failure-debt-clearance.ts`, with typed debt items and action reentry
  cells.
- Feed it from Kubernetes pod/job/event summaries, source rollout truth, controller witness, observer-right receipts,
  database projection, runtime admission, and Torghut proof floor.
- Add a retained-failure classifier that can mark old schedule-runner failures as `stale` only after current cron
  completions and source/runtime digest settlement prove the repair is active.
- Add status projection fields `failure_debt_clearance_book` and `action_reentry_frontier` in shadow mode.
- Add unit tests for retained failed pods, old repaired schedule debt, current readiness timeout debt, missing
  source/GitOps refs, controller heartbeat split, projection-only database evidence, and Torghut proof-floor holds.

Deployer stage:

- Inject non-null source and GitOps revision refs into Jangar serving and Agents controller pods.
- Add least-privilege read-only observer rights only for debt classes that the clearance book marks
  `action_blocking`.
- Add release verification that fails `deploy_widen` and `merge_ready` when the frontier decision is `hold` or `block`.
- Keep Torghut paper and live capital at zero notional until the companion frontier emits a matching capital clearance.

## Validation Gates

Local validation:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/primitives-kube.test.ts`
- New reducer tests cover every `debt_class` and every `action_class`.

Live validation:

- `kubectl get applications.argoproj.io -n argocd agents jangar torghut` is `Synced` and `Healthy`.
- Jangar `/ready` remains `status=ok` for read-only service while non-serving debt is held.
- Control-plane status includes `failure_debt_clearance_book.mode=shadow` and `action_reentry_frontier.mode=shadow`.
- The frontier marks source/GitOps null refs as holding `dispatch_normal`, `deploy_widen`, and `merge_ready`.
- Retained failed pods are classified by current relevance instead of counted as one global blocker.
- Torghut capital cells remain held while the proof floor is `repair_only` or companion clearance is missing.

## Rollout

1. Ship the clearance book and frontier in shadow mode.
2. Compare frontier decisions with existing material action verdicts for one full Jangar and Torghut cron cycle.
3. Enable enforcement for `dispatch_repair` only when the run carries a debt-retirement target.
4. Enable enforcement for `dispatch_normal`, `deploy_widen`, and `merge_ready` after source/GitOps refs and controller
   ingestion self-report are current.
5. Enable Torghut paper and live capital gates only after the companion capital frontier agrees.

## Rollback

- Disable frontier enforcement with a single runtime flag while preserving the shadow projection.
- Fall back to current runtime admission and material action verdict behavior.
- Keep read-only serving and Torghut observation available when serving dependencies are healthy.
- Treat missing source/GitOps refs, observer rights, or controller ingestion as deployer/operator debt rather than
  deleting retained jobs or widening RBAC in place.
- Keep Torghut capital zero-notional whenever companion clearance is absent or proof floor remains repair-only.

## Risks And Open Questions

- Relevance classification can be wrong. Mitigation: shadow mode and tests that prove old failures do not block
  unrelated actions, while current schedule or rollout debt still blocks.
- Debt scoring can become another opaque policy layer. Mitigation: every debt item has an evidence ref, owner,
  clearance gate, and rollback target.
- Least-privilege observer-right repair may take longer than broad RBAC. That is intentional; broad `pods/exec` should
  not become the routine capital admission path.
- Source/GitOps refs are still null in the current status. Deployer wiring must close this before material enforcement.

## Handoff Contract

Engineer acceptance gates:

- The clearance reducer and frontier projection are implemented in shadow mode with typed schemas.
- Tests cover every debt class and prove read-only service remains available under bounded material debt.
- Retained failure debt is classified by current relevance, not raw failed pod count.
- Material action cells cite source settlement, controller witness, database evidence provenance, and Torghut proof
  floor refs.

Deployer acceptance gates:

- Runtime pods expose non-null source and GitOps refs.
- Release checks fail widening when the frontier holds `dispatch_normal`, `deploy_widen`, or `merge_ready`.
- Observer RBAC changes are driven by named debt classes, not broad access requests.
- Torghut paper and live capital stay zero-notional until the companion frontier emits matching clearance.
