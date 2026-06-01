# Torghut Production GPU Research Stack

## Current State

The implemented local CUDA paths are advisory research lanes:

- `torch-cuda`: learned-ranker candidate selection.
- `cupy`: manifest-verified replay-tape preview scoring with an actual CUDA
  runtime/NVRTC smoke operation before the backend is marked available.
- `numba-cuda`: CPU/GPU-equivalent sleeve path simulation kernel.
- `rapids-cudf`: dataframe tape-feature implementation with pandas reference
  tests; native Windows records `module_not_installed`, so production RAPIDS
  execution belongs in WSL2/Linux/container.

Do not describe any of these as generic CUDA. Each backend name must be explicit
in artifacts and CLI options.

## Production Stack

Use explicit backends by workload:

- `rapids-cudf`: dataframe-heavy tape ingestion, ClickHouse exports, joins,
  group-bys, rolling factor panels, symbol/day aggregations, and feature
  matrices. Run this in Linux/WSL2/container GPU environments, not native
  Windows Python.
- `cupy`: NumPy-shaped vector math, covariance/correlation matrices, dense
  Monte Carlo arrays, portfolio risk matrices, and fast numerical transforms.
- `numba-cuda`: custom path-dependent kernels for order-book replay,
  fill-probability simulation, queue-position survival, market-impact stress,
  and parameter sweeps where CuPy vectorization is awkward.
- `torch-cuda`: learned proposal/ranker models only, after the replay and
  feature pipeline already emits GPU-ready tensors or artifacts.

## First Ports

1. Port fast replay preview feature extraction in
   `app/trading/discovery/fast_replay.py` to a backend contract that can run
   CPU NumPy, CuPy, or cuDF/Numba-CUDA.
2. Add a GPU tape-feature builder that consumes manifest-verified replay tapes
   or ClickHouse exports and writes backend/version/source-digest metadata.
3. Move parameter sweeps for candidate sleeves into batched CuPy/Numba-CUDA
   kernels, with CPU equivalence tests on deterministic fixtures. Current
   implementation writes preview-only sleeve simulation artifacts through
   `scripts/run_sleeve_simulation_preview.py` and through the optional
   `--sleeve-simulation-preview-*` stage in
   `scripts/run_whitepaper_autoresearch_profit_target.py`.
4. Add portfolio covariance/risk/concentration acceleration with CuPy, keeping
   the existing deterministic optimizer as the authority until equivalence and
   replay evidence pass.

## Evidence Contract

Every GPU artifact must record:

- backend name and package versions
- CUDA runtime/toolkit as observed by the backend
- device name and compute capability when available
- source query digest and replay tape digest
- seed/config/kernel hash
- CPU equivalence test reference
- `promotion_proof=false` unless exact replay, live-paper parity,
  runtime-ledger buckets, post-cost PnL, lifecycle closure, and TigerBeetle refs
  are all present

Current advisory artifact families:

- `torghut.fast-replay-preview.v1`: CuPy/NumPy replay-tape candidate narrowing.
- `torghut.sleeve-simulation-preview-panel.v1`: Numba-CUDA/CPU sleeve path
  simulation over manifest-verified replay-tape returns. This can now run as a
  repeatable stage in the main autoresearch runner after CuPy replay preview.
- `torghut.rapids-tape-feature-panel.v1`: RAPIDS/cuDF or pandas tape-feature
  panel for symbol/day factor work.

## Environment Contract

Native Windows is acceptable for the current `torch-cuda`, `cupy`, and
`numba-cuda` research lanes. On Windows, the CuPy probe preloads NVRTC through
NVIDIA `cuda.pathfinder` and then runs a real CuPy array operation before
reporting availability. The production RAPIDS lane should run under WSL2,
Docker, or a Linux GPU node because RAPIDS documents Windows via WSL2-specific
installs. CuPy can be tested on native Windows or Linux, but production research
should prefer the same Linux/container path as RAPIDS so tape, dataframe, and
custom kernel workloads share one runtime.

## Anti-Goals

- Do not put GPU work on the live order path.
- Do not use GPU preview scores as promotion proof.
- Do not add a broad dependency stack to the base Torghut service image.
- Do not merge GPU dependencies without a measured bottleneck, CPU equivalence
  test, and artifact lineage.
