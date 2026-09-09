# 08. Live Rollout and Capital Ramp Plan

## Objective

Define a controlled, reversible live rollout model that ramps capital only when quantitative and operational conditions
remain within policy.

## Rollout Stages

- Stage L0: paper-only baseline.
- Stage L1: minimal live notional (canary symbols only).
- Stage L2: moderate live notional with wider universe.
- Stage L3: target live allocation.

Each stage requires explicit gate pass + approval token.

## Ramp Controls

- max notional per order,
- max gross/net exposure,
- max symbol concentration,
- participation cap,
- loss-limit based automatic de-escalation.

## Automatic Rollback Triggers

- risk limit breach,
- sustained TCA degradation,
- data freshness failure,
- reconciliation mismatch,
- operational incident severity threshold.

## Rollout Procedure

1. prepare GitOps patch for stage parameters.
2. validate policy preconditions.
3. apply stage under approval token.
4. monitor stage SLOs for burn-in window.
5. advance or rollback based on policy outcomes.

## Agent Implementation Scope (Significant)

Workstream A: stage policy config

- codify live ramp stages and per-stage constraints.

Workstream B: actuation workflow

- implement GitOps patch generation and validation scripts.

Workstream C: monitoring hooks

- implement burn-in evaluation and rollback triggers.

Workstream D: safety verification

- test kill switch and stage rollback behavior before each advance.

Owned areas:

- `argocd/applications/torghut/**`
- `services/torghut/scripts/**`
- `docs/torghut/design-system/v3/full-loop/**`

Minimum deliverables:

- stage config manifests,
- rollout CLI/runbook,
- rollback automation,
- live stage audit logs.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-live-ramp-v1`.
- Required keys:
  - `torghutNamespace`
  - `gitopsPath`
  - `rampStage`
  - `confirm`
- Exit criteria:
  - stage transition dry run succeeds,
  - rollback trigger simulation succeeds,
  - no uncontrolled live config drift.
