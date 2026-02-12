# Torghut v3 Full-Loop Autonomous Quant System (LLM Integrated)

## Status
- Version: `v3-full-loop`
- Date: `2026-02-11`
- Audience: Torghut engineers, AgentRun implementers, oncall operators, quant research owners.

## Objective
Define a production-grade autonomous loop for Torghut:
- research and hypothesis generation,
- strategy implementation,
- backtesting and statistical validation,
- shadow and paper evaluation,
- controlled live rollout,
- continuous monitoring and autonomous rollback.

LLM integration is included as a bounded subsystem for reasoning, review, and orchestration. Deterministic risk and
execution controls remain final authority.

## Full Loop Pipeline
1. `Research Intake`
2. `Candidate Build`
3. `Backtest + Robustness`
4. `Gate Evaluation`
5. `Shadow/Paper Deployment`
6. `Live Ramp`
7. `Continuous Governance and Recovery`

## Scope Matrix (Agent Implementation Size)

| Doc | Epic size | Minimum implementation scope |
| --- | --- | --- |
| `01-autonomous-pipeline-dag-spec.md` | Large | pipeline orchestration config + stage validators + CI DAG tests |
| `02-gate-policy-matrix.md` | Large | gate evaluator engine + policy config + machine-readable reports |
| `03-implementationspec-catalog.md` | Medium | versioned specs + contract tests + manifest inventory |
| `04-agentrun-orchestration-playbook.md` | Large | runner scheduling/retry/idempotency playbooks + templates |
| `05-dataset-feature-versioning-spec.md` | Large | dataset snapshot/version registry + parity checks + migrations |
| `06-backtest-realism-standard.md` | Large | cost/fill realism modules + scenario stress suite + validation CLI |
| `07-shadow-paper-evaluation-spec.md` | Large | champion-challenger wiring + telemetry dashboards + promotion reports |
| `08-live-rollout-capital-ramp-plan.md` | Large | staged rollout configs + approval hooks + auto-rollback scripts |
| `09-incident-kill-switch-recovery-runbook.md` | Medium | runbooks + executable incident scripts + recovery verification |
| `10-audit-compliance-evidence-spec.md` | Medium | evidence package schema + retention policy + audit exporter |

Definition of "significant scope" for this pack:
- touches at least 2 code/config areas,
- produces at least 3 concrete artifacts,
- includes automated verification and rollback path.

## Document Set
1. `01-autonomous-pipeline-dag-spec.md`
2. `02-gate-policy-matrix.md`
3. `03-implementationspec-catalog.md`
4. `04-agentrun-orchestration-playbook.md`
5. `05-dataset-feature-versioning-spec.md`
6. `06-backtest-realism-standard.md`
7. `07-shadow-paper-evaluation-spec.md`
8. `08-live-rollout-capital-ramp-plan.md`
9. `09-incident-kill-switch-recovery-runbook.md`
10. `10-audit-compliance-evidence-spec.md`
11. `11-phase1-phase2-implementation-notes-2026-02-11.md`

## Templates
- `templates/implementationspecs.yaml`
- `templates/agentruns.yaml`
- `templates/orchestration-policy.yaml`
- `templates/orchestration-observability.yaml`

## Cross-References
- Core v3 architecture: `docs/torghut/design-system/v3/flexible-strategy-engine-architecture.md`
- Core v3 governance: `docs/torghut/design-system/v3/autonomy-governance-and-rollout-plan.md`
- AgentRun conventions: `docs/agents/agentrun-creation-guide.md`
- Torghut AgentRun handoff baseline: `docs/torghut/design-system/v1/agentruns-handoff.md`

## Definition of Complete Autonomous Loop
- Every promotion is evidence-backed and reproducible.
- Every autonomous action is bounded by deterministic controls.
- Every stage is runnable by AgentRun from an ImplementationSpec.
- Every failure path has automated containment and recovery runbook support.
