# 174. Jangar Observer Rights And Source-Settled Capital Ledger (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, observer-rights failure modes, source/GitOps settlement, database evidence
projection, Torghut capital admission, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/178-torghut-route-sample-mint-and-capital-proof-ratchet-2026-05-08.md`

Extends:

- `173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
- `172-jangar-evidence-reconciliation-broker-and-capital-action-firewall-2026-05-08.md`
- `170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md`
- `docs/torghut/design-system/v6/177-torghut-profit-repair-broker-and-capital-promotion-gates-2026-05-08.md`

## Decision

I am selecting a **source-settled capital ledger backed by explicit observer-rights receipts** as the next Jangar
control-plane architecture step.

The current cluster is healthier than the earlier swarm soak, but the useful lesson is not that the system is fine.
On 2026-05-08 at 02:10Z to 02:12Z, Argo CD reported `jangar` and `torghut` `Synced` and `Healthy` at
`05900d8f39643c92457e22b97e909ee25521325d`; `agents` was `Synced` and `Healthy` at
`513998a66143587731d89fb135961d5c0d78c0c8`. Jangar had all listed deployments available, including `jangar=1/1`,
and Agents had `agents-controllers=2/2`. Jangar `/ready` returned `status=ok`, execution trust was healthy, the
self-hosted memory provider was healthy, and serving plus collaboration runtime kits were healthy. The old missing
NATS runtime-kit risk is closed in this snapshot.

The failure mode that remains is sharper: the service account can observe the most important serving and rollout
surfaces, but it cannot observe every surface the architecture depends on. It cannot list `statefulsets.apps` in
`jangar`, `torghut`, or `agents`; it cannot list Knative revisions in `torghut`; and it cannot `pods/exec` into CNPG or
ClickHouse pods for direct read-only database checks. Torghut still proves database health through application
projections: `/db-check` returned `ok=true`, expected Alembic head `0029_whitepaper_embedding_dimension_4096`,
schema lineage ready, and known parent-fork warnings. That is acceptable for observation, but it is not enough for
capital admission unless Jangar names the missing observer rights and the application projection that substituted for
direct evidence.

The decision is to make observer capability part of the action and capital receipt. Jangar should publish one
source-settled capital ledger per control-plane epoch. The ledger must say which evidence classes were directly
observed, which were projected by the application, which were blocked by RBAC, which source/GitOps revision produced
the status, and which Torghut capital class the epoch may support. Missing observer rights become explicit holds for
deploy widening, merge readiness, paper canaries, live micro, and live scale. They do not block read-only service or
zero-notional Torghut observation when the projected evidence is healthy and fresh.

The tradeoff is that some rollouts will look noisier. I accept that. The six-month risk is not a red dashboard; it is
a green dashboard that quietly substituted application projection for a direct database or rollout witness without
telling the deployer or the trading owner.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Local branch `codex/swarm-torghut-quant-discover` was exactly at `origin/main` before edits.
- `kubectl auth whoami` resolved to `system:serviceaccount:agents:agents-sa` after bootstrapping the in-cluster
  kube context from the mounted service-account token.
- Argo CD reported `jangar` and `torghut` `Synced` and `Healthy` at `05900d8f39643c92457e22b97e909ee25521325d`;
  `agents` was `Synced` and `Healthy` at `513998a66143587731d89fb135961d5c0d78c0c8`.
- Jangar pods were running and deployments were available: `bumba`, `jangar`, `jangar-alloy`, `symphony`, and
  `symphony-jangar` were each available.
- Torghut live revision `torghut-00292` and sim revision `torghut-sim-00391` were running after rollout events that
  initially showed startup and readiness probe failures, then `RevisionReady`.
- Agents controllers were available at `2/2`, but the namespace retained many completed and failed historical jobs.
  Current `torghut-quant-discover` and Jangar cron jobs were completing, while retained failed jobs remained as debt.
- Observer RBAC is incomplete for architecture-grade evidence: list access to statefulsets and Knative revisions is
  denied, and pod exec for CNPG/ClickHouse direct database reads is denied.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation point for control-plane readiness. It is
  already large enough that new action rules need clear typed projections instead of more implicit status joins.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` and
  `services/jangar/src/server/control-plane-runtime-admission.ts` already separate runtime admission and action
  classes. The missing contract is observer capability: whether the status payload saw each required class directly,
  through an application projection, or not at all.
- `services/torghut/app/main.py` exposes database, proof floor, TCA, empirical, quant, and alpha readiness evidence to
  Jangar. This is valuable, but it is an application projection; Jangar should carry that provenance in the ledger.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition.py`, `hypotheses.py`, and `tca.py` are the
  current Torghut capital evidence producers. The source surface is broad: 129 trading modules and 146 Torghut test
  files, which is enough coverage to evolve carefully but large enough that Jangar should demand explicit source and
  evidence receipts before capital gates.

### Database And Data Evidence

- Direct CNPG and ClickHouse reads were blocked by RBAC:
  `cannot create resource "pods/exec" in API group "" in the namespace "torghut"`.
- Torghut `/db-check` returned `ok=true`, expected head `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, `schema_graph_branch_count=1`, and known parent-fork warnings for the historical
  `0010` and `0015` migration branches.
- Torghut `/readyz` returned `status=degraded` while Postgres, ClickHouse, database schema, universe, and empirical
  jobs were healthy. The degradation was correctly tied to proof-floor and capital blockers, not basic storage.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported dependency quorum `allow`, execution trust
  healthy, market/context segments healthy, empirical jobs healthy, forecast degraded with `registry_empty`, and Lean
  disabled with deterministic scaffold only.

## Problem

Jangar can currently answer "is the control plane serving" better than it can answer "is this evidence complete enough
to widen authority or admit Torghut capital." That difference matters. Serving and observing should survive partial
RBAC. Promotion should not.

The concrete failure modes are:

1. A status payload can be `ok` while critical observer rights are missing.
2. Application database projections can be healthy while direct database witnesses are unavailable.
3. Source and GitOps revisions can be absent or stale while a live image digest is healthy.
4. Retained failed jobs can coexist with current successful cron jobs without being classified by current relevance.
5. Torghut capital can be blocked for good reasons, but the upstream control plane can fail to carry those reasons as
   capital ledger facts.

The control plane needs a ledger that separates availability, observer completeness, source settlement, and capital
authority.

## Alternatives Considered

### Option A: Grant Broad Read-Only Cluster And Database Rights

Give the assessment and Jangar service accounts list/read/exec rights over all relevant namespaces and database pods.

Advantages:

- Fastest path to direct evidence.
- Makes ad hoc debugging easier.
- Reduces reliance on application projections.

Disadvantages:

- Expands blast radius for every control-plane observer.
- `pods/exec` is too powerful for routine capital admission.
- Does not solve source/GitOps settlement or retained failure classification.

Decision: reject as the primary architecture. Add narrowly scoped rights only where the ledger proves they are needed.

### Option B: Trust Application Projections Only

Treat Torghut and Jangar application status as the complete evidence surface. Keep RBAC narrow and do not distinguish
projected from directly observed evidence.

Advantages:

- Least operational friction.
- Keeps service accounts small.
- Uses surfaces that already exist and are tested.

Disadvantages:

- Hides observer gaps from deployers.
- Makes direct database and rollout witness absence invisible to capital gates.
- Can let a healthy application projection become a promotion shortcut.

Decision: keep projections as inputs, but require provenance in capital receipts.

### Option C: Observer-Rights Receipts And Source-Settled Capital Ledger

Publish a ledger that records observer coverage, source/GitOps settlement, database evidence provenance, retained
failure relevance, and Torghut capital authority for each epoch.

Advantages:

- Keeps read-only and observe paths available under partial rights.
- Converts missing observer rights into explicit promotion holds.
- Lets deployers add least-privilege rights based on named evidence gaps.
- Gives Torghut a stable upstream receipt for zero-notional, paper, live micro, and live scale gates.

Disadvantages:

- Adds a new projection and tests.
- Forces deployer wiring for source/GitOps refs to be correct.
- Requires more disciplined status payloads.

Decision: select Option C.

## Architecture

Jangar publishes a `source_settled_capital_ledger` in shadow mode first. It consumes the existing runtime admission,
material action verdict, source rollout truth, watch reliability, database projection, and Torghut proof-floor
surfaces.

```text
source_settled_capital_ledger
  ledger_id
  generated_at
  fresh_until
  source_head_sha
  gitops_revision
  desired_image_digest
  live_image_digest
  observer_rights
  database_evidence
  retained_failure_debt
  torghut_capital_state
  action_cells
  deployer_summary
  rollback_target
```

Each observer-right receipt is explicit:

```text
observer_right
  evidence_class              # deployment | statefulset | knative_revision | cnpg_cluster | clickhouse | agentrun | events
  required_for                # observe | dispatch_repair | deploy_widen | paper_canary | live_micro | live_scale
  observation_mode            # direct | application_projection | unavailable
  subject_ref
  observed_at
  blocking_reason
```

Promotion rules:

- `serve_readonly` and `torghut_observe` may allow with healthy application projections and explicit observer gaps.
- `dispatch_repair` may allow with source/GitOps settlement, fresh watch, database projection health, and no current
  retained failure debt for the repair lane.
- `deploy_widen` and `merge_ready` require non-null source/GitOps refs, desired/live image convergence, fresh
  controller ingestion, and no missing direct observer rights that are marked required for rollout.
- `paper_canary`, `live_micro`, and `live_scale` additionally require Torghut proof-floor state to reach the matching
  capital class and must fail closed if database evidence is projection-only without an accepted waiver.

## Implementation Scope

Engineer stage:

- Add a pure reducer for `source_settled_capital_ledger` and typed observer-right receipts.
- Wire it into Jangar control-plane status without changing enforcement in the first release.
- Add tests for unavailable statefulset rights, unavailable Knative revision rights, unavailable direct database
  rights, healthy application database projections, missing source/GitOps refs, and Torghut capital holds.
- Add a retained-failure relevance classifier that separates stale historical failed jobs from current schedule debt.
- Expose the ledger in the control-plane status payload with `mode=shadow` and a stable schema version.

Deployer stage:

- Inject source and GitOps revision refs into Jangar and Agents controller runtimes.
- Replace any broad observer request with named least-privilege rules from the ledger.
- Add release verification that fails promotion when direct observer rights required for the target action are missing.
- Keep Torghut paper/live capital blocked until the ledger names the matching capital action as allowed.

## Validation Gates

Local validation:

- Unit tests cover every observer mode: `direct`, `application_projection`, and `unavailable`.
- Existing control-plane status, runtime admission, material verdict, and source rollout truth tests remain green.
- Snapshot tests prove read-only status remains available when observer rights are incomplete.

Live validation:

- `kubectl get applications.argoproj.io -n argocd jangar torghut agents` is `Synced` and `Healthy`.
- Jangar `/ready` includes healthy runtime kits and execution trust.
- Jangar control-plane status includes `source_settled_capital_ledger.mode=shadow`.
- Ledger receipts identify current RBAC gaps instead of silently omitting those evidence classes.
- No paper or live capital action is allowed while Torghut proof floor is `repair_only` or database evidence is
  projection-only without waiver.

## Rollout And Rollback

Rollout starts as a shadow projection. For one full trading day, compare the ledger's action decisions with the
existing material action verdicts and Torghut proof-floor decisions. After parity, deployer can make promotion checks
consume the ledger for `deploy_widen`, `merge_ready`, and capital action classes.

Rollback is to stop consuming the ledger and return to existing material action verdicts. Rollback must keep Torghut
capital at zero notional unless the old proof floor independently allows promotion. Do not broaden RBAC as rollback.

## Risks

- The first shadow release may produce many holds because source/GitOps refs are not wired everywhere.
- Application projections can remain too trusted unless the waiver path is explicit and time-bounded.
- Retained failure classification must be conservative; misclassifying current debt as historical debt would recreate
  the same silent-risk problem.

## Handoff

Engineer: build the ledger as a pure reducer and treat every missing observer right as data, not an exception. The
first production proof is a status payload that can explain why read-only observation is allowed while deploy widening
and capital admission are held.

Deployer: wire source/GitOps refs, add only the least-privilege observer rights named by the ledger, and keep paper and
live capital blocked until the ledger and Torghut proof floor both admit the target capital class.
