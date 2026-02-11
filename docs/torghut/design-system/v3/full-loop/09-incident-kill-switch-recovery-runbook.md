# 09. Incident, Kill-Switch, and Recovery Runbook

## Objective
Provide executable incident response procedures for Torghut autonomous operation, centered on rapid containment,
verified rollback, and controlled recovery.

## Incident Classes
- Class A: data integrity incident.
- Class B: execution/risk control incident.
- Class C: infrastructure/runtime incident.
- Class D: model/strategy drift incident.

## Kill Switch Policy
Trigger kill switch on:
- risk or compliance hard-limit breach,
- severe data corruption/staleness,
- repeated execution anomalies,
- explicit human emergency override.

Kill switch actions:
- block new orders,
- cancel open eligible orders,
- freeze promotion pipeline.

## Recovery Procedure
1. classify incident and capture incident ID.
2. contain via kill switch and stage freeze.
3. collect diagnostics and evidence bundle.
4. execute rollback to known-good config.
5. verify runtime health and reconciliation.
6. run controlled restart and postmortem.

## Verification Checklist
- scheduler state healthy,
- data freshness restored,
- risk engine operational,
- execution path functional in paper mode,
- gate pipeline reopened only after approvals.

## Agent Implementation Scope (Significant)
Workstream A: incident automation
- implement incident classification and response script templates.

Workstream B: containment controls
- ensure kill switch path is testable and deterministic.

Workstream C: recovery validation
- implement post-recovery verification script.

Workstream D: postmortem integration
- export incident evidence into audit package.

Owned areas:
- `services/torghut/app/trading/firewall.py`
- `services/torghut/app/trading/scheduler.py`
- `services/torghut/scripts/**`
- `docs/torghut/design-system/v1/operations-*.md`

Minimum deliverables:
- incident response scripts,
- kill switch test suite,
- recovery verification checklist,
- postmortem template.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-incident-recovery-impl-v1`.
- Required keys:
  - `incidentId`
  - `torghutNamespace`
  - `rollbackTarget`
  - `confirm`
  - `artifactPath`
- Exit criteria:
  - incident drill passes,
  - kill switch dry-run passes,
  - rollback and recovery verified end-to-end.
