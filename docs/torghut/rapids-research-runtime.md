# Torghut RAPIDS Research Runtime

This runtime is for dataframe-heavy research over manifest-verified replay tapes.
It can accelerate candidate narrowing and sleeve discovery, but it is not
promotion proof.

## Runtime Boundary

- Native Windows Torghut uses the pandas reference path for deterministic tests.
- RAPIDS/cuDF should run in a Linux CUDA environment: WSL2 Ubuntu on this host or
  a CUDA/RAPIDS container on Linux.
- GPU dataframe outputs must carry `promotion_proof=false` and the same backend
  artifact context used by other GPU research lanes.
- Exact replay, live-paper parity, runtime-ledger bucket closure, post-cost PnL,
  lifecycle closure, and TigerBeetle refs remain the authority for promotion.

## Official Anchors

- RAPIDS install docs: https://docs.rapids.ai/install/
- cuDF documentation: https://docs.rapids.ai/api/cudf/stable/
- cuDF groupby docs: https://docs.rapids.ai/api/cudf/stable/user_guide/groupby/

The relevant constraints from the official docs are:

- Windows support is via Windows 11 with WSL2 Ubuntu, not native Windows Python.
- WSL2 requires WSL2, a recent Windows NVIDIA driver, and a matching CUDA toolkit
  inside WSL2.
- RAPIDS pip packages require a CUDA-specific wheel suffix such as `-cu12`.
- cuDF supports grouping, mean/std, quantile aggregation, and group shift, which
  are enough for the Torghut tape feature panel.

## Feature Panel

The code path is `services/torghut/app/trading/discovery/rapids_tape_features.py`.

Payload schema:

- panel: `torghut.rapids-tape-feature-panel.v1`
- row: `torghut.rapids-tape-feature-row.v1`

Feature rows are grouped by `symbol` and `trading_day` and include:

- `return_bps_mean`
- `return_bps_std`
- `spread_bps_p50`
- `spread_bps_p95`
- `ofi_mean`
- `microprice_bias_bps_mean`
- `volume_p50`

Backend choices:

- `pandas`: CPU reference path.
- `auto`: tries `rapids-cudf`; if unavailable, records `auto_fallback:*` and uses
  pandas.
- `rapids-cudf`: explicit RAPIDS path; fails closed with
  `rapids_cudf_unavailable:*` or `rapids_cudf_execution_failed:*`.

## Local Validation

Native Windows validation should use:

```powershell
cd services/torghut
uv run --frozen --extra dev pytest tests/test_rapids_tape_features.py -q
```

RAPIDS runtime validation should happen inside WSL2/Linux/container after a
matching RAPIDS install:

```powershell
cd services/torghut
uv run --frozen --extra dev pytest tests/test_rapids_tape_features.py -q
python - <<'PY'
from app.trading.discovery.gpu_backends import probe_gpu_research_backend
print(probe_gpu_research_backend("rapids-cudf").to_payload())
PY
```

The explicit `rapids-cudf` backend is not expected to pass in the native Windows
venv unless `cudf` is importable there.
