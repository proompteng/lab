# Autonomy, Governance, and Rollout Plan

## Objective
Enable autonomous quant development and controlled promotion in Torghut with clear ownership, safety gates, and
AgentRun-executable workflows.

## Governance Model

### Lanes
- Research lane:
  - hypothesis generation, candidate strategy implementation, offline experiments.
- Validation lane:
  - replay, walk-forward, stress tests, TCA and risk gate evaluation.
- Promotion lane:
  - GitOps PRs for paper rollout and controlled progression.
- Operations lane:
  - health diagnostics, incident response, and rollback automation.

### Decision rights
- research can propose candidates.
- validation can approve/reject promotion readiness.
- promotion requires explicit gate signoff and audit trail.
- operations can pause/rollback independently on safety triggers.

## AgentRun Operating Model
- every major workflow anchored by `ImplementationSpec` with required keys.
- no freeform prompt overrides unless intentionally scoped.
- PR-producing runs require unique `codex/...` head branches.
- all runs emit artifact bundle (metrics, diffs, decision logs).

## Current Agent Cluster Baseline (2026-02-11)
Observed in namespace `agents`:
- successful Torghut-oriented runs exist.
- failed runs also exist, indicating need for stronger contract checks and retry policy.
- controller and job infrastructure healthy at sampling time.

Implication:
- prioritize robust contracts and run validation over increasing run volume.

## Promotion Gates (Mandatory)
Gate 0: data freshness and schema parity.
Gate 1: offline robustness and statistical validity.
Gate 2: shadow/paper stability.
Gate 3: TCA and execution quality.
Gate 4: optional live-readiness review.

Hard stop triggers:
- config schema/type mismatch,
- drift between GitOps and runtime config,
- unresolved high-severity risk violations,
- LLM reliability below threshold when used in advisory path.

## Compliance and Control Anchors
- SEC 15c3-5 market access controls.
- MiFID II RTS 6 algorithmic trading controls.
- NIST AI RMF guidance for AI-assisted systems.

Implementation focus:
- pre-trade controls,
- kill switch behavior,
- replayable audit trails,
- controlled change management.

## LEAN + Qlib + RD-Agent in Governance
- LEAN:
  - benchmark consistency checks for promoted strategies.
- Qlib:
  - structured ML alpha research lane.
- RD-Agent:
  - decomposition of research tasks into reproducible sub-runs.

Control boundary:
- none of these tools can directly place production orders in Torghut runtime.
- all outputs pass through validation and promotion gates.

## Rollout Plan (90 Days)
Days 0-30:
- finalize feature contract + plugin SDK + baseline migration wrapper.
- add config schema CI and drift checks.
- define ImplementationSpecs for all v3 lanes.

Days 31-60:
- deploy strategy runtime + allocator + execution abstractions in paper.
- enable research ledger and gate evaluators.
- stand up TCA dashboards and alerting.

Days 61-90:
- run LEAN benchmark checks for promoted candidates.
- activate Qlib/RD-Agent research lane with bounded outputs.
- operationalize automated promotion PR pipeline with human approval gate.

## Runbook Requirements
Each gate must have:
- trigger conditions,
- execution commands,
- expected artifacts,
- rollback commands,
- escalation path.

Each incident must capture:
- root-cause classification,
- impacted symbols/strategies,
- rollback and recovery timeline,
- preventive action item linked to code/config PR.

## Definition of Done for v3 Governance
- >=3 strategy plugins active in paper with documented gate outcomes.
- promotion decisions reproducible from ledger artifacts.
- no uncontrolled startup failures from config type mismatch.
- autonomous runs operate with bounded contracts and auditable outputs.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-governance-rollout-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `torghutNamespace`
  - `agentsNamespace`
  - `gitopsPath`
- Expected execution:
  - create implementation specs for each gate/lane,
  - add validation scripts and policy checks,
  - create rollout checklist and incident templates,
  - open PRs for docs + policy automation.
- Expected artifacts:
  - gate checklists,
  - runbook docs,
  - policy scripts,
  - rollout status report.
- Exit criteria:
  - end-to-end dry run from research candidate to paper promotion PR succeeds,
  - rollback dry run succeeds,
  - audit trail complete for all gates.
