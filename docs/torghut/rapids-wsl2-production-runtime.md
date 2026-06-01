# Torghut RAPIDS WSL2 Production Runtime

## Purpose

This runtime runs dataframe-heavy Torghut research over manifest-verified replay
tapes using RAPIDS/cuDF inside WSL2 Ubuntu. It accelerates candidate narrowing,
tape feature panels, cross-sectional factor work, and sleeve research. It does
not authorize promotion.

## Host Contract

- Windows host GPU: RTX 5090, driver 595.97, compute capability 12.0.
- WSL distro: Ubuntu 24.04.3 LTS, WSL version 2.
- RAPIDS target: 26.04.
- Preferred CUDA package lane: `cu13`, because driver 595.97 satisfies RAPIDS
  26.04 CUDA 13 driver requirements.
- Fallback CUDA package lane: `cu12`, only if the CUDA 13 RAPIDS install fails
  validation.
- Docker path: secondary. Docker is not installed on this host today.

## Storage Contract

- Keep repo clone, `.venv-rapids`, parquet panels, and large JSONL replay tapes
  under WSL ext4 paths such as `~/github.com/lab` and
  `~/torghut-rapids-artifacts`.
- Do not run high-volume RAPIDS jobs from `/mnt/c`.

## Current Status

- WSL2 Ubuntu sees the RTX 5090 through `nvidia-smi`.
- Python 3.12.3 is available inside WSL2.
- `~/github.com/lab` exists inside WSL2.
- `.venv-rapids` is not created yet.
- `cudf`, `dask_cudf`, `cuml`, and `cugraph` are not importable yet.
- Non-interactive sudo is unavailable, so apt/CUDA toolkit bootstrap requires an
  interactive sudo step.

## Promotion Contract

Every RAPIDS artifact must set `promotion_proof=false` and preserve blockers:

- `rapids_research_preview_only`
- `exact_replay_required`
- `runtime_ledger_proof_required`
- `live_paper_parity_required`

Exact replay and runtime-ledger proof remain the authority.

## Bootstrap

Run from PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'mkdir -p ~/github.com && cd ~/github.com && test -d lab || git clone https://github.com/proompteng/lab.git lab'
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && bash scripts/bootstrap_rapids_wsl2.sh'
```

Run only from WSL ext4. Do not bootstrap under `/mnt/c`.

The bootstrap path is intentionally native WSL2 first:

1. Install WSL CUDA toolkit packages only; do not install a Linux NVIDIA display
   driver inside WSL2.
2. Create `services/torghut/.venv-rapids`.
3. Install `requirements/rapids-wsl2-cu13.txt` from the NVIDIA PyPI index.
4. Install Torghut dev dependencies into the same WSL venv.
5. Run the runtime checker before any research job.

## Runtime Check

Run from PowerShell after bootstrap:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/check_rapids_wsl2_runtime.py'
```

Expected result:

- `cudf` is importable.
- `nvidia-smi` reports the RTX 5090.
- The process exits with status 0.

## Tape Feature Smoke

Copy or materialize a manifest-verified tape under WSL ext4, then run:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/run_rapids_tape_feature_panel.py --backend rapids-cudf --replay-tape-path ~/torghut-rapids-artifacts/input/replay-tape.jsonl --replay-tape-manifest ~/torghut-rapids-artifacts/input/replay-tape.jsonl.manifest.json --output ~/torghut-rapids-artifacts/rapids-tape-feature-panel.json --rows-output ~/torghut-rapids-artifacts/rapids-tape-feature-rows.jsonl'
```

Acceptance checks:

- `promotion_proof` is `false`.
- `research_backend.selected_backend` is `rapids-cudf`.
- `research_backend.backend.device_name` identifies the RTX 5090.

Run the pandas reference on the same tape:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/run_rapids_tape_feature_panel.py --backend pandas --replay-tape-path ~/torghut-rapids-artifacts/input/replay-tape.jsonl --replay-tape-manifest ~/torghut-rapids-artifacts/input/replay-tape.jsonl.manifest.json --output ~/torghut-rapids-artifacts/pandas-tape-feature-panel.json --rows-output ~/torghut-rapids-artifacts/pandas-tape-feature-rows.jsonl'
```

The RAPIDS panel is usable only if the RAPIDS and pandas outputs agree on replay
tape digest, source query digest, symbol/day groups, row counts, and feature
names.

## Autoresearch Integration

After the panel passes the smoke checks, pass it into candidate selection:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/run_whitepaper_autoresearch_profit_target.py --rapids-tape-feature-panel ~/torghut-rapids-artifacts/rapids-tape-feature-panel.json --rapids-tape-feature-rows ~/torghut-rapids-artifacts/rapids-tape-feature-rows.jsonl'
```

The runner must attach the RAPIDS artifact as advisory context only. It must not
clear exact replay, live-paper parity, runtime-ledger, lifecycle, or TigerBeetle
promotion requirements.

## Research Anchors

- RAPIDS platform support:
  https://docs.rapids.ai/platform-support/
- RAPIDS install guide:
  https://docs.rapids.ai/install/
- NVIDIA CUDA on WSL:
  https://developer.nvidia.com/cuda/wsl
- NVIDIA CUDA on WSL user guide:
  https://docs.nvidia.com/cuda/wsl-user-guide/contents.html
