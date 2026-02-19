# Profitability Evidence Standard and Benchmark Suite

## Objective
Define a strict profitability evidence protocol for Torghut autonomous upgrades so no technique is promoted without
comparable, reproducible, and risk-adjusted evidence.

## Why This Matters
New techniques can overfit quickly in finance. A standardized benchmark and evidence format is required to compare
foundation models, LLM workflows, and execution policies fairly.

## Proposed Torghut Design
- Create `ProfitabilityEvidenceV4` contract that requires:
  - risk-adjusted returns (Sharpe, Sortino, drawdown, tail risk),
  - capacity and turnover metrics,
  - cost-aware slippage and fill realism,
  - confidence intervals and calibration stats,
  - reproducibility hashes (data, code, config).
- Add benchmark suites by horizon and regime bucket.
- Require evidence package artifacts before gate progression.

## Owned Code and Config Areas
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/scripts/run_autonomous_lane.py`
- `docs/torghut/design-system/v3/full-loop/10-audit-compliance-evidence-spec.md`
- `docs/torghut/design-system/v3/full-loop/13-research-ledger-promotion-evidence-spec.md`

## Deliverables
- Evidence schema and validation CLI.
- Benchmark runner for baseline vs candidate comparisons.
- Promotion gate integration with machine-readable pass/fail reasons.
- Operator-facing report templates for investment committee review.

## Verification
- Same run inputs produce bitwise-identical evidence bundles.
- Promotion gate blocks when evidence is incomplete or under threshold.
- Benchmark drift alerts fire when baseline quality degrades.

## Rollback
- Freeze promotions and revert to last known-good candidate.
- Continue benchmark collection for diagnosis.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v4-profitability-evidence-benchmark-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `gateConfigPath`
- Expected artifacts:
  - evidence contract + validator,
  - benchmark suite outputs,
  - gate integration patch.
- Exit criteria:
  - validator enforced in CI and AgentRuns,
  - at least one candidate benchmarked end-to-end,
  - promotion decisions fully auditable.

## Research References
- FinTMMBench: https://arxiv.org/abs/2503.05185
- TradingAgents: https://arxiv.org/abs/2412.20138
- QuantAgent: https://arxiv.org/abs/2509.09995
- NBER w33351: https://www.nber.org/papers/w33351
