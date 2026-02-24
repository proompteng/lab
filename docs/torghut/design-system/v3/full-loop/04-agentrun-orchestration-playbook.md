# 04. AgentRun Orchestration Playbook

## Objective

Define how agents execute the autonomous quant loop reliably: scheduling, retries, idempotency, lane ownership, and
failure containment.

## Orchestration Model

- Hub-and-spoke orchestration with one coordinator and multiple lane workers.
- Coordinator owns stage transitions and gate pass/fail decisions.
- Worker lanes own isolated file/config surfaces.

## Lane Definitions

- Lane A: research artifacts and candidate specs.
- Lane B: strategy/plugin implementation and tests.
- Lane C: backtesting/robustness execution.
- Lane D: gate evaluation and report generation.
- Lane E: GitOps rollout and runtime verification.
- Lane F: incident and audit evidence workflows.

## Execution Semantics

- One active stage per candidate ID.
- Stage transition requires previous stage artifact + gate result.
- Every run has deterministic `run_id` and `candidate_id`.
- Every mutable action is GitOps-first unless incident path explicitly demands emergency mode.
- Deterministic risk and execution controls remain final authority on all stage advances.

## Retry and Failure Policy

- transient failure classes: retry with exponential backoff and max retry cap.
- deterministic/spec failures: no retry; return actionable error.
- repeated failures on same stage: candidate auto-paused for human review.

Reference policy artifact:

- `docs/torghut/design-system/v3/full-loop/templates/orchestration-policy.yaml`

## Idempotency Requirements

- all stage runs must be idempotent by `candidate_id + stage + run_id`.
- duplicate stage submissions produce no duplicate promotions.
- execution-related stages must preserve broker/order idempotency invariants.

## Agent Naming and Branching

- AgentRun names <= 63 chars.
- branch names use `codex/torghut-v3-<lane>-<date>-<runid>`.
- never reuse active branch across concurrent runs.

## Observability

Track:

- stage duration,
- retry counts,
- fail class distribution,
- stage queue depth,
- handoff latency between lanes.

Reference observability artifact:

- `docs/torghut/design-system/v3/full-loop/templates/orchestration-observability.yaml`

## Implemented Artifacts

### Stage Orchestration Templates

- `docs/torghut/design-system/v3/full-loop/templates/agentruns.yaml`
  - reusable lane/stage AgentRun templates:
    - lane-a `research-intake`
    - lane-b `candidate-build`
    - lane-c `backtest-robustness`
    - lane-d `gate-evaluation`
    - lane-e `shadow-paper`, `live-ramp`
    - lane-f `incident-recovery`, `audit-evidence`

### Stage Transition Guard CLI

- `services/torghut/scripts/orchestration_guard.py`
  - `check-transition` enforces:
    - legal `from_stage -> to_stage` edges,
    - active-stage ownership per candidate,
    - run ownership per candidate (`state.runId` must match requested `run_id`),
    - previous artifact + gate requirements,
    - deterministic risk/execution controls as final authority,
    - GitOps-first mutable actions with ticketed emergency override.
  - `evaluate-failure` enforces:
    - transient retry with exponential backoff,
    - deterministic/spec/policy no-retry handling,
    - auto-pause thresholds for repeated failures.

Example transition check:

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py check-transition \
  --state artifacts/orchestration/candidate-state.json \
  --candidate-id cand-abc123 \
  --run-id run-abc123 \
  --from-stage gate-evaluation \
  --to-stage shadow-paper \
  --previous-artifact artifacts/gates/cand-abc123/report.json \
  --previous-gate-passed \
  --risk-controls-passed \
  --execution-controls-passed \
  --mode gitops
```

Example failure evaluation:

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py evaluate-failure \
  --state artifacts/orchestration/candidate-state.json \
  --stage candidate-build \
  --failure-class transient \
  --attempt 2
```

## Agent Implementation Scope (Significant)

Workstream A: orchestration manifests

- create reusable AgentRun templates per lane and stage.

Workstream B: coordinator logic

- implement stage scheduler and transition guard scripts.

Workstream C: failure governance

- implement retry policy and incident escalation wiring.

Workstream D: observability

- add orchestration metrics and dashboards.

Owned areas:

- `docs/torghut/design-system/v3/full-loop/templates/**`
- `services/torghut/scripts/**`
- `docs/agents/**`

Minimum deliverables:

- stage orchestration template set,
- transition guard CLI,
- retry policy definitions,
- orchestration monitoring dashboard spec.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-orchestration-playbook-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `candidateId`
  - `runId`
  - `stage`
  - `artifactPath`
- Exit criteria:
  - end-to-end orchestration dry run succeeds,
  - idempotency behavior validated,
  - failure retries and escalation verified.
