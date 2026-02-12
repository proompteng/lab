# Torghut Design System v3: Flexible Quant Strategy Engine

## Status
- Version: `v3`
- Date: `2026-02-12`
- Maturity: `production handoff package`
- Primary scope: Torghut quant strategy engine modernization with AgentRun-ready implementation contracts.

## Purpose
This package translates Torghut quant research goals into implementation-grade designs that are directly executable by
human engineers or AgentRuns with minimal interpretation risk.

The package is explicitly grounded in:
- current source code in `services/torghut/`,
- current GitOps manifests in `argocd/applications/torghut/`,
- sampled cluster/runtime state on `2026-02-11` and `2026-02-12`,
- current open-source quant ecosystem evidence from maintainers/docs/repos.

## Audience
- Torghut trading service engineers.
- Dorvud/Flink data pipeline engineers.
- AgentRuns implementers.
- Oncall engineers operating paper/live gates.

## Non-Negotiable Safety Invariants
- Paper trading remains default. Live requires explicit audited enablement.
- Deterministic risk controls remain final authority.
- AI/LLM/agent layers are advisory unless explicitly gated for actuation.
- Same input + same config + same code version must reproduce same outcome.

## Handoff Readiness Standard
Every doc in this pack includes:
- objective and scope,
- current-state anchors,
- target design and interfaces,
- failure modes and observability,
- staged rollout/migration,
- AgentRun handoff bundle:
  - `ImplementationSpec` name,
  - `requiredKeys`,
  - execution steps,
  - expected artifacts,
  - exit criteria.

## Source-of-Truth Inputs
Code and configuration:
- `services/torghut/app/trading/scheduler.py`
- `services/torghut/app/trading/decisions.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/ingest.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/backtest.py`
- `services/torghut/app/trading/alpha/tsmom.py`
- `services/torghut/app/strategies/catalog.py`
- `services/torghut/app/models/entities.py`
- `docs/torghut/schemas/ta-signals.avsc`
- `argocd/applications/torghut/knative-service.yaml`
- `argocd/applications/torghut/ta/configmap.yaml`
- `argocd/applications/torghut/strategy-configmap.yaml`
- `docs/agents/agentrun-creation-guide.md`
- `docs/torghut/design-system/v1/agentruns-handoff.md`

Runtime/data snapshot commands executed on `2026-02-11` UTC:
- `kubectl get all -n torghut`
- `kubectl get ksvc -n torghut`
- `kubectl get flinkdeployment -n torghut`
- `kubectl get clickhouseinstallation -n torghut`
- `kubectl get cluster -n torghut`
- `kubectl logs -n torghut deploy/torghut-00059-deployment --all-containers --tail=120`
- `kubectl get configmap -n torghut torghut-strategy-config -o yaml`
- `kubectl cnpg psql -n torghut torghut-db -- -d torghut ...`
- `kubectl exec -n torghut chi-torghut-clickhouse-default-0-0-0 -- clickhouse-client ...`

Fast refresh workflow for subsequent analysis passes:
- `docs/agents/designs/jangar-torghut-live-analysis-playbook.md`

Quant control-plane reference:
- `docs/agents/designs/jangar-quant-performance-control-plane.md`

## Design Pack (12 Documents)
1. `index.md`
2. `current-state-baseline-2026-02-11.md`
3. `flexible-strategy-engine-architecture.md`
4. `strategy-sdk-and-plugin-contracts.md`
5. `oss-library-standard-and-selection.md`
6. `feature-contract-schema-and-data-plane.md`
7. `backtesting-walkforward-and-research-ledger.md`
8. `portfolio-risk-capacity-and-regime-allocation.md`
9. `execution-tca-and-broker-abstraction.md`
10. `jangar-bespoke-decision-endpoint-and-intraday-loop-design.md`
11. `jangar-market-intelligence-and-lean-integration-plan.md`
12. `autonomy-governance-and-rollout-plan.md`

## Full-Loop Autonomous Pack
For end-to-end autonomous operation (research -> strategy -> backtest -> paper -> live -> recovery), use:
- `docs/torghut/design-system/v3/full-loop/index.md`
- `docs/torghut/design-system/v3/full-loop/01-autonomous-pipeline-dag-spec.md`
- `docs/torghut/design-system/v3/full-loop/02-gate-policy-matrix.md`
- `docs/torghut/design-system/v3/full-loop/03-implementationspec-catalog.md`
- `docs/torghut/design-system/v3/full-loop/04-agentrun-orchestration-playbook.md`
- `docs/torghut/design-system/v3/full-loop/05-dataset-feature-versioning-spec.md`
- `docs/torghut/design-system/v3/full-loop/06-backtest-realism-standard.md`
- `docs/torghut/design-system/v3/full-loop/07-shadow-paper-evaluation-spec.md`
- `docs/torghut/design-system/v3/full-loop/08-live-rollout-capital-ramp-plan.md`
- `docs/torghut/design-system/v3/full-loop/09-incident-kill-switch-recovery-runbook.md`
- `docs/torghut/design-system/v3/full-loop/10-audit-compliance-evidence-spec.md`
- `docs/torghut/design-system/v3/full-loop/templates/implementationspecs.yaml`
- `docs/torghut/design-system/v3/full-loop/templates/agentruns.yaml`

## Operational Snapshot Package (Current-State Review)
- `docs/torghut/design-system/v3/current-state-snapshot-2026-02-12.md`
- `docs/torghut/design-system/v3/system-state-assessment-runbook.md`
- `docs/torghut/design-system/v3/system-state-snapshot-design.md`

Significant-scope standard for every design doc:
- At least 2 owned code/config areas.
- At least 3 concrete deliverables.
- Explicit verification and rollback/containment path.
- Runnable AgentRun handoff bundle with required keys and exit criteria.

## AgentRun Execution Conventions (Shared)
- Prefer `ImplementationSpec.spec.text`; do not set `AgentRun.spec.parameters.prompt` unless intentional override.
- Use `spec.ttlSecondsAfterFinished` at top-level `AgentRun.spec`.
- Use `codex/` head branch names for PR-producing runs.
- Keep `AgentRun.metadata.name` <= 63 chars.
- For design implementation runs, prefer single workflow step `implement`.
- GitOps-first for actuation: modify `argocd/applications/torghut/**` and let Argo reconcile.

## Standard AgentRun Skeleton (Reference)
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: torghut-v3-<lane>-<yyyymmdd>
  namespace: agents
  labels:
    torghut.proompteng.ai/purpose: implementation
spec:
  agentRef:
    name: codex-agent
  implementationSpecRef:
    name: <implementation-spec-name>
  runtime:
    type: workflow
  ttlSecondsAfterFinished: 7200
  vcsRef:
    name: <vcs-provider-name>
  vcsPolicy:
    required: true
    mode: read-write
  parameters:
    repository: proompteng/lab
    base: main
    head: codex/torghut-v3-<lane>-<yyyymmdd>
    designDoc: docs/torghut/design-system/v3/<doc>.md
    torghutNamespace: torghut
    gitopsPath: argocd/applications/torghut
  workflow:
    steps:
      - name: implement
        timeoutSeconds: 7200
```

## Delivery Waves
- Wave 1: feature contract + plugin SDK + legacy wrapper.
- Wave 2: strategy engine runtime + allocator + execution abstractions.
- Wave 3: backtesting ledger + promotion gates + TCA integration.
- Wave 4: autonomy/governance automation + LEAN/QLib/RD-Agent research lanes.

## Implementation Snapshot (2026-02-11)
Phase-1 and phase-2 foundations now implemented in `services/torghut/`:
- plugin runtime scaffolding (`app/trading/strategy_runtime.py`) with deterministic parameter and feature hashes,
- feature normalization boundary (`app/trading/features.py`) exposing `FeatureVectorV3` + parity hash metadata,
- autonomous gate matrix evaluator (`app/trading/autonomy.py`) with Gate 0-5 outputs and machine-readable contracts,
- end-to-end deterministic lane runner (`scripts/run_autonomous_lane.py`) producing research/backtest/gate artifacts and
  paper-candidate patch output.

Current safety posture:
- live remains gated by default (`TRADING_LIVE_ENABLED=false`, `allow_live_promotion=false`),
- deterministic risk/firewall remain final authority in runtime execution path,
- LLM path remains bounded/advisory and cannot bypass gate/risk controls.

Migration notes for next phases:
- promote `TRADING_STRATEGY_RUNTIME_MODE=plugin_v3` after paper shadow validation and parity checks,
- wire autonomous lane artifacts into AgentRun specs (`torghut-v3-backtest-robustness-v1` and
  `torghut-v3-gate-evaluation-v1`) for CI-enforced promotion flow,
- extend dataset/feature registry persistence and audit-pack exporters per full-loop docs 05 and 10.

## External References
- LEAN: <https://github.com/QuantConnect/Lean>
- Qlib: <https://github.com/microsoft/qlib>
- RD-Agent: <https://github.com/microsoft/RD-Agent>
- NautilusTrader: <https://github.com/nautechsystems/nautilus_trader>
- Vectorbt: <https://github.com/polakowo/vectorbt>
- Freqtrade: <https://github.com/freqtrade/freqtrade>
