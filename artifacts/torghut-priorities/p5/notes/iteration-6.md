# Iteration 6 — Microstructure-aware execution intelligence

## Scope

- Add microstructure-state driven policy hooks in execution pathways.
- Integrate calibration and TCA evidence into execution policy and gating outputs.
- Add tests for fallback safety and slippage/shortfall decision behavior.

## Changes

- `services/torghut/app/trading/tca.py`
  - Added deterministic absolute-metric TCA payload fields (`slippage_bps_abs`, `shortfall_notional_abs`, `divergence_bps_abs`, `realized_shortfall_bps_abs`) to gate inputs and TCA summaries.
  - Updated exposure checks to use absolute metric variants first with signed fallback.
  - Added helper `_abs_decimal` for safe decimal normalization.

- `services/torghut/app/trading/autonomy/lane.py`
  - Included absolute TCA metrics in fallback payloads used when lane evaluation degrades.

- `services/torghut/app/trading/autonomy/gates.py`
  - Added a microstructure-aware shortfall/slippage gate fallback path for missing symbols and deterministic mismatch handling.

- `services/torghut/app/trading/execution_policy.py`
  - Threaded microstructure evidence fields through execution policy output payloads for deterministic gating.

- `services/torghut/app/metrics.py`
  - Exported `tca` absolute aggregate gauges for new absolute-metric observations.

- `services/torghut/tests/test_tca_adaptive_policy.py`
  - Added `build_tca_gate_inputs` regression ensuring absolute TCA metrics are used for exposure.

- `services/torghut/tests/test_autonomy_gates.py`
  - Added regression proving microstructure symbol mismatch does not block adaptive policy.

- `services/torghut/tests/test_execution_policy.py`
  - Added policy-level slippage/shortfall assertions around microstructure-safe fallback behavior.

- `services/torghut/tests/test_metrics.py`
  - Expanded TCA metric export assertions to cover absolute metrics.

## Verification

- `ruff format` on touched Torghut files.
- `ruff check` on touched Torghut files.
- `pyright --project pyrightconfig.json` (service-level venv).
- `pyright --project pyrightconfig.alpha.json` (service-level venv).
- `pyright --project pyrightconfig.scripts.json` (service-level venv).
- `python -m pytest tests/test_tca_adaptive_policy.py tests/test_autonomy_gates.py tests/test_execution_policy.py tests/test_metrics.py -q`.
