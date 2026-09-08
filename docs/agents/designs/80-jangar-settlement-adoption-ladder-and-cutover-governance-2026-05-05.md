# 80. Jangar Settlement Adoption Ladder and Cutover Governance (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`

Extends:

- `docs/agents/designs/78-jangar-capital-warrant-issuer-and-route-independent-order-admission-2026-05-05.md`
- `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
- `docs/torghut/design-system/v6/82-torghut-order-admission-warrants-and-replay-capital-auction-2026-05-05.md`

## Decision

Jangar should implement the May 5 architecture stack through a **Settlement Adoption Ladder** instead of landing each
contract as a separate feature toggle. The ladder is a four-rung cutover sequence: shadow settlement, read-path
authority, dispatch and rollout enforcement, and external-capital enforcement. Each rung has an owner, evidence inputs,
tests, rollback switch, and a promotion rule. A later rung cannot be enabled until the earlier rung has produced fresh
settled evidence for the same namespace, release digest, route family, and consumer window.

I am choosing this because the current system already has the right design pieces, but they can still be assembled in a
dangerous order. The live evidence from this pass says Jangar can serve while proof is mixed:

- `GET /ready` returned HTTP 200 with leader election healthy;
- `GET /api/agents/control-plane/status?namespace=agents` reported database `healthy`, execution trust `degraded`, and
  dependency quorum `block`;
- one sampled control-plane status request returned `Empty reply from server` before a retry succeeded;
- scheduled Jangar and Torghut jobs in `agents` showed `ImagePullBackOff`, failed attempts, and image platform mismatch
  events while newer runs on the current digest were running or completed;
- direct CNPG SQL was blocked by the runner service account because it cannot create `pods/exec` in `jangar` or
  `torghut`;
- Torghut served `/healthz`, but `/trading/status` still reported `live_submission_gate.allowed=true` while all three
  hypotheses were shadow or blocked, `promotion_eligible_total=0`, and `rollback_required_total=3`.

The tradeoff is that this makes implementation slower than a single flag. I accept that tradeoff because the failure
mode I want to remove is not a missing field. It is an unsafe cutover where serving, repair, dispatch, rollout widening,
and external capital read different truth surfaces for weeks.

## Scope and Success Metrics

This document is scoped to Jangar control-plane implementation and deployment sequencing. It does not replace the
evidence clock, settlement authority, or capital warrant designs. It turns them into an enforceable adoption order.

Success means engineer and deployer stages can prove all of the following:

1. Jangar emits shadow settlement decisions before any caller is forced to obey them.
2. `/ready`, `/api/agents/control-plane/status`, deploy verification, and Torghut-facing mirrors all carry the same
   `settlement_epoch_id` and `decision_digest` for the sampled namespace and release digest.
3. Dispatch and rollout widening fail closed on stale or contradictory settlement only after repair and observe paths
   are confirmed available.
4. Torghut external-capital admission fails closed only after route parity proves the same Jangar decision is visible to
   status routes, scheduler paths, and broker-bound warrant minting.
5. Rollback is configuration-only for every rung: disabling enforcement keeps shadow emission and diagnostics running.

## Evidence Snapshot

### Cluster and Rollout Evidence

Read-only cluster access was available through the `agents` service account. The account can list pods, jobs, CronJobs,
events, and namespaces, but it cannot list app deployments in all namespaces or exec into database pods. That RBAC shape
is a useful constraint: the ladder cannot require privileged shell checks as the primary promotion proof.

Observed Jangar state:

- `kubectl get pods -n jangar -o wide` showed the primary Jangar pod `2/2 Running`, with Jangar Postgres, Redis,
  OpenWebUI, Bumba, Alloy, and Symphony running.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned `status="ok"` and leader election `isLeader=true`.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed recent rollout churn, readiness probe failures, and
  normal scale-up/scale-down events around promoted Jangar and Symphony revisions.
- `kubectl get pods -n agents -o wide` showed fresh Jangar discover, plan, implement, and verify jobs mixed with older
  failed or image-pull-blocked attempts.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed `ImagePullBackOff`, `ErrImagePull`, `UnexpectedJob`,
  and `MissingJob` warnings for scheduled swarm work.

Interpretation: serving is available, but rollout-derived health is not sufficient evidence for dispatch or widening.

### Source and Test Evidence

The relevant source surface is already split across several large modules:

- `services/jangar/src/server/control-plane-status.ts` assembles controller, database, watch, workflow, dependency,
  runtime-kit, and admission-passport evidence.
- `services/jangar/src/server/control-plane-execution-trust.ts` evaluates pending requirements, stage freshness, and
  freeze state.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule-runner command generation and
  supporting primitive watches.
- `services/jangar/src/server/control-plane-rollout-health.ts` summarizes rollout state.
- `services/jangar/src/routes/ready.tsx` intentionally keeps serving readiness narrower than promotion health.

The high-risk fact is not lack of tests in general. It is lack of cross-route cutover tests. The checked files show
large shared surfaces: `control-plane-status.ts` has 572 lines, `control-plane-execution-trust.ts` has 506 lines, and
`supporting-primitives-controller.ts` has 2788 lines. A flag added in only one of these paths can create a second truth
surface.

The ladder therefore requires tests that span routes and action classes:

- a healthy `/ready` response with degraded execution trust must still allow `serve`, `observe`, and `repair`;
- the same evidence must hold `dispatch`, `widen`, and `external_capital`;
- status, deploy verification, and Torghut mirrors must expose identical decision digests;
- a route reset or empty reply must create route-specific negative evidence, not a global serving outage;
- lack of direct database exec access must be represented as `privileged_sql_unavailable` while application database
  proof can still satisfy schema parity.

### Database and Data Evidence

Direct SQL through `kubectl cnpg psql` failed for both Jangar and Torghut because the service account cannot create
`pods/exec` in the target namespaces. That is not a blocker for this design. It is the reason the ladder requires
application database proof, migration job proof, and route-specific probes.

Allowed evidence in this pass:

- Jangar control-plane status reported database `healthy`.
- Torghut `/db-check` returned `ok=true` and `schema_graph_lineage_ready=true`.
- Torghut migration events showed a fresh `torghut-db-migrations` job completed during the sampled window, though the
  job was gone before a later log read.
- Torghut `/trading/status` exposed a consistency failure: live submission liveness allowed, but dependency quorum
  blocked and every loaded hypothesis remained shadow or blocked.

Interpretation: schema health is not enough. The ladder must treat schema proof, route proof, workflow proof, and
capital proof as separate inputs with separate expiries.

## Problem

The current architecture stack correctly separates clocks, settlement, and capital warrants. What it does not yet
define is the order in which those concepts become authoritative.

Without an adoption ladder, the next implementation can fail in three ways:

1. Jangar starts blocking dispatch before repair and observe routes are proven, making incidents harder to clear.
2. Torghut starts reading a new capital decision while scheduler and broker paths still use older liveness fields.
3. Deployers widen a rollout based on pod readiness while the settlement path is still shadow-only or route probes are
   failing.

That failure would look superficially "implemented" but would not reduce the actual failure mode.

## Options Considered

### Option A: Single Big-Bang Enforcement

Implement clocks, settlement, Jangar capital decisions, Torghut warrants, and broker enforcement behind one feature
flag, then enable the flag after tests pass.

Pros:

- one obvious switch;
- fastest path to a visible enforcement posture;
- small amount of rollout documentation.

Cons:

- no production comparison period;
- a bug in the new authority can block repair or observability;
- route parity bugs are discovered only after enforcement;
- rollback hides the new diagnostics along with enforcement.

Decision: reject. It is too much unobserved authority in one step.

### Option B: Advisory-Only Settlement

Emit settlement and warrant fields in status routes, but leave all existing dispatch, rollout, and capital behavior
unchanged until humans decide the fields are trustworthy.

Pros:

- very low operational risk;
- no immediate workload disruption;
- simple to land in small PRs.

Cons:

- does not remove the false-positive green surface;
- creates another dashboard field that can be ignored;
- no crisp handoff from engineering to deployment;
- Torghut can keep treating live submission liveness as capital permission.

Decision: reject as the destination. Advisory mode is useful only as the first rung.

### Option C: Settlement Adoption Ladder

Introduce a staged ladder with explicit promotion gates and rollback switches. Keep shadow emission first, then make
read paths authoritative, then enforce dispatch/widening, then enforce external capital.

Pros:

- keeps repair and observe available during cutover;
- lets engineers compare old and new decisions before blocking work;
- gives deployers an exact order and exact rollback switch for each rung;
- binds Torghut capital enforcement to route parity rather than a single status field.

Cons:

- requires more coordination and documentation;
- temporarily supports two interpretations while shadow comparison runs;
- needs acceptance tests that span Jangar and Torghut.

Decision: select Option C.

## Chosen Architecture

### SettlementAdoptionState

Jangar should expose a compact adoption state alongside settlement decisions:

```text
settlement_adoption_state
  namespace
  release_digest
  settlement_epoch_id
  rung                         # shadow, read_authority, dispatch_widen, external_capital
  enforcement_mode             # off, shadow, warn, enforce
  observed_at
  fresh_until
  required_inputs
  satisfied_inputs
  blocked_inputs
  decision_digest
  previous_decision_digest
  rollback_switch
  promoted_by
  promoted_at
```

This may be persisted in Postgres or materialized in the existing control-plane status builder first. The important
contract is the shape and the monotonic rung semantics, not the first storage choice.

### Rung 1: Shadow Settlement

Jangar computes evidence clocks, settlement authority decisions, and capital decisions but does not block dispatch,
rollout widening, or Torghut capital. It records what the new authority would have done.

Promotion gate:

- at least one full scheduled Jangar control-plane loop emits a fresh decision digest;
- `/ready` and control-plane status both expose the same digest;
- route probes produce explicit success or negative evidence;
- missing privileged SQL is represented as an input limitation, not as unknown global health.

Rollback:

- set enforcement mode to `off`; diagnostics may continue emitting.

### Rung 2: Read-Path Authority

Jangar status routes label settlement as the authority for action classes. Existing operational dashboards and Torghut
mirrors read the same digest, but enforcement remains warning-only.

Promotion gate:

- status, deploy verification, and Torghut mirror outputs agree on `allowed_action_classes`;
- stale execution trust produces a hold for `dispatch` and `widen` while preserving `serve` and `repair`;
- route-specific resets appear as negative evidence refs.

Rollback:

- return to shadow labels while keeping emitted decisions for diffing.

### Rung 3: Dispatch and Rollout Enforcement

Jangar blocks new dispatch and rollout widening when settlement denies those action classes. Existing running repair or
observe work is not killed by this rung.

Promotion gate:

- generated schedule-runner commands have parser/golden coverage;
- rollout health and recent events feed the same settlement epoch;
- manual dispatch paths and CronJob paths call the same admission helper;
- deploy verification fails closed when the decision digest is absent or expired.

Rollback:

- disable dispatch/widen enforcement only. Keep read-path authority and shadow capital decisions live.

### Rung 4: External Capital Enforcement

Jangar's capital decision becomes a required input for Torghut non-shadow order admission. Torghut enforces broker-bound
warrants; Jangar signs or mirrors the control-plane decision.

Promotion gate:

- Torghut status, scheduler, and broker warrant minting all bind the same Jangar decision digest;
- current May 5 style evidence produces `hold` or `shadow_only`, never non-shadow `allow`;
- at least one market session or three Jangar rollout cycles complete in warning mode with no digest disagreement;
- rollback-required hypothesis count is zero before any live capital allow.

Rollback:

- disable external-capital enforcement and continue emitting shadow decisions; do not disable broker diagnostics.

## Engineer Handoff

Implement this ladder in small, reviewable cuts:

1. Add the adoption-state builder and route serialization.
2. Wire the builder to existing clock, settlement, rollout, execution-trust, and database proof inputs.
3. Add cross-route tests for `/ready`, control-plane status, deploy verification, and Torghut mirrors.
4. Add dispatch/widen admission helpers that consume the same decision digest.
5. Add configuration switches per rung with default `shadow`.
6. Add traceable negative evidence refs for route resets, image-pull event windows, stale stages, and unavailable
   privileged SQL.

The first implementation PR should not enforce capital. It should make shadow decisions visible and testable.

## Deployer Handoff

Deployers should promote rungs only in order:

1. shadow settlement on the current Jangar digest;
2. read-path authority after route parity is proven;
3. dispatch and rollout enforcement after schedule and deploy verification tests pass;
4. external-capital enforcement after Torghut route parity and broker warrant rejection are proven.

Do not widen based on pod readiness alone. Widen only when the settlement decision for the release digest allows
`widen` and has not expired.

## Validation

Required validation for implementation:

- unit tests for all adoption rungs and enforcement modes;
- regression test for HTTP 200 readiness plus degraded execution trust holding dispatch;
- regression test for missing or expired decision digest blocking deploy verification;
- regression test for Torghut live submission liveness not clearing external capital;
- docs check with `bunx oxfmt --check` for touched markdown files;
- route smoke for `/ready` and `/api/agents/control-plane/status?namespace=agents`.

## Rollout

Roll out as additive status first. Enable `shadow` by default, collect one full scheduled loop, then promote to
`read_authority`. Dispatch/widen enforcement should be limited to one namespace before becoming the default. External
capital enforcement should start with shadow and paper accounts before any live account scope.

## Rollback

Rollback must not require reverting code. Each rung has a configuration switch:

- `settlementAdoption.shadow.enabled`
- `settlementAdoption.readAuthority.enabled`
- `settlementAdoption.dispatchWiden.enforce`
- `settlementAdoption.externalCapital.enforce`

Disabling a later rung must leave earlier diagnostics enabled. The only emergency rollback that disables all settlement
emission is reserved for corrupted or sensitive evidence serialization.

## Risks

- The ladder can become another stale status object if `fresh_until` is not enforced.
- Shadow comparison can create operator complacency if warning mode lasts too long.
- Too much negative evidence can leak operational detail; receipts must use compact reason refs.
- External-capital enforcement can starve trading if repair paths are blocked. This is why repair remains separate from
  dispatch and capital.
- Route parity must be tested continuously. A single alternate path can recreate the false-positive liveness problem.
