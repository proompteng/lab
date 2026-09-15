# 173. Jangar Action Broker And Proof-Carrying Rollout Cells (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar action authority, source/GitOps revision truth, controller ingestion witness, rollout safety,
database projection evidence, retained failure debt, Torghut capital handoff, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/177-torghut-profit-repair-broker-and-capital-promotion-gates-2026-05-08.md`

Extends:

- `172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md`
- `171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`
- `170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/176-torghut-revision-priced-route-frontier-and-capital-carry-2026-05-08.md`

## Decision

I am selecting a **proof-carrying action broker with rollout cells** as the next Jangar control-plane architecture
step.

The live system is serving, but it is not yet promotion-authoritative. On 2026-05-08 at 01:23Z, Argo CD reported the
`agents`, `jangar`, and `torghut` applications `Synced` and `Healthy` on revision `5fa0f9b8`. The Jangar namespace had
8 running pods, and the Agents deployments were available with `agents=1/1` and `agents-controllers=2/2`. Jangar
`/ready` returned `status=ok`, leader election was healthy, execution trust was healthy, the Jangar database was
connected, and the control-plane status endpoint reported 28 registered and 28 applied Kysely migrations. Watch
reliability was also healthy with 987 events, 0 errors, and 0 restarts in the sampled 15 minute window.

The same evidence explains why material action promotion is correctly held. `source_rollout_truth_exchange` had null
`source_head_sha` and null `gitops_revision`. The controller witness was `repair_only` because the deployment and watch
epoch were current but the controller ingestion self-report was missing. The broker already allowed `serve_readonly`
and `torghut_observe`, but held or blocked `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
`paper_canary`, `live_micro_canary`, and `live_scale`. That is the right failure-mode reduction, but today it is spread
across status reducers instead of being owned by a single action authority.

The decision is to make Jangar material action authority explicit. Every action class must be admitted by a
proof-carrying rollout cell that names the source revision, GitOps revision, desired image digest, live image digest,
controller ingestion witness, watch epoch, database migration witness, retained failure debt, and downstream Torghut
proof floor. Serving health can keep read-only and observation paths open. Dispatch, deploy widening, merge readiness,
and capital promotion need a brokered receipt that proves the action is spending evidence from the same settled
control-plane epoch.

The tradeoff is more visible holds after fast rollouts. I accept that. The larger six-month risk is a control plane
that recovers a pod, keeps a stale or anonymous source revision, and then lets repair or capital work proceed from an
evidence set that cannot be traced back to the code and controller process that produced it.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Workspace branch: `codex/swarm-jangar-control-plane-plan`, based on `main`.
- `kubectl auth whoami` resolved to `system:serviceaccount:agents:agents-sa` after bootstrapping the in-cluster
  context from the mounted service-account token.
- Argo CD applications `agents`, `jangar`, and `torghut` were `Synced` and `Healthy` at revision `5fa0f9b8`.
- Jangar deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available. The Jangar
  namespace had 8 running pods.
- Agents deployments `agents`, `agents-alloy`, and `agents-controllers` were available. The Agents namespace retained
  217 completed pods, 53 error pods, and 8 running pods.
- Jangar and Torghut scoped jobs showed 187 complete, 9 failed, and 4 running jobs. Current cron schedules were active
  and had recent completions, while older failed jobs remained as retained debt.
- Torghut live revision `torghut-00291` and sim revision `torghut-sim-00390` were available. Torghut events still
  showed ClickHouse PodDisruptionBudget warnings and a keeper PDB with no pods.

### Source Evidence

- `services/jangar/src/server/control-plane-controller-witness.ts` already separates deployment availability, watch
  epoch freshness, and controller ingestion self-report. Its current policy allows bounded repair when deployment and
  watch are fresh but ingestion self-report is missing.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already computes source refs, GitOps
  refs, desired images, live images, Torghut proof-floor refs, and action receipts. Its live status exposed the missing
  source/GitOps revision as the freshest material action blocker.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already translates source truth, controller
  witness, and Torghut proof into material action verdicts. The missing piece is a single broker receipt that every
  action class can cite.
- `services/jangar/src/server/primitives-kube.ts` now includes PersistentVolumeClaim aliases in the built-in resource
  target map. That repairs the older PVC-support gap called out by retained failure evidence, but the broker still has
  to prove that active schedules are using the repaired image before widening authority.
- `services/jangar/src/server/supporting-primitives-controller.ts` now emits schedule-runner namespace admission from
  `JANGAR_SCHEDULE_NAMESPACE` and validates target namespace separately. Older retained pods still show prior
  namespace-expression debt, so current cron completion should be treated as settlement evidence rather than assumed.

### Database And Data Evidence

- Direct CNPG reads were blocked for this service account:
  `cannot list resource "clusters" in API group "postgresql.cnpg.io"` and `cannot create resource "pods/exec"` in the
  Jangar and Torghut namespaces.
- Jangar application status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`,
  and migrations `registered_count=28`, `applied_count=28`, `unapplied_count=0`, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut live `/readyz` reported Postgres, ClickHouse, Alpaca, and database schema current with expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, but the readiness result was degraded because the profitability proof
  floor remained `repair_only` and capital was `zero_notional`.
- Torghut live route evidence had 8 scoped symbols, 0 routeable, 1 probing, 4 blocked, and 3 missing. Average absolute
  live TCA slippage was about 13.82 bps, above the configured live guardrail.
- Torghut sim readiness was ok, but sim route evidence remained repair-only with 0 routeable symbols, 7 missing
  symbols, and about 110.16 bps average absolute TCA slippage.

## Problem

Jangar already contains strong local reducers, but the action boundary is still a composition of many facts. That
composition is understandable to an engineer reading the status payload. It is not yet an authoritative contract for
controllers, deployers, or downstream capital consumers.

The current failure modes are concrete:

1. Source and GitOps revision can be absent while the latest deployment is healthy.
2. Controller deployment and watch epochs can be fresh while controller ingestion self-report is missing.
3. Retained failed pods and old failed jobs can hide in namespace history while the latest cron schedule is green.
4. Database evidence can be healthy through application projections while direct read-only SQL access is unavailable
   to the assessment service account.
5. Torghut can be reachable and data-current while its proof floor blocks capital.

The control plane needs an action broker that says exactly which action class is allowed, why it is allowed, which
proofs it is spending, and which rollback target owns the next failure.

## Alternatives Considered

### Option A: Keep Independent Shadow Reducers

Continue using source rollout truth, controller witness, watch reliability, material verdicts, and Torghut budgets as
separate status sections.

Advantages:

- Lowest implementation cost.
- Preserves the current reducer ownership boundaries.
- Read-only and observe paths already behave correctly.

Disadvantages:

- Consumers must reconstruct action authority from multiple sections.
- Missing source/GitOps truth and missing ingestion witness can be diagnosed, but not cited as a single action receipt.
- Deployer and engineer handoffs remain vulnerable to interpretation drift.

Decision: keep the reducers, but no longer make them the consumer-facing authority.

### Option B: Enforce A Global Rollout Cooldown

Hold all material actions for a fixed time after any Jangar, Agents, or Torghut rollout.

Advantages:

- Simple operational rule.
- Reduces immediate post-rollout churn.
- Easy to explain during incidents.

Disadvantages:

- Lets action proceed after the timer even if source refs or ingestion witness are still missing.
- Blocks useful zero-notional repair when all relevant evidence is already settled.
- Uses elapsed time as a proxy for proof quality.

Decision: use cooldown only as a fallback when the broker cannot compute a receipt.

### Option C: Proof-Carrying Action Broker

Introduce a broker projection that joins the existing reducers into action-class receipts. The broker produces one
receipt per action class and exposes the carried proofs, hold reasons, rollback target, and freshness budget.

Advantages:

- Gives controllers and deployers one authoritative action contract.
- Preserves read-only and observe behavior while preventing unsafe promotion.
- Converts retained failure debt and missing source/ingestion evidence into explicit rollback-owned holds.
- Gives Torghut a stable upstream receipt for paper and live capital gates.

Disadvantages:

- Adds a new projection and test surface.
- Will make missing source/GitOps metadata more visible until deployer wiring is complete.
- Requires a durable receipt schema after shadow validation.

Decision: select Option C.

## Architecture

The `control_plane_action_broker` is a status-first projection in shadow mode. It consumes existing status reducers and
emits one proof-carrying rollout cell per action class.

```text
action_rollout_cell
  action_class                 # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | paper_canary | live_micro_canary | live_scale | torghut_observe
  broker_decision              # allow | allow_repair | hold | block
  source_head_sha
  gitops_revision
  desired_image_refs
  live_image_refs
  controller_ingestion_ref
  controller_witness_decision
  watch_epoch_ref
  database_migration_ref
  retained_failure_debt_ref
  torghut_proof_floor_ref
  fresh_until
  blocking_reasons
  rollback_target
```

Decision rules:

- `serve_readonly` can allow from healthy serving, route, database, and runtime proof surfaces.
- `torghut_observe` can allow when Torghut dependencies are readable and no capital action is implied.
- `dispatch_repair` requires source/GitOps refs, database projection health, fresh watch, and at least bounded
  controller repair authority.
- `dispatch_normal` requires a current controller ingestion self-report, fresh watch, source/GitOps refs, and no
  retained failure debt that belongs to the same schedule or primitive class.
- `deploy_widen` and `merge_ready` require desired/live image convergence, source/GitOps refs, controller ingestion,
  clean migration projection, and no unresolved high-severity retained failure debt.
- `paper_canary`, `live_micro_canary`, and `live_scale` additionally require a Torghut proof-floor receipt at the
  corresponding capital level.

The broker does not replace the existing reducers. It cites them. That keeps the source modules small enough to test
and gives downstream consumers one stable contract.

## Implementation Scope

Engineer stage:

- Add `control-plane-action-broker.ts` with a pure reducer and typed `ActionRolloutCell` schema.
- Wire the broker into `control-plane-status.ts` next to source rollout truth, controller witness, and material action
  verdicts.
- Add unit tests for missing source refs, missing GitOps refs, missing ingestion self-report, retained failed schedule
  debt, healthy read-only serving, Torghut observe, and proof-floor capital holds.
- Add a retained-failure debt classifier that separates old settled debt from current schedule, workspace, primitive,
  and capital-action debt.
- Keep the first release in shadow mode. Material action behavior should remain unchanged until the broker receipt
  matches current verdicts across at least one full cron cycle.

Deployer stage:

- Inject `JANGAR_SOURCE_HEAD_SHA` and `JANGAR_GITOPS_REVISION` into the Jangar runtime and Agents controller pods from
  the GitOps build context.
- Grant the assessment service account least-privilege read-only access for CNPG cluster metadata and a documented
  path for SELECT-only database evidence, or explicitly document why application projections remain the authority.
- Add release checks that fail widening when broker cells for `dispatch_normal`, `deploy_widen`, or `merge_ready` are
  held by missing source/GitOps truth.
- Keep Torghut capital at zero notional until the broker emits the matching capital action receipt.

## Validation Gates

Local validation:

- `bun run --cwd services/jangar test -- control-plane-action-broker`
- Existing source rollout truth, controller witness, material action verdict, watch reliability, and status tests stay
  green.
- Add regression tests proving read-only and observe lanes remain allowed when material lanes are held.

Live validation:

- `kubectl get applications.argoproj.io -n argocd agents jangar torghut` shows `Synced` and `Healthy`.
- Jangar `/api/agents/control-plane/status?namespace=agents` includes `control_plane_action_broker.mode=shadow`.
- Broker cells cite non-null source and GitOps refs after deployer wiring.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` are not held by `source_rollout_truth_missing` or
  `controller_witness_split`.
- Retained failure debt for old schedule-runner bugs is either settled, explicitly excluded from current authority, or
  still attached to a blocking action class.
- Torghut capital action cells remain held while proof floor is `repair_only`.

## Rollout

1. Ship the broker in shadow mode and expose it in status only.
2. Compare broker cells with current material action verdicts for one complete Jangar and Torghut cron cycle.
3. Enable enforcement for `dispatch_repair` after broker and current verdicts agree.
4. Enable enforcement for `dispatch_normal`, `deploy_widen`, and `merge_ready` only after source/GitOps refs and
   controller ingestion self-report are current.
5. Enable Torghut `paper_canary` and `live_micro_canary` only after the companion Torghut broker emits matching proof
   receipts.

## Rollback

- Disable broker enforcement with a single runtime flag and continue serving the shadow projection.
- Fall back to existing material action verdicts when broker projection fails closed.
- Keep read-only and observe actions available when serving, route, and database projections are healthy.
- Keep Torghut capital at zero notional when proof floor is `repair_only` or broker capital cells are held.
- Treat missing source/GitOps refs as rollback-owned deployer debt, not as a controller bug.

## Risks And Open Questions

- Direct SQL assessment remains blocked by RBAC. The smallest unblocker is read-only CNPG metadata plus SELECT-only
  database access for the assessment identity.
- Retained failure debt needs careful classification so old settled failures do not permanently block unrelated
  actions.
- Deployer wiring must supply source and GitOps refs consistently. Otherwise the broker will hold material lanes by
  design.
- Broker receipts should stay compact. The source reducers own detailed diagnostics; the broker owns admission.

## Handoff Contract

Engineer acceptance gates:

- Broker reducer and status projection are implemented with tests for every action class.
- Shadow broker decisions match existing material verdict behavior for read-only, observe, repair, normal dispatch,
  deploy widening, merge readiness, and Torghut capital holds.
- Missing source/GitOps refs and missing controller ingestion self-report keep material action cells held.

Deployer acceptance gates:

- Runtime pods expose non-null source and GitOps refs in Jangar status.
- Controller ingestion self-report is current after rollout.
- Release widening is blocked when broker cells for `dispatch_normal`, `deploy_widen`, or `merge_ready` are held.
- Torghut paper/live capital remains zero until the companion capital broker has eligible receipts.
