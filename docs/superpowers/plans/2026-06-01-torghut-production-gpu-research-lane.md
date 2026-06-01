# Torghut Production GPU Research Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the RTX 5090 to accelerate Torghut candidate and sleeve discovery with RAPIDS/CuPy/Numba-CUDA where each library fits, while keeping promotion authority in exact replay, live-paper parity, runtime-ledger buckets, and post-cost proof.

**Architecture:** Split GPU research into explicit backend lanes with artifact lineage: CuPy/Numba-CUDA in the local Windows Python environment for numeric replay preview and custom kernels, RAPIDS/cuDF in a WSL2/Linux/container environment for dataframe-heavy tape/factor work, and PyTorch CUDA only for learned ranking. Every GPU artifact is advisory unless exact replay/live-paper/runtime-ledger gates prove it.

**Tech Stack:** Python 3.11-3.12, uv, CuPy `cupy-cuda12x`, Numba-CUDA `numba-cuda[cu12]`, RAPIDS/cuDF under WSL2/Linux/container, optional PyTorch CUDA ranker, Torghut replay tapes, ClickHouse TA tables, runtime-ledger proof packets.

---

## Authoritative Research Anchors

- RAPIDS install guide: `https://docs.rapids.ai/install/`
  - Current RAPIDS requires NVIDIA compute capability 7.0+.
  - Supported OS includes Linux glibc environments and Windows 11 through a WSL2-specific install.
  - RAPIDS pip packages require matching CUDA wheel suffixes such as `-cu12`; WSL2 pip setup requires Ubuntu WSL2, latest Windows NVIDIA drivers, and CUDA toolkit inside WSL2.
- CuPy install guide: `https://docs.cupy.dev/en/stable/install.html`
  - CUDA 12 wheels use `pip install cupy-cuda12x`.
  - Wheels are available for Linux and Windows.
  - CUDA Toolkit 12.0-12.9 is supported by current stable docs, with a compatible driver required.
- Numba-CUDA install guide: `https://nvidia.github.io/numba-cuda/user/installation.html`
  - CUDA 12 install uses `pip install numba-cuda[cu12]`.
  - Numba-CUDA uses NVIDIA CUDA Python bindings for Driver API access.
  - An up-to-date NVIDIA driver is required.

## Current Host Evidence

- Native Windows Torghut venv with `quant-gpu-research` extra:
  - `cupy`: available, version `13.6.0`, RTX 5090, compute capability `12.0`, after NVIDIA `cuda.pathfinder` NVRTC preload and a real `cupy.diff` smoke operation.
  - `numba-cuda`: available, version `0.65.1`, RTX 5090, compute capability `12.0`.
  - `torch-cuda`: available, `torch==2.11.0+cu128`, CUDA `12.8`, RTX 5090, compute capability `12.0`.
  - `rapids-cudf`: not installed in the native Windows venv. RAPIDS work belongs in WSL2/Linux/container.
- Current code status:
  - `services/torghut/app/trading/discovery/gpu_backends.py` defines backend probes and advisory artifact contracts.
  - `services/torghut/app/trading/discovery/fast_replay.py` supports preview scoring with `numpy`, `auto`, or explicit `cupy`.
  - `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py` exposes `--replay-tape-preview-array-backend`.
  - Generic `cuda` ranker alias is removed; the ranker backend is explicitly `torch-cuda`.

## Non-Negotiable Gates

- GPU research may narrow, rank, simulate, and propose sleeves.
- GPU research may not clear `simple_submit_disabled`, `alpha_readiness_not_promotion_eligible`, `runtime_ledger_source_collection_pending`, or any promotion gate.
- GPU artifacts must include backend name, version, CUDA runtime, device, compute capability, source query digest, replay tape digest, config hash, and `promotion_proof=false`.
- Exact replay, live-paper parity, runtime-ledger bucket closure, explicit costs, lineage, lifecycle closure, and TigerBeetle refs remain the promotion authority.
- Base Torghut service dependencies stay lean; GPU packages live behind optional extras or separate WSL2/container runtime.

## Files

- Modify: `services/torghut/pyproject.toml`
- Modify: `services/torghut/uv.lock`
- Create: `services/torghut/app/trading/discovery/gpu_backends.py`
- Create: `services/torghut/app/trading/discovery/tape_feature_extractors.py`
- Create: `services/torghut/app/trading/discovery/numba_replay_kernels.py`
- Create: `services/torghut/app/trading/discovery/sleeve_simulation_preview.py`
- Create: `services/torghut/app/trading/discovery/rapids_tape_features.py`
- Modify: `services/torghut/app/trading/discovery/fast_replay.py`
- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Create: `services/torghut/scripts/run_sleeve_simulation_preview.py`
- Create: `services/torghut/scripts/probe_quant_gpu_backends.py`
- Test: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`
- Test: `services/torghut/tests/test_quant_gpu_backends.py`
- Test: `services/torghut/tests/test_numba_replay_kernels.py`
- Test: `services/torghut/tests/test_sleeve_simulation_preview.py`
- Test: `services/torghut/tests/test_rapids_tape_features.py`
- Create: `docs/torghut/production-gpu-research-stack.md`
- Create: `docs/torghut/rapids-research-runtime.md`
- Save notes: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-production-gpu-research-lane.md`

### Task 1: Optional Quant GPU Extra

**Files:**

- Modify: `services/torghut/pyproject.toml`
- Modify: `services/torghut/uv.lock`
- Test: `services/torghut/tests/test_cuda_research_runtime_contract.py`

- [x] **Step 1: Add the optional dependency group**

Add this exact optional dependency group:

```toml
quant-gpu-research = [
  "cupy-cuda12x>=13.0,<14",
  "numba-cuda[cu12]>=0.16,<1",
]
```

- [x] **Step 2: Regenerate the lockfile with uv**

Run:

```powershell
cd services/torghut
uv add --optional quant-gpu-research "cupy-cuda12x>=13.0,<14" "numba-cuda[cu12]>=0.16,<1"
```

Expected: `uv.lock` includes CuPy, Numba-CUDA, CUDA Python bindings, and CUDA 12 component wheels.

- [x] **Step 3: Add a runtime-contract test**

Add assertions in `services/torghut/tests/test_cuda_research_runtime_contract.py`:

```python
    def test_quant_gpu_research_extra_uses_cupy_and_numba_cuda(self) -> None:
        pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
        payload = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
        optional_dependencies = cast(
            dict[str, list[str]], payload["project"]["optional-dependencies"]
        )

        self.assertEqual(
            optional_dependencies["quant-gpu-research"],
            [
                "cupy-cuda12x>=13.0,<14",
                "numba-cuda[cu12]>=0.16,<1",
            ],
        )
```

- [x] **Step 4: Run the contract test**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_cuda_research_runtime_contract.py -q
```

Expected: pass.

### Task 2: Backend Probe Contract

**Files:**

- Create: `services/torghut/app/trading/discovery/gpu_backends.py`
- Create: `services/torghut/tests/test_quant_gpu_backends.py`

- [x] **Step 1: Implement backend report dataclass**

Create `GpuResearchBackendReport` with fields:

```python
backend: str
available: bool
module: str
version: str | None
cuda_runtime: str | None
device_name: str | None
compute_capability: str | None
reason: str | None
```

The payload schema must be `torghut.gpu-research-backend-report.v1`.

- [x] **Step 2: Implement probes**

Implement probes for:

- `rapids-cudf` via `import cudf`
- `cupy` via Windows NVRTC preload with NVIDIA `cuda.pathfinder`, `cupy.cuda.runtime.getDeviceCount()`, device properties, and an actual CUDA array operation smoke test
- `numba-cuda` via `numba.cuda.is_available()` and current device
- `torch-cuda` via `torch.cuda`

- [x] **Step 3: Implement advisory artifact context**

Create `gpu_research_artifact_context()` returning:

```python
{
    "schema_version": "torghut.gpu-research-artifact-context.v1",
    "workload": workload,
    "requested_backend": requested_backend,
    "selected_backend": selected_backend,
    "promotion_proof": False,
    "blockers": [
        "gpu_research_preview_only",
        "exact_replay_required",
        "runtime_ledger_proof_required",
        "live_paper_parity_required",
    ],
    "source_query_digest": source_query_digest,
    "replay_tape_digest": replay_tape_digest,
    "config_hash": config_hash,
    "backend": dict(backend_report),
}
```

- [x] **Step 4: Add tests**

Create tests that patch `importlib.import_module` and verify:

- missing `cudf` returns `available=false` with reason `module_not_installed`
- missing `cupy` returns `available=false`
- missing `numba.cuda` returns `available=false`
- artifact context always has `promotion_proof=false` and exact replay/runtime-ledger/live-paper blockers

- [x] **Step 5: Run tests**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_quant_gpu_backends.py -q
```

Expected: pass.

### Task 3: Fast Replay CuPy Preview Lane

**Files:**

- Modify: `services/torghut/app/trading/discovery/fast_replay.py`
- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Test: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`

- [x] **Step 1: Add backend preference to preview scoring**

`build_fast_replay_preview()` accepts:

```python
array_backend_preference: str = "numpy"
```

Supported values:

- `numpy`: CPU reference backend
- `numpy-fallback`: CPU fallback
- `auto`: try CuPy, fall back to NumPy with reason recorded
- `cupy`: require CuPy and fail closed if unavailable

- [x] **Step 2: Use backend operations for vector sections**

Use backend `xp` for:

- `asarray`
- `diff`
- `abs`
- `mean`
- `percentile`
- `concatenate`

Keep scalar final scoring deterministic and payload-compatible.

- [x] **Step 3: Write backend metadata into preview manifest**

`FastReplayPreviewResult.to_manifest_payload()` includes `research_backend` from `gpu_research_artifact_context()`.

- [x] **Step 4: Add CLI option**

Add:

```python
parser.add_argument(
    "--replay-tape-preview-array-backend",
    default="numpy",
    choices=("numpy", "numpy-fallback", "auto", "cupy"),
    help=(
        "Array backend for preview-only replay tape narrowing. Explicit cupy "
        "requests fail closed when unavailable; auto may fall back to NumPy. "
        "This never counts as promotion proof."
    ),
)
```

- [x] **Step 5: Add tests**

Tests must prove:

- default preview manifest includes `research_backend.selected_backend == "numpy-fallback"`
- explicit `cupy` raises `fast_replay_preview_cupy_unavailable` when CuPy probe is patched unavailable
- `auto` falls back to NumPy and records `auto_fallback`
- CLI parser accepts `--replay-tape-preview-array-backend auto`

- [x] **Step 6: Run tests**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_run_whitepaper_autoresearch_profit_target.py -k "fast_replay_preview or runner_parse_args_covers_cli_defaults_and_flags" -q
```

Expected: pass.

### Task 4: Quant GPU Probe CLI

**Files:**

- Create: `services/torghut/scripts/probe_quant_gpu_backends.py`
- Test: `services/torghut/tests/test_quant_gpu_backends.py`

- [x] **Step 1: Add CLI script**

Create a script with:

```python
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json

from app.trading.discovery.gpu_backends import GPU_RESEARCH_BACKENDS, probe_gpu_research_backend


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe Torghut optional quant GPU research backends.")
    parser.add_argument("--backend", action="append", choices=GPU_RESEARCH_BACKENDS, default=[])
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    backends = tuple(args.backend or GPU_RESEARCH_BACKENDS)
    print(json.dumps([probe_gpu_research_backend(item).to_payload() for item in backends], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 2: Add CLI test**

Patch `probe_gpu_research_backend` and assert `main()` prints JSON with one report for a requested backend.

- [x] **Step 3: Run CLI locally**

Run:

```powershell
cd services/torghut
uv run --frozen --extra dev --extra cuda-research --extra quant-gpu-research python scripts/probe_quant_gpu_backends.py
```

Expected on this host:

- `cupy.available=true`
- `numba-cuda.available=true`
- `torch-cuda.available=true`
- `rapids-cudf.available=false` in native Windows venv

### Task 5: RAPIDS/cuDF Tape Feature Lane

**Files:**

- Create: `services/torghut/app/trading/discovery/rapids_tape_features.py`
- Create: `services/torghut/tests/test_rapids_tape_features.py`
- Create: `docs/torghut/rapids-research-runtime.md`

- [x] **Step 1: Define dataframe feature schema**

Create payload schema `torghut.rapids-tape-feature-panel.v1` with:

- dataset snapshot ref
- source query digest
- replay tape digest
- backend report
- symbol/day rows
- row count, trading day count
- feature names: `return_bps_mean`, `return_bps_std`, `spread_bps_p50`, `spread_bps_p95`, `ofi_mean`, `microprice_bias_bps_mean`, `volume_p50`

- [x] **Step 2: Implement CPU dataframe reference path**

Use pandas as a reference implementation so CI can validate logic without RAPIDS.

- [x] **Step 3: Implement RAPIDS path**

If `cudf` is available, read replay tape rows into cuDF and compute the same feature panel. If `cudf` is unavailable and backend is explicit `rapids-cudf`, fail closed with `rapids_cudf_unavailable`.

- [x] **Step 4: Add WSL2/container doc**

Document that RAPIDS is not targeted at native Windows Python and should run via WSL2 Ubuntu or a CUDA/RAPIDS container, matching official RAPIDS docs.

### Task 6: Numba-CUDA Sleeve Simulation Kernel

**Files:**

- Create: `services/torghut/app/trading/discovery/numba_replay_kernels.py`
- Create: `services/torghut/tests/test_numba_replay_kernels.py`

- [x] **Step 1: Add CPU reference simulator**

Implement a pure NumPy function for batched simple path simulation:

- input: price returns matrix `[paths, steps]`
- parameters: stop loss bps, take profit bps, trailing drawdown bps
- output: final PnL bps, max drawdown bps, hit stop/take flags

- [x] **Step 2: Add Numba-CUDA kernel**

Implement the same path logic in `numba.cuda.jit`. Explicit `numba-cuda` backend fails closed if unavailable. `auto` falls back to CPU reference with reason recorded.

- [x] **Step 3: Add CPU/GPU equivalence test**

For a fixed small fixture, assert exact or tolerance-bounded equality between CPU reference and GPU output when Numba-CUDA is available. If unavailable, assert the explicit backend raises and auto records fallback.

### Task 7: Candidate/Sleeve Discovery Execution

**Files:**

- Use existing `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Use generated replay tape artifacts under `tmp/`

- [x] **Step 1: Run selection with PyTorch ranker only as model lane**

Run:

```powershell
cd services/torghut
uv run --frozen --extra dev --extra cuda-research --extra quant-gpu-research python scripts/run_whitepaper_autoresearch_profit_target.py `
  --output-dir ..\..\tmp\torghut-gpu-selection-<timestamp> `
  --ranker-backend-preference torch-cuda `
  --selection-only
```

Expected: selection artifacts with `promotion_readiness.status=selection_only_not_promotion_proof`.

Observed on this host:

- Output dir: `tmp/torghut-gpu-selection-20260601T054302Z`
- Status: `selection_only`
- Proposal model backend: `torch-cuda`
- Candidate specs compiled/scored: `14680`
- Selected candidates: `24`
- Promotion readiness: `selection_only_not_promotion_proof`
- Blockers preserved: `real_replay_not_run`, `portfolio_optimizer_not_run`, `runtime_ledger_proof_missing`, `live_paper_parity_missing`

- [x] **Step 2: Run replay preview with CuPy**

After a manifest-verified replay tape exists, run:

```powershell
uv run --frozen --extra dev --extra quant-gpu-research python scripts/run_whitepaper_autoresearch_profit_target.py `
  --output-dir ..\..\tmp\torghut-gpu-cupy-preview-<timestamp> `
  --candidate-specs <selected-candidate-specs.jsonl> `
  --replay-mode real `
  --replay-tape-path <replay-tape.jsonl> `
  --replay-tape-manifest <replay-tape.jsonl.manifest.json> `
  --replay-tape-preview-top-k 24 `
  --replay-tape-preview-array-backend cupy `
  --selection-only
```

Expected: `replay-tape-preview-manifest.json` records selected backend `cupy`, device RTX 5090, and `promotion_proof=false`.

Observed on this host:

- Replay tape: `tmp/torghut-gpu-replay-tape-20260601T055007Z/replay-tape.jsonl`
- Replay tape digest: `fe2a7ead4d0b331eaebd990013f53f4287c8deabbc1aea2f8259e99d0545b43d`
- Replay tape status: valid preview tape, `24397` rows, 4 trading days, symbols `AAPL,AMD,AMZN,AVGO,GOOGL,INTC,NVDA,ORCL`
- Output dir: `tmp/torghut-gpu-cupy-preview-20260601T055800Z`
- Preview manifest: `tmp/torghut-gpu-cupy-preview-20260601T055800Z/replay-tape-preview-manifest.json`
- Selected backend: `cupy`, version `13.6.0`, CUDA runtime `12090`, device `NVIDIA GeForce RTX 5090`, compute capability `12.0`
- Preview-selected candidate specs: `24`
- Promotion proof: `false`
- Blockers preserved: `preview_only_not_promotion_proof`, `exact_replay_required`, `runtime_ledger_proof_required`, `live_paper_parity_required`

- [ ] **Step 3: Run strict exact replay**

After TA signal coverage reaches the required proof window, run strict real replay with selected specs. Expected success requires exact replay, portfolio optimizer, and runtime-closure artifacts; failure reasons must be preserved and not bypassed.

Current blocker evidence:

- Native Windows could not resolve the in-cluster ClickHouse DNS name, so replay-tape materialization must use the existing `kubectl://admin%40ryzen/torghut/chi-torghut-clickhouse-default-0-0-0` bridge.
- Strict latest-complete preflight for 2026-05-01 through 2026-05-31 failed with `latest_complete_replay_window_missing:min_days=5`.
- Rows exist for 2026-05-26 through 2026-05-29, but strict executable row/quote-validity coverage is below promotion policy. The four-day raw-signal tape is acceptable for CuPy preview only, not exact replay proof.
- Follow-up implementation: run-scoped replay-tape materialization now uses the
  selected candidate-spec union as its effective symbol set instead of requiring
  the whole chip universe whenever selected candidate specs are present. The
  receipt records `requested_symbols`, `effective_symbols`, and
  `effective_symbol_source`.
- Follow-up probe: single-symbol `NVDA` strict latest-complete preflight for
  2026-05-01 through 2026-05-31 still failed with
  `latest_complete_replay_window_missing:min_days=5`. Later May dates have raw
  rows, but executable quote-backed rows are only hundreds per day and have
  gaps above the 120-second strict policy, so the blocker is source executable
  quote coverage, not just an overly broad symbol universe.
- Calendar fix: replay-tape manifests and materialization coverage diagnostics
  now use a shared US equities full-day holiday calendar, so 2026-05-25
  Memorial Day is not requested as a missing strict replay day. This removes a
  false coverage blocker while preserving exact replay strictness for real
  trading sessions.

- [x] **Step 4: Run Numba-CUDA sleeve simulation preview**

Run:

```powershell
uv run --frozen --extra dev --extra quant-gpu-research python scripts/run_sleeve_simulation_preview.py `
  --candidate-specs ..\..\tmp\torghut-gpu-cupy-preview-20260601T055800Z\selected-candidate-specs.jsonl `
  --replay-tape-path ..\..\tmp\torghut-gpu-replay-tape-20260601T055007Z\replay-tape.jsonl `
  --replay-tape-manifest ..\..\tmp\torghut-gpu-replay-tape-20260601T055007Z\replay-tape.jsonl.manifest.json `
  --preview-scores ..\..\tmp\torghut-gpu-cupy-preview-20260601T055800Z\replay-tape-preview-scores.jsonl `
  --output-dir ..\..\tmp\torghut-gpu-sleeve-simulation-20260601T061100Z `
  --backend numba-cuda `
  --top-k 24
```

Observed on this host:

- Output dir: `tmp/torghut-gpu-sleeve-simulation-20260601T061100Z`
- Manifest: `tmp/torghut-gpu-sleeve-simulation-20260601T061100Z/sleeve-simulation-preview-manifest.json`
- Rows: `tmp/torghut-gpu-sleeve-simulation-20260601T061100Z/sleeve-simulation-preview-rows.jsonl`
- Selected backend: `numba-cuda`, device `NVIDIA GeForce RTX 5090`, compute capability `12.0`
- Input candidate specs: `24`
- Preview-selected candidate specs: `24`
- Replay tape digest: `fe2a7ead4d0b331eaebd990013f53f4287c8deabbc1aea2f8259e99d0545b43d`
- Promotion proof: `false`
- Blockers preserved: `sleeve_simulation_preview_only`, `exact_replay_required`, `runtime_ledger_proof_required`, `live_paper_parity_required`

- [x] **Step 5: Wire sleeve simulation into the main autoresearch runner**

`scripts/run_whitepaper_autoresearch_profit_target.py` now supports an explicit,
disabled-by-default sleeve preview stage:

```powershell
--sleeve-simulation-preview-top-k <n>
--sleeve-simulation-preview-backend cpu|numpy|auto|numba-cuda
--sleeve-simulation-preview-min-returns-per-path <n>
```

The stage runs after optional CuPy replay-tape preview, writes
`sleeve-simulation-preview-manifest.json` and
`sleeve-simulation-preview-rows.jsonl`, annotates
`candidate-selection-manifest.json`, and may narrow replay candidates. It still
requires `--replay-mode real`, `--replay-tape-path`, and the full-window dates.
It fails closed if it cannot select any candidate. It never clears promotion
gates.

Observed integrated advisory pass on this host:

```powershell
uv run --frozen --extra dev --extra cuda-research --extra quant-gpu-research python scripts/run_whitepaper_autoresearch_profit_target.py `
  --output-dir ..\..\tmp\torghut-gpu-integrated-preview-20260601T064500Z `
  --candidate-specs ..\..\tmp\torghut-gpu-cupy-preview-20260601T055800Z\selected-candidate-specs.jsonl `
  --replay-mode real `
  --full-window-start-date 2026-05-26 `
  --full-window-end-date 2026-05-29 `
  --replay-tape-path ..\..\tmp\torghut-gpu-replay-tape-20260601T055007Z\replay-tape.jsonl `
  --replay-tape-manifest ..\..\tmp\torghut-gpu-replay-tape-20260601T055007Z\replay-tape.jsonl.manifest.json `
  --replay-tape-preview-top-k 24 `
  --replay-tape-preview-array-backend cupy `
  --sleeve-simulation-preview-top-k 24 `
  --sleeve-simulation-preview-backend numba-cuda `
  --selection-only `
  --no-persist-results
```

Observed result:

- Output dir: `tmp/torghut-gpu-integrated-preview-20260601T064500Z`
- CuPy preview selected backend: `cupy`
- Sleeve simulation selected backend: `numba-cuda`
- Replay tape digest: `fe2a7ead4d0b331eaebd990013f53f4287c8deabbc1aea2f8259e99d0545b43d`
- Input candidate specs: `24`
- Replay candidate specs after GPU advisory stages: `24`
- Promotion readiness: `selection_only_not_promotion_proof`
- Promotion proof: `false`

### Task 8: Verification

**Files:** all touched Torghut Python files and docs.

- [x] **Step 1: Targeted tests**

Run:

```powershell
cd services/torghut
uv run --frozen --extra dev --extra quant-gpu-research pytest tests/test_sleeve_simulation_preview.py tests/test_rapids_tape_features.py tests/test_numba_replay_kernels.py tests/test_cuda_research_runtime_contract.py tests/test_quant_gpu_backends.py tests/test_run_whitepaper_autoresearch_profit_target.py -k "sleeve_simulation or rapids_tape or fast_replay_preview or quant_gpu or cuda_research_runtime_contract or runner_parse_args_covers_cli_defaults_and_flags or numba_replay or cpu_reference or auto_falls_back or explicit_numba_cuda or cupy_probe" -q
```

Expected: `22 passed, 170 deselected`; sleeve simulation preview tests write manifest/rows and preserve `promotion_proof=false`; RAPIDS tape feature tests pass with pandas reference, explicit RAPIDS fail-closed, auto fallback, and fake-cuDF path coverage; CuPy probe tests require NVRTC preload/runtime operation validation; Numba-CUDA equivalence executes on this host with an expected low-occupancy warning for the tiny fixture.

- [x] **Step 2: Ruff**

Run:

```powershell
uv run --frozen ruff check app/trading/discovery/gpu_backends.py app/trading/discovery/tape_feature_extractors.py app/trading/discovery/fast_replay.py app/trading/discovery/numba_replay_kernels.py app/trading/discovery/sleeve_simulation_preview.py app/trading/discovery/rapids_tape_features.py scripts/run_whitepaper_autoresearch_profit_target.py scripts/probe_quant_gpu_backends.py scripts/run_sleeve_simulation_preview.py tests/test_quant_gpu_backends.py tests/test_numba_replay_kernels.py tests/test_sleeve_simulation_preview.py tests/test_rapids_tape_features.py tests/test_run_whitepaper_autoresearch_profit_target.py tests/test_cuda_research_runtime_contract.py
```

Expected: pass.

- [x] **Step 3: Pyright profiles**

Run:

```powershell
uv sync --frozen --extra dev
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
uv sync --frozen --extra dev --extra cuda-research --extra quant-gpu-research
```

Expected: all pyright profiles pass; optional GPU extras restored afterward.

- [x] **Step 4: Post-restore GPU probe and diff hygiene**

Run:

```powershell
uv run --frozen --extra dev --extra cuda-research --extra quant-gpu-research python scripts/probe_quant_gpu_backends.py --backend cupy --backend numba-cuda
uv run --frozen --extra dev --extra quant-gpu-research pytest tests/test_numba_replay_kernels.py -q
git diff --check
```

Expected: `rapids-cudf` is unavailable in the native Windows venv; CuPy, Numba-CUDA, and torch-cuda see `NVIDIA GeForce RTX 5090`; sleeve-kernel tests pass; `git diff --check` has no whitespace errors.

### Task 9: Notes and Memory

**Files:**

- Create: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-production-gpu-research-lane.md`

- [x] **Step 1: Save Obsidian note**

Record:

- official docs used
- host probe output
- files changed
- tests run
- current incomplete items
- proof gates still blocking profitability

- [x] **Step 2: Save memories-service entry**

Run:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" run --filter memories save-memory --task-name torghut-production-gpu-research-lane --content "<summary>" --summary "<short summary>" --tags torghut,cuda,rapids,cupy,numba,profit-proof
```

Expected: saved memory id.

## Self-Review

- Spec coverage: plan covers RAPIDS, CuPy, Numba-CUDA, PyTorch ranker demotion, candidate/sleeve discovery, promotion boundaries, optional dependencies, host probing, tests, docs, and notes.
- Placeholder scan: no placeholder markers or vague “add tests” steps remain; each test step names exact behavior.
- Type consistency: backend names are `rapids-cudf`, `cupy`, `numba-cuda`, and `torch-cuda`; fast replay array backend names are `numpy`, `numpy-fallback`, `auto`, and `cupy`.
