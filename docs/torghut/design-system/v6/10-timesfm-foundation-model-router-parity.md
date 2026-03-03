# TimesFM Foundation Model Router Parity

## Status

- Doc: `v6/10`
- Date: `2026-03-01`
- Maturity: `production design`
- Scope: add TimesFM-family adapter and parity controls to Torghut foundation-model routing
- Implementation status: `Planned`
- Evidence:
  - `docs/torghut/design-system/v6/10-timesfm-foundation-model-router-parity.md` (design-level contract)
- Rollout gap: current design corpus and runtime references Chronos-family routing, but does not define a TimesFM production contract and parity gate.

## Objective

Introduce TimesFM as an additional foundation-model family in forecast routing with strict calibration, contamination-safe evaluation, and deterministic fallback.

## Non-Negotiable Rules

1. deterministic baseline remains available and authoritative fallback.
2. no TimesFM-routed forecast can bypass uncertainty or policy gates.
3. all routed decisions must persist model lineage and calibration evidence.
4. promotion requires candidate-vs-baseline parity by symbol, horizon, and regime.

## Router Design Extension

Current routed set:

- deterministic baseline,
- Chronos-family adapter.

Target routed set:

- deterministic baseline,
- Chronos-family adapter,
- TimesFM adapter.

Routing policy must evaluate:

1. expected forecast quality score,
2. calibration score,
3. latency budget compatibility,
4. recent drift penalty.

## Canonical Routing Artifact

`<artifact_path>/router/foundation-router-parity-report-v1.json`

Required fields:

- `schema_version` = `foundation-router-parity-report-v1`
- `candidate_id`
- `router_policy_version`
- `adapters`
  - `deterministic`
  - `chronos`
  - `timesfm`
- `slice_metrics`
  - `by_symbol`
  - `by_horizon`
  - `by_regime`
- `calibration_metrics`
- `latency_metrics`
- `fallback_metrics`
- `overall_status` (`pass|fail`)

## Calibration and Gate Requirements

Per-adapter required checks:

1. observed coverage error within policy tolerance.
2. interval width within configured budget for horizon class.
3. drift score below threshold.
4. fallback rate below threshold.

If any check fails:

- route is downgraded to deterministic baseline for affected slices,
- promotion is blocked until parity is restored.

## Data and Evaluation Standard

1. forward-only windows with purge and embargo.
2. split manifests persisted for every run.
3. explicit leakage checks for all feature and context sources.
4. cross-regime evaluation required before promotion recommendation.

## Owned Code and Config Areas

- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `argocd/applications/torghut/strategy-configmap.yaml`
- `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml`

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v6-timesfm-router-parity-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `routerPolicyPath`
  - `evaluationWindow`
  - `calibrationPolicyRef`
- Expected artifacts:
  - TimesFM adapter and route wiring patch,
  - parity report by symbol/horizon/regime,
  - gate policy update for adapter-specific fail-close handling.
- Exit criteria:
  - deterministic fallback verified for TimesFM failure paths,
  - parity report generated and enforced in promotion checks,
  - route lineage fields visible in runtime decisions.

## Verification Plan

1. Unit tests for route scoring and fallback precedence.
2. Integration tests for adapter failure, timeout, and schema mismatch paths.
3. Replay tests comparing deterministic, Chronos, and TimesFM outcomes.
4. Gate regression tests for promotion block on calibration drift.

## Rollback

1. disable TimesFM route eligibility through config policy switch,
2. preserve shadow logging for diagnostics,
3. keep deterministic and Chronos paths active.

## Research References

- TimesFM: https://arxiv.org/abs/2310.10688
- Chronos: https://arxiv.org/abs/2403.07815
