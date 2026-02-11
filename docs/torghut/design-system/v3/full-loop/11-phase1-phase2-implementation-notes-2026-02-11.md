# 11. Phase 1/2 Implementation Notes (2026-02-11)

## Scope delivered in this implementation
- Pluggable strategy runtime scaffolding under `services/torghut/app/trading/autonomy/runtime.py`.
- Feature contract normalization boundary (`FeatureVectorV3`) in `services/torghut/app/trading/features.py`.
- Gate policy matrix evaluator (`services/torghut/app/trading/autonomy/gates.py`) with machine-readable reports.
- Deterministic autonomous lane (`services/torghut/app/trading/autonomy/lane.py` + `services/torghut/scripts/run_autonomous_lane.py`) that produces:
  - research candidate spec,
  - backtest/walk-forward artifacts,
  - gate evaluation artifact,
  - paper candidate GitOps patch.
- GitOps-first runtime control plane config (`argocd/applications/torghut/autonomous-configmap.yaml`).

## Safety invariants preserved
- `gate5_live_enabled` defaults to `false` in all shipped policy configs.
- `promotion_target=live` fails closed without explicit policy enablement and approval token.
- Lane output is advisory and patch-based; no direct live actuation path is enabled.
- Existing deterministic risk/firewall controls remain unchanged and authoritative.

## Migration notes for next phases
1. Integrate `StrategyRuntime` into `services/torghut/app/trading/scheduler.py` behind a feature flag, while preserving legacy fallback.
2. Extend runtime strategy persistence contract (`strategy_type`, `version`, `params`, `feature_requirements`) with DB migrations.
3. Wire gate evaluator outputs into CI/AgentRun lane promotion automation.
4. Add dataset/feature registry tables and parity jobs from v3 full-loop docs 05/06.
5. Add incident and audit artifact exporters for docs 09/10 and bind them to gate failures.
