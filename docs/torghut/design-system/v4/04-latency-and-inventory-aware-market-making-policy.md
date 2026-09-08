# Latency and Inventory-Aware Market-Making Policy

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Objective

Design a latency-aware, inventory-constrained market-making policy layer for Torghut that can operate safely in paper
mode and later support bounded live canaries.

## Why This Matters

Recent RL market-making work explicitly models latency and inventory risk, showing better stability than naive quoting
policies under realistic delays and adverse selection.

## Proposed Torghut Design

- Add `QuotingPolicyV4` with state inputs:
  - inventory skew,
  - latency estimates,
  - spread/depth state,
  - fill hazard estimates.
- Policy outputs quote width/size under hard deterministic risk clamps.
- Add a controlled exploration budget for paper-only learning.

## Owned Code and Config Areas

- `services/torghut/app/trading/decisions.py`
- `services/torghut/app/trading/execution.py`
- `services/torghut/app/trading/autonomy.py`
- `argocd/applications/torghut/knative-service.yaml`

## Deliverables

- Policy module with latency/inventory feature interfaces.
- Deterministic clamp layer integrated with risk gates.
- Paper-mode replay and shadow telemetry dashboards.
- Canary rollout checklist and rollback automation.

## Verification

- Inventory excursions stay inside configured limits.
- Adverse selection and realized spread metrics improve vs baseline.
- Kill-switch and clamp precedence validated under stress.

## Rollback

- Disable policy output influence and route to baseline execution policy.
- Preserve telemetry path for postmortem.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-latency-inventory-mm-policy-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `torghutNamespace`
  - `riskPolicyPath`
- Expected artifacts:
  - policy module,
  - clamp/risk integration,
  - paper canary report.
- Exit criteria:
  - paper-mode stability achieved,
  - risk clamp behavior proven,
  - rollback path rehearsed.

## Research References

- Resolving latency + inventory risk with RL: https://arxiv.org/abs/2505.12465
- Multi-agent RL market making: https://arxiv.org/abs/2510.25929
- Market Making without Regret: https://arxiv.org/abs/2411.13993
