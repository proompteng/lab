# AI Market Fragility and Stability Controls

## Objective
Design stability controls for Torghut autonomous behavior under AI-driven market fragility conditions, including dynamic
liquidity stress responses and crowding-aware exposure limits.

## Why This Matters
Recent white papers show that AI can amplify market crowding and reduce resilience during stress. Torghut needs explicit
stability controls before scaling autonomous behavior.

## Proposed Torghut Design
- Add `FragilityMonitorV4` with indicators:
  - liquidity compression,
  - spread acceleration,
  - participation crowding proxies,
  - correlated strategy exposure.
- Add automatic stability mode:
  - reduce notional,
  - widen quote constraints,
  - increase abstain probability,
  - require stronger confidence for new entries.

## Owned Code and Config Areas
- `services/torghut/app/trading/risk.py`
- `services/torghut/app/trading/autonomy.py`
- `services/torghut/app/trading/execution.py`
- `argocd/applications/torghut/strategy-configmap.yaml`

## Deliverables
- Fragility indicator computation and monitoring dashboard.
- Stability-mode policy and parameterization.
- Automated alerts and circuit-breaker integration.
- Stress-playbook update with operator actions.

## Verification
- Simulated fragility scenarios trigger stability mode deterministically.
- Exposure and turnover reduce according to policy.
- No execution path bypasses stability clamps.

## Rollback
- Revert to static risk limits while preserving fragility telemetry.
- Keep alerts active for operator visibility.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v4-fragility-stability-controls-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `riskConfigPath`
  - `artifactPath`
- Expected artifacts:
  - fragility monitor implementation,
  - stability policy integration,
  - stress validation report.
- Exit criteria:
  - stability triggers validated,
  - risk constraints enforced,
  - rollback rehearsal complete.

## Research References
- BIS WP 1229 (AI liquidity fragility): https://www.bis.org/publ/work1229.htm
- NBER w33351 (AI asset pricing models): https://www.nber.org/papers/w33351
