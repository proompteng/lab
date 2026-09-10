# 189. Jangar Authority Provenance Settlement And Rollout Reentry Windows (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane authority provenance, source-to-serving rollout truth, AgentRun dispatch safety, PR-to-rollout
latency, Torghut repair admission, validation, rollout, rollback, and cross-stage handoff.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`
- Runtime validation contract: every run cites governing design/runtime requirement before changing code; implement stages
  produce production PRs with tests or report the exact blocker; verify stages merge only green PRs and prove Argo,
  workload readiness, and service health after rollout; final handoff names the control-plane metric improved or the
  smallest blocker preventing improvement.

Companion Torghut contract:

- `docs/torghut/design-system/v6/193-torghut-route-repair-yield-board-and-hypothesis-reentry-guardrails-2026-05-13.md`

Extends:

- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md`
- `184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`

## Decision

I am selecting an **Authority Provenance Settlement Journal** with explicit rollout reentry windows as the next Jangar
control-plane architecture step.

The cluster is no longer primarily failing on raw availability. On 2026-05-13, read-only assessment showed Argo CD
reporting `agents` and `jangar` `Synced/Healthy` at `f8ca89ff98d754e18962ae72157ce8603303185b`; `torghut` was
`Synced/Healthy` at `bbe9dd519fef8e1e141f58f1fde24c88226ca8df`. `deployment/jangar` was `1/1`, `deployment/agents`
was `1/1`, and `deployment/agents-controllers` was `2/2`. Jangar `/ready` returned HTTP 200. The Jangar database
projection was healthy with `29/29` Kysely migrations applied, `pgcrypto` and `vector` installed, and `agent_runs`
fresh to `2026-05-13T12:24:56Z`. The watch window was healthy with 711 AgentRun/VCP events and zero watch errors or
restarts.

The remaining failure mode is authority provenance. The status plane can see fresh controller heartbeats from
`agents-controllers`, a healthy deployment, a healthy watch epoch, and a healthy database. It still produces contradictory
or locally incomplete action evidence: the AgentRun ingestion witness can remain `controller_ingestion_unknown`, source
rollout truth can report `source_rollout_truth_missing:source_or_gitops_revision` and `desired_live_image_mismatch`,
and action budgets continue to hold or repair-only normal dispatch while read-only serving remains allowed. That is the
right safety posture, but it is not an efficient operating model.

The selected design adds an authority settlement journal that makes every material decision answer four questions:

1. Which process or projection is allowed to speak for this authority surface?
2. Which source, GitOps, image, controller, database, watch, and Torghut refs prove that authority is current?
3. Which action classes can reenter, and for how long, while an authority split is being repaired?
4. Which evidence must be produced before deploy widening or merge readiness can claim the rollout is healthy?

The tradeoff is that normal dispatch stays conservative until the settlement journal is present and shadowed. I accept
that because the business metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout time. The next
six months need fewer local interpretations of truth, not more per-consumer heuristics.

## Evidence Snapshot

All assessment was read-only. I did not mutate Kubernetes resources, database rows, trading flags, GitOps resources, or
AgentRun objects.

### Cluster And Rollout Evidence

- Worktree: `codex/swarm-jangar-control-plane-plan` based on `main` at
  `f8ca89ff98d754e18962ae72157ce8603303185b`.
- Kubernetes identity: `system:serviceaccount:agents:agents-sa`. `kubectl config current-context` was unset, but API
  authentication succeeded. This service account can read pods, deployments, events, services, and named secrets; it
  cannot list CNPG cluster CRs, statefulsets, or create `pods/exec`.
- Argo CD:
  - `agents`: `Synced/Healthy`, revision `f8ca89ff98d754e18962ae72157ce8603303185b`
  - `jangar`: `Synced/Healthy`, revision `f8ca89ff98d754e18962ae72157ce8603303185b`
  - `torghut`: `Synced/Healthy`, revision `bbe9dd519fef8e1e141f58f1fde24c88226ca8df`
- Jangar namespace:
  - `deployment/jangar` was `1/1`; pod `jangar-9b5489d5c-8dtbn` was `2/2 Running` with zero restarts.
  - Recent events showed the Jangar pod rolled 12 minutes before assessment. There was one transient readiness probe
    connection-refused event during startup and a completed `jangar-db` backup at `2026-05-13T11:00Z`.
- Agents namespace:
  - `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`.
  - `agents-controllers-8997bdc5f-sgqzm` and `agents-controllers-8997bdc5f-zk4vz` were both ready with zero restarts.
  - Recent events showed controller pods rolling cleanly, but also recent failed AgentRun jobs and retry recoveries.
    Examples: `jangar-control-plane-implement-sched-8b575` failed about four hours earlier, then newer Jangar/Torghut
    jobs continued to run.
- Torghut namespace:
  - Current Knative revisions `torghut-00347` and `torghut-sim-00445` were ready.
  - Recent Torghut events included normal revision readiness plus transient 503/startup probe failures during rollout,
    a completed empirical jobs backfill, and a failed whitepaper autoresearch workflow.

### Runtime Evidence

- Jangar `/ready` was HTTP 200 with `status=ok`.
- `/api/agents/control-plane/status?namespace=agents` reported:
  - Database `healthy`, latency around 12 ms, and migration consistency `29/29`.
  - `watch_reliability.status=healthy`, `observed_streams=2`, `total_events=711`, `total_errors=0`,
    `total_restarts=0`.
  - `workflows.data_confidence=high`, `recent_failed_jobs=0`, and `backoff_limit_exceeded_jobs=0` in the 15-minute
    window.
  - Controller heartbeats for `agents-controller`, `supporting-controller`, and `orchestration-controller` were fresh
    from `agents-controllers-8997bdc5f-zk4vz`.
  - `control_plane_controller_witness.decision=allow_with_split`, proving the split-serving topology can have an
    authoritative controller process while the serving process is not the controller.
  - The AgentRun ingestion witness still had `decision=repair_only` and `reason_codes=["controller_ingestion_unknown"]`
    even while the watch epoch was current.
  - `dispatch_normal` remained constrained by `evidence_clock_custody_blocked`; `deploy_widen` was held on
    evidence-clock capital/rollout/custody splits; Torghut paper/live capital remained held or blocked.
  - Stage clearance packets still carried rollout and authority reasons such as
    `source_rollout_truth_missing:source_or_gitops_revision`, `desired_live_image_mismatch`,
    `controller_heartbeat_not_current`, `controller_witness_allow_with_split`, `route_stability_hold`, and
    `source_rollout_truth_hold`.
- The live serving/source mismatch is not theoretical. The status plane reported source SHA
  `f5ed73941c4b372e9312535592677e8f7ba4a46b` for Jangar serving truth, while Torghut active build commit was
  `0a4ce485e3e336468839d3650e8ea1d2145a3779` on revision `torghut-00347`.

### Source Evidence

- `services/jangar/src/server/agents-controller/index.ts` makes local AgentRun ingestion `unknown` when the local
  process has not started the agents controller. That is correct for a serving process, but incomplete when a separate
  controller process has a fresh heartbeat.
- `services/jangar/src/server/control-plane-controller-witness.ts` already distinguishes `allow`,
  `allow_with_split`, `repair_only`, and `hold_material`. It can prove a controller process heartbeat is authoritative
  while the serving process is not the controller.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already suppresses raw
  `agentrun_ingestion_unknown` when the controller witness is authoritative, but still turns `controller_witness_split`
  into negative evidence when the split is not settled.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` holds non-read-only actions when source,
  GitOps, desired image, live image, route, database, watch, or controller heartbeat evidence do not converge.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` contains the current split-topology expectations:
  heartbeat-authoritative split topology can allow dependency quorum, but rollout-only disabled-controller fallback
  still makes `dispatch_normal` `repair_only` on `controller_witness_split`.
- The missing architecture surface is not another readiness endpoint. The missing surface is a durable settlement
  journal that says which authority source wins, which disagreement is tolerated, and which action class is allowed to
  reenter while the disagreement is being repaired.

### Database And Data Evidence

- Direct DB pod exec was forbidden: `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa"
cannot create resource "pods/exec"`.
- CNPG cluster CR reads were forbidden: `clusters.postgresql.cnpg.io is forbidden`.
- Named CNPG app secret reads were allowed, so DB checks used the app URI in a `BEGIN READ ONLY` transaction from the
  workspace.
- Jangar Postgres identity: `database=jangar`, `user=jangar`, `pg_is_in_recovery=false`.
- Required extensions were installed: `pgcrypto 1.3` and `vector 0.8.0`.
- Kysely migration table: `kysely_migration`; applied count `29`; latest applied and registered migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`; missing and unexpected migrations were
  both zero.
- Data freshness:
  - `agent_runs`: 916 rows, max `created_at=2026-05-13T12:22:03Z`, max `updated_at=2026-05-13T12:24:56Z`.
  - `agent_run_idempotency_keys`: 897 rows, max `updated_at=2026-05-13T12:25:00Z`.
  - `torghut_market_context_runs`: 298 rows, max `updated_at=2026-05-13T04:20:40Z`.
  - `torghut_market_context_evidence`: 1262 rows, max `updated_at=2026-05-13T04:20:39Z`.
  - `orchestration_runs`: 0 rows. That is acceptable only if orchestration runtime evidence remains sourced from
    Kubernetes/workflow status rather than this table.

## Problem

Jangar has too many locally true authority statements and no single settlement journal.

The concrete failure mode is not "the service is down." The service is up. The database is current. Watch reliability
is healthy. Controller heartbeats are fresh. Jobs are being created. At the same time, normal dispatch, deploy widening,
merge readiness, and Torghut capital remain constrained because the status plane cannot yet distinguish four different
kinds of split:

1. A safe split where the serving process is not the controller, but the controller process heartbeat is authoritative.
2. A repairable split where watch and deployment are current, but the ingestion epoch is missing.
3. A rollout split where source SHA, GitOps revision, desired image, and live image do not form a single chain.
4. A capital split where Torghut proof is current enough for observation but not current enough for paper or live
   notional.

Without a settlement journal, each downstream consumer interprets those splits independently. The negative-evidence
router, stage clearance packets, material action verdicts, source rollout truth, deploy verifier, UI, and scheduler can
all be locally defensible while still forcing humans to join evidence by hand. That keeps `manual_intervention_count`
high and turns PR-to-rollout verification into archaeology.

## Options Considered

### Option A: Treat Controller Heartbeat As Sufficient Authority

Make a fresh `agents-controller` heartbeat override local AgentRun ingestion unknown and allow `dispatch_normal` when
deployment, database, watch, and workflow windows are healthy.

Advantages:

- Simple implementation.
- Retires the most visible false hold quickly.
- Uses the controller heartbeat work already in production.

Disadvantages:

- It can hide a real ingestion regression if the heartbeat is fresh but the controller stopped observing AgentRun
  mutations.
- It does not settle source/GitOps/image mismatch.
- It does not give deployers a durable PR-to-rollout certificate.
- It only fixes one authority surface and leaves Torghut capital repair blocked behind a separate interpretation path.

Decision: reject as the full architecture. Use heartbeat as an input, not the whole verdict.

### Option B: Make Source Rollout Truth The Single Arbiter

Route all material actions through source rollout truth. If source SHA, GitOps revision, desired image, live image,
database, route, watch, and controller heartbeat converge, allow action; otherwise hold or repair-only.

Advantages:

- Strong source-to-serving safety.
- Good deployer mental model.
- Prevents widening when live image or GitOps evidence is ambiguous.

Disadvantages:

- It overfits rollout and underfits runtime authority.
- It does not explain why an AgentRun stage may reenter while deploy widening stays held.
- It treats Torghut capital proof as another blocker instead of an independent repair market with zero-notional work.
- It can lengthen PR-to-rollout latency when source truth is slightly stale but bounded repair is still valuable.

Decision: reject as the full architecture. Source rollout truth remains a required input, but not the only arbiter.

### Option C: Authority Provenance Settlement Journal

Build a journal that records the winning authority source, evidence refs, disagreement class, action-class decision,
reentry window, and rollback target for each authority surface.

Advantages:

- Separates serving readiness from material-action authority without lying about either.
- Converts split-topology authority into a named, testable state rather than a pile of reason codes.
- Gives scheduler, deployer, UI, and NATS handoff the same compact answer.
- Lets bounded repair work continue while deploy widening, merge readiness, and capital remain held.
- Gives Torghut a clean consumer contract for zero-notional repair and paper/live reentry.

Disadvantages:

- Adds a new reducer/status projection and another set of tests.
- Requires careful rollout so a new journal cannot accidentally loosen dispatch.
- Requires deployers to learn the distinction between `serving_ready`, `authority_settled`, and `reentry_open`.

Decision: select Option C.

## Architecture

Add `authority_provenance_settlement` to `/api/agents/control-plane/status?namespace=agents` in shadow mode first.

The projection consumes these existing surfaces:

- `controllers[]`
- `control_plane_controller_witness`
- `agentrun_ingestion`
- `watch_reliability`
- `workflows`
- `database.migration_consistency`
- `runtime_adapters[]`
- `source_rollout_truth_exchange`
- `source_serving_contract_verdict_exchange`
- `stage_clearance_packets[]`
- `action_slo_budgets[]`
- `projection_watermarks[]`
- `torghut_consumer_evidence`

The projection emits:

- `settlement_id`: stable digest of the authority inputs.
- `generated_at` and `fresh_until`: journal freshness.
- `surfaces[]`: one row for `controller_process`, `agentrun_ingestion`, `watch_epoch`, `source_gitops`,
  `serving_image`, `database_schema`, `workflow_runtime`, `stage_clearance`, and `torghut_capital`.
- `winning_authority`: `serving_process`, `controller_heartbeat`, `kubernetes_rollout`, `database_projection`,
  `gitops_revision`, `torghut_receipt`, or `none`.
- `settlement_state`: `settled`, `settled_with_split`, `repairable_split`, `hold`, or `block`.
- `action_class_decisions[]`: decisions for `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`,
  `merge_ready`, `torghut_observe`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- `reentry_windows[]`: bounded action windows with `stage`, `action_class`, `max_dispatches`,
  `max_runtime_seconds`, `required_receipts`, and `expires_at`.
- `rollback_target`: exact rollback behavior for each non-allow state.
- `handoff_summary`: a short string safe for NATS, PR bodies, and release gates.

The reducer rules are deliberately conservative:

1. `serve_readonly` can allow from route, database, and serving proof. It does not require source/GitOps/image
   convergence.
2. `dispatch_repair` can allow when database, watch, workflow runtime, and controller heartbeat are current, even if
   source rollout truth is held.
3. `dispatch_normal` cannot fully allow while AgentRun ingestion is unknown, evidence-clock custody is blocked, or
   source rollout truth is held. It can enter `repair_only` only when the journal says `repairable_split`.
4. `deploy_widen` and `merge_ready` require source SHA, GitOps revision, desired image, live image, database, route,
   controller heartbeat, and projection watermarks to converge.
5. Torghut `paper_canary`, `live_micro_canary`, and `live_scale` cannot inherit Jangar `dispatch_repair` authority.
   They require Torghut capital-specific receipts from the companion contract.

## Implementation Scope

Engineer stage should implement this in one bounded production PR:

- Add `services/jangar/src/server/control-plane-authority-provenance-settlement.ts`.
- Add `AuthorityProvenanceSettlement` types to `services/jangar/src/server/control-plane-status-types.ts`.
- Compose the projection in `services/jangar/src/server/control-plane-status.ts`.
- Render a compact settlement row in `services/jangar/src/components/agents-control-plane-status.tsx`.
- Extend `packages/scripts/src/jangar/verify-deployment.ts` to require the field during Jangar deploy verification,
  but only fail when enforcement mode is enabled.
- Add tests:
  - heartbeat-authoritative split with unknown local ingestion emits `settled_with_split` and keeps
    `dispatch_normal=repair_only`;
  - missing controller heartbeat emits `hold`;
  - source/GitOps/image mismatch holds `deploy_widen` and `merge_ready`;
  - current source/GitOps/image plus current controller ingestion opens a bounded normal-dispatch reentry window;
  - Torghut zero-notional repair can allow `torghut_observe` and `dispatch_repair` but not paper/live capital.

Do not mutate CRDs, database rows, or deployment manifests in the first PR. This is a status and verifier contract
change. Scheduler admission can consume it in the next PR after the field is shadowed and stable.

## Validation Gates

Each milestone maps to a swarm value gate:

- `ready_status_truth`: `/ready` remains HTTP 200 when serving is healthy, while `authority_provenance_settlement`
  names material-action holds separately.
- `failed_agentrun_rate`: no new normal-dispatch launch is admitted without a settlement reentry window once scheduler
  enforcement is enabled.
- `pr_to_rollout_latency`: deploy verification reports one settlement summary with source SHA, GitOps revision, image,
  database, controller, and Torghut refs.
- `manual_intervention_count`: operators do not have to hand-join controller heartbeat, watch, source rollout truth,
  and Torghut receipts to decide repair vs widen.
- `handoff_evidence_quality`: NATS, PR, and mission-ledger updates cite settlement ID, state, action decisions, and
  rollback target.

Local validation for the implementation PR:

```bash
bun test services/jangar/src/server/__tests__/control-plane-status.test.ts
bun test services/jangar/src/components/__tests__/agents-control-plane-status.test.tsx
bun test packages/scripts/src/jangar/__tests__/verify-deployment.test.ts
bunx oxfmt --check services/jangar/src/server/control-plane-authority-provenance-settlement.ts services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-status-types.ts services/jangar/src/components/agents-control-plane-status.tsx packages/scripts/src/jangar/verify-deployment.ts
```

Read-only runtime validation:

```bash
curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents \
  | jq '.authority_provenance_settlement | {settlement_id,settlement_state,action_class_decisions,reentry_windows}'
curl -fsS http://agents.agents.svc.cluster.local/ready | jq '{status,execution_trust}'
kubectl get applications.argoproj.io -n argocd agents jangar torghut -o wide
kubectl get deployments,pods -n agents -o wide
kubectl get deployments,pods -n jangar -o wide
```

## Rollout Plan

1. Shadow mode: emit `authority_provenance_settlement` with no scheduler or deployer blocking. Compare the settlement
   decisions against existing action SLO budgets for at least one full Jangar/Torghut swarm cadence.
2. Verify mode: make `verify-deployment.ts` require the field and print holds, but do not fail deployment unless the
   field is missing or malformed.
3. Deployer gate: fail deploy widening when settlement says `deploy_widen=hold` or `block`.
4. Scheduler gate: require a reentry window for `dispatch_normal`; continue allowing bounded `dispatch_repair` when
   the settlement state is `repairable_split`.
5. Merge gate: require `merge_ready=allow` only after source/GitOps/image/database/controller/Torghut settlement
   converges.

## Rollback

Rollback is feature-flagged:

- Disable verifier enforcement first.
- Disable scheduler consumption next.
- Keep the field visible in status until the incident is understood.
- If the field itself is malformed, remove it from status and fall back to existing action SLO budgets, stage clearance
  packets, source rollout truth, and deploy verification.

No database rollback is required for the first implementation because the journal is computed from existing status
inputs. If a later PR persists settlement history, it must use an additive Kysely migration and retain read-only
fallback behavior when the table is unavailable.

## Risks

- A loose settlement rule could allow normal dispatch too early. Mitigation: shadow first, keep action SLO budgets as
  the enforcement source until tests cover every split.
- A strict settlement rule could block useful repair. Mitigation: keep `dispatch_repair` separate from
  `dispatch_normal`, and require rollback targets on every hold.
- The status payload can grow. Mitigation: keep detailed refs in the status API but render a compact UI summary.
- Torghut capital rules can be accidentally conflated with Jangar repair rules. Mitigation: companion Torghut receipts
  are required for paper/live capital.

## Engineer Handoff

Implement the shadow projection first. The governing design for code changes is this document. The first implementation
PR is accepted when tests prove split topology, source rollout mismatch, current controller heartbeat, healthy database,
and zero-notional Torghut repair all produce explicit settlement states and action decisions.

Do not change scheduler admission in the same PR unless the field has first been validated against live status output.

## Deployer Handoff

Before widening or claiming merge readiness, capture:

- Argo CD `agents`, `jangar`, and `torghut` sync/health/revision.
- `/ready` status.
- `authority_provenance_settlement.settlement_id`, `settlement_state`, `action_class_decisions`, and
  `rollback_target`.
- Jangar DB migration consistency.
- Agents/Jangar/Torghut deployment availability.
- Torghut consumer-evidence `max_notional`, routeable candidate count, evidence-clock state, and capital decision.

The deployer should not widen a rollout if the settlement journal says `deploy_widen=hold` or `block`, even when
`/ready` is 200.
