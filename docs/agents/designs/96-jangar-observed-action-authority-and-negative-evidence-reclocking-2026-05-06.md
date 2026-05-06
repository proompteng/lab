# 96. Jangar Observed-Action Authority And Negative Evidence Reclocking (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane authority reconciliation, failure-domain lease correctness, schedule launch safety, rollout
admission, Torghut proof consumption, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/100-torghut-market-context-negative-evidence-and-shadow-capital-router-2026-05-06.md`

Extends:

- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `94-jangar-proof-backed-rollout-brake-and-repair-debt-ledger-2026-05-05.md`
- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `docs/torghut/design-system/v6/99-torghut-profit-proof-escrow-and-repair-dividend-slo-2026-05-05.md`

## Decision

I am choosing an **observed-action authority reconciler with negative-evidence reclocking** as the next Jangar
control-plane architecture step.

The May 5 designs correctly moved Jangar toward evidence settlement, launch escrow, and proof-backed rollout brakes.
The current live system exposes the next failure mode: different evidence surfaces can now disagree while each is
internally plausible. Jangar serving readiness and the control-plane status API are healthy, the Swarm CR still marks
all stages unhealthy/stale, and failure-domain leases can hold dispatch and merge on a database-routability reason even
when the database probe and migration table are healthy. That is not a reason to add another global ready bit. It is a
reason to make every material action cite the exact authority clock that allowed it, and to quarantine contradictory
negative evidence until its classifier and subject are proven.

The tradeoff is that Jangar will sometimes delay normal dispatch while evidence clocks settle. I accept that tradeoff
because the current operational risk is not lack of automation. The risk is confident automation from the wrong clock.

## Evidence Snapshot

All evidence for this pass was read-only. No Kubernetes resources or database rows were mutated.

### Cluster And Rollout Evidence

- The run used the requested branch `codex/swarm-jangar-control-plane-discover`, freshly fetched from `origin/main`.
- `kubectl config current-context` was unset; the workspace was bootstrapped to the documented in-cluster context and
  authenticated as `system:serviceaccount:agents:agents-sa`.
- `agents` namespace Deployments were ready: `agents` `1/1` and `agents-controllers` `2/2`, both on image
  `a4c52389`.
- Jangar `/ready` returned `status=ok`, leader election enabled with this control-plane pod as leader, execution trust
  healthy, and collaboration runtime kit healthy.
- Jangar `/api/agents/control-plane/status` at `2026-05-06T00:07:59Z` reported fresh controller heartbeats, healthy
  database, healthy rollout, dependency quorum `allow`, and execution trust healthy.
- The `Swarm` CR for `jangar-control-plane` at nearly the same time still had `Ready=True` with reason `Degraded` and
  message `stage or requirement health degraded (discover, plan, implement, verify)`. Every stage had `fresh=false` and
  `healthy=false`, even though recent successes were within the last hour.
- Recent `agents` jobs show the mixed operating reality: discover/implement/plan schedules are mostly completing, but
  multiple verify jobs failed or hit `BackoffLimitExceeded`, and one verify attempt was still running.
- Recent namespace events included scheduling pressure (`Too many pods`), readiness probe timeouts during rollout, and
  `UnexpectedJob` on a manual verify job observed by the verify CronJob.

### Source Architecture Evidence

- `services/jangar/src/server/control-plane-status.ts` is the status aggregator. It already merges controller
  heartbeats, database status, workflow reliability, rollout health, watch reliability, empirical services, execution
  trust, runtime admission, and failure-domain leases.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` is the most sensitive current classifier. It
  converts raw pods, events, probes, and migration status into action-class holdbacks for dispatch, deploy widening,
  merge readiness, and Torghut capital.
- The database pod classifier currently treats any pod name containing `db` as a database pod. In the live sample, the
  expired database lease referenced `pod:agents:jangar-control-plane-implement-sched-cron-29633615-jdbkd`; that is a
  completed schedule-runner pod with a random suffix containing `db`, not durable database evidence.
- The same lease chain made `source_schema` unknown with reason `source_schema.database_unroutable`, causing
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` holdbacks despite the status API reporting
  `database.connected=true` and migration consistency healthy.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the actuation choke point at 2,878 lines. It
  owns schedules, swarms, status, signal delivery, workspaces, PVC lifecycle, and resource watches, so authority
  enforcement belongs here but must be narrowly staged.
- Relevant tests exist for control-plane status, failure-domain leases, Torghut market context, and migration
  registration. Missing coverage is the exact cross-clock failure: a healthy DB probe plus an unrelated pod whose name
  happens to contain `db`, a healthy control-plane status route plus stale Swarm stage clocks, and a healthy quant route
  whose account/window proof is omitted.

### Database And Data Evidence

- CNPG cluster listing was forbidden in both `agents` and `torghut` for this service account. That is the right
  least-privilege posture; routine Jangar admission cannot depend on privileged CNPG reads.
- Jangar status reported database `configured=true`, `connected=true`, `status=healthy`, 16 ms latency, and migration
  consistency healthy: 28 registered migrations, 28 applied migrations, 0 unapplied, 0 unexpected, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/db-check` returned `ok=true`, schema current, current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage-ready state with known
  parent-fork warnings.
- Torghut `/readyz` was degraded even though Postgres, ClickHouse, Alpaca, and schema checks were OK. Live submission
  was blocked by `simple_submit_disabled`, capital stage was `shadow`, three hypotheses existed, zero were promotion
  eligible, and three required rollback.
- Jangar Torghut quant health returned `ok=true`, latest metrics count `3780`, and zero lag, but also
  `stageScopeOmitted=true` because account/window were required for scoped pipeline health.
- Jangar market-context health returned overall `down`: technicals and regime were error, fundamentals and news were
  missing, and ClickHouse ingestion reported `CH_HOST is not configured`.

## Problem

Jangar has moved from missing evidence to conflicting evidence. That is a better problem, but it is still dangerous if
the controller treats every negative signal as equally authoritative.

Three failure modes are visible now:

1. **Authority surfaces diverge.** The status API can say controllers, rollout, database, and dependency quorum are
   healthy while the Swarm CR says all stages are stale. A deployer needs to know which clock gates which action.
2. **Negative evidence can be misclassified.** A random job-pod suffix containing `db` can be promoted into a database
   lease expiry. If enforcement moved straight from shadow to hard gate, this would freeze dispatch for the wrong
   reason.
3. **Data proof is underspecified by route health.** Torghut quant health can be OK with scoped pipeline health omitted,
   while market-context health is down. Capital and repair decisions need typed proof clocks, not a route-level OK.

The next architecture has to separate observed action authority from raw observation. Raw observations are inputs.
Authority is the reconciled, typed, current decision that a controller may spend.

## Alternatives Considered

### Option A: Tighten The Existing Failure-Domain Lease Heuristics

Fix the database pod classifier, add tests, and keep the current lease model.

Pros:

- Fastest way to remove the visible false holdback.
- Low schema impact.
- Keeps the current status API shape.

Cons:

- Fixes one classifier without solving clock disagreement.
- Still lets new negative evidence block action before its subject and confidence are reconciled.
- Does not provide a durable link between a material action and the authority clock that allowed it.

Decision: do the classifier fix in the engineer stage, but reject it as the architecture.

### Option B: Make The Control-Plane Status API The Single Source Of Truth

Treat `/api/agents/control-plane/status` as authoritative and down-rank Swarm CR status when they disagree.

Pros:

- Gives operators one surface.
- Builds on the richest current aggregator.
- Reduces confusion during incidents.

Cons:

- Centralizes too much authority in one route.
- Can hide useful stale-stage evidence from the CR.
- Still does not carry action receipts into schedule-runner creation, rollout widening, or capital reentry.

Decision: reject. The status API should publish authority, not silently become all authority.

### Option C: Observed-Action Authority Reconciler With Negative-Evidence Reclocking

Create a reconciler that consumes positive and negative evidence, reclocks it by action class, quarantines contradictory
negative evidence, and issues explicit authority receipts for material actions.

Pros:

- Makes clock disagreement explicit and testable.
- Prevents a low-confidence negative observation from becoming an immediate hard gate.
- Gives engineer/deployer stages one receipt to validate for each action class.
- Preserves least privilege by relying on route, status, object, and digest evidence.
- Lets Torghut consume only the action clocks relevant to observe, repair, paper, or live capital.

Cons:

- Adds one more durable control-plane object.
- Requires a shadow period to compare authority decisions with existing leases.
- Forces each evidence producer to name subject kind, classifier, confidence, and expiry.

Decision: select Option C.

## Chosen Architecture

### ObservedActionAuthority

Jangar materializes one authority receipt per namespace and action class:

```text
observed_action_authority
  authority_id
  namespace
  action_class
  decision
  generated_at
  fresh_until
  producer_revision
  positive_evidence_refs
  negative_evidence_refs
  quarantined_evidence_refs
  source_clock_digests
  conflict_state
  allowed_parallelism
  rollback_trigger
```

The initial action classes are `serve_readonly`, `dispatch_normal`, `dispatch_repair`, `deploy_widen`, `merge_ready`,
`torghut_observe`, `torghut_repair`, `torghut_paper_capital`, and `torghut_live_capital`.

`serve_readonly` can remain allowed from route and controller evidence. `merge_ready`, `deploy_widen`, and capital
classes require stronger database, stage, rollout, and data-proof clocks. `dispatch_repair` may remain open when normal
dispatch is held, but only with a launch escrow receipt and a named debt reduction.

### NegativeEvidenceEnvelope

Every blocking observation first becomes a typed envelope:

```text
negative_evidence_envelope
  evidence_id
  producer
  observed_at
  expires_at
  subject_kind
  subject_ref
  classifier
  confidence
  action_classes
  contradicts_refs
  quarantine_decision
  promotion_reason
```

An envelope may hard-block only when its subject is typed and its classifier confidence is high. A pod-name substring is
not enough for database authority. Database pod evidence must cite a CNPG label, a known service selector, owner
reference, or configured DB namespace/name. When the DB probe is healthy and the only negative DB evidence is an
untyped pod-name heuristic, the envelope is quarantined and cannot hold `merge_ready` or `dispatch_normal`.

### Reclocking Rules

The authority reconciler uses these initial rules:

- Swarm stage freshness gates stage launch classes, not read serving.
- Jangar DB probe and migration consistency gate `merge_ready`, `deploy_widen`, and source-schema authority.
- Kubernetes pod evidence gates database authority only when typed by label, owner, or configured DB identity.
- Backoff and failed verify jobs reduce `dispatch_normal` parallelism before they block all dispatch.
- Torghut market-context `down` gates `torghut_live_capital` and `torghut_paper_capital`; it opens
  `torghut_repair` if a repair candidate has bounded route cost.
- Quant health with `stageScopeOmitted=true` may prove route freshness, but it cannot prove account/window profit
  readiness.

### Persistence And API

Engineer stage should add a compact table or cache-backed projection:

- `control_plane_observed_action_authority`: latest authority receipt by namespace/action class plus 7 days of history.
- `control_plane_negative_evidence`: negative envelopes with classifier, subject, confidence, expiry, and quarantine
  state.
- `/api/agents/control-plane/authority`: read-only route returning the current receipts and conflict summaries.

This is not a replacement for Swarm status. It is the action ledger that reconciles Swarm, status, rollout, DB, and
Torghut proof clocks.

## Implementation Scope

Engineer stage:

- Fix database pod classification so random job names do not satisfy database-pod evidence.
- Add tests for a healthy database probe plus unrelated `*-db*` job pod; the authority must quarantine the pod evidence
  and keep database/source-schema action clocks valid.
- Add an observed-action authority builder over the existing status ingredients before adding any new producer.
- Add unit coverage for healthy status plus stale Swarm stages, backoff verify jobs plus healthy rollout, and Torghut
  market-context down plus quant route OK.
- Add route and type definitions for authority receipts and negative evidence envelopes.

Deployer stage:

- Verify the new route is read-only, low-latency, and available without CNPG or Argo privileges.
- Compare authority decisions against existing failure-domain leases in shadow mode for at least one full swarm cadence.
- Do not enforce hard holdbacks from the new authority until false positive quarantines are visible in status and logs.

## Validation Gates

- Unit tests prove the random-suffix database false positive cannot hold dispatch or merge.
- Unit tests prove stale Swarm stages do not block `serve_readonly` but do cap or hold stage launch classes.
- Unit tests prove market-context `down` blocks capital while allowing bounded repair.
- Local validation runs `bunx oxfmt --check` on the new docs and targeted TypeScript tests when code lands.
- Runtime validation samples `/ready`, `/api/agents/control-plane/status`, `/api/agents/control-plane/authority`, the
  Jangar Swarm CR, and Torghut `/readyz`, `/db-check`, quant health, and market-context health.

## Rollout

1. Ship the classifier fix and authority builder in shadow mode.
2. Publish authority receipts beside existing failure-domain leases; do not enforce them.
3. After one full cadence without unexplained conflicts, enforce `serve_readonly`, `dispatch_repair`, and
   `torghut_observe`.
4. Enforce `dispatch_normal`, `deploy_widen`, and `merge_ready` only after the authority route and Swarm CR agree on
   action-class decisions for two consecutive cadences.
5. Enforce Torghut paper/live capital only after the companion Torghut proof router provides scoped account/window
   evidence.

## Rollback

Rollback is a feature-flag disable of observed-action authority enforcement. Keep the read route available for
diagnostics, fall back to existing failure-domain leases and launch escrow, and remove any new schedule holdbacks that
cite only authority receipts. If the classifier fix regresses, revert that commit and let database/source-schema
holdbacks return to the previous shadow behavior until typed pod evidence is restored.

## Risks

- The authority table can become another stale truth source if receipts are not short-lived.
- Quarantining negative evidence must not hide real DB outages. The DB probe remains authoritative when it fails.
- Action-class naming has to stay stable; otherwise deployer gates will drift.
- Shadow-only periods can create false confidence if no one compares conflicts. The route must surface conflict counts
  and top quarantines.

## Handoff

The next engineer should start with the database pod classifier and the authority receipt builder. The first acceptance
gate is narrow: a healthy DB probe and current migrations must beat an unrelated pod-name heuristic, and the decision
must be visible as a quarantined negative evidence envelope. The next deployer should keep enforcement off until one
full Jangar cadence shows authority receipts, Swarm CR status, and failure-domain leases agreeing or explaining their
conflicts.
