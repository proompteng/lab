# Torghut RAPIDS WSL2 Production Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible WSL2 RAPIDS runtime for Torghut dataframe-heavy candidate and sleeve research, with cuDF artifacts feeding advisory discovery only and never bypassing exact replay, live-paper parity, or runtime-ledger promotion authority.

**Architecture:** Keep native Windows as the CuPy/Numba-CUDA local kernel lane and make WSL2 Ubuntu the RAPIDS/cuDF dataframe lane. The WSL2 runtime owns RAPIDS installation, large tape feature generation, and benchmark artifacts on the WSL ext4 filesystem; the Torghut runner consumes only manifest-verified JSON/JSONL artifacts with `promotion_proof=false`.

**Tech Stack:** Windows 11 host, WSL2 Ubuntu 24.04, RTX 5090 driver 595.97, RAPIDS 26.04, CUDA 13 or CUDA 12 RAPIDS wheels, uv, Python 3.12, cuDF, Dask-cuDF, optional cuML/cuGraph, Torghut replay tapes, ClickHouse-derived coverage receipts.

---

## Authoritative Research Anchors

- RAPIDS platform support: https://docs.rapids.ai/platform-support/
  - RAPIDS 26.04 supports Linux glibc environments and Windows through WSL with a compatible Linux distribution.
  - RAPIDS 26.04 supports Python 3.11-3.14.
  - RAPIDS 26.04 supports CUDA 13 with driver 580+ and Blackwell compute capability 100/120 or newer.
  - RAPIDS 26.04 also supports CUDA 12.2-12.9 with driver 535+.
- RAPIDS install guide: https://docs.rapids.ai/install/
  - WSL2 path requires Windows 11, WSL2 Ubuntu, current Windows NVIDIA driver, and package suffix matching the installed CUDA toolkit.
  - WSL2 limitations: single GPU and no GPU Direct Storage.
  - Docker WSL2 path is valid, but Docker is not installed on this host today.
- NVIDIA CUDA on WSL: https://developer.nvidia.com/cuda/wsl and https://docs.nvidia.com/cuda/wsl-user-guide/contents.html
  - The Windows NVIDIA driver exposes CUDA into WSL2.
  - Do not install a Linux NVIDIA display driver inside WSL2.
- Docker Desktop GPU support: https://docs.docker.com/desktop/features/gpu/
  - Docker Desktop GPU support on Windows requires the WSL2 backend.

## Current Host Evidence

- `wsl.exe -l -v`: `Ubuntu` exists and is WSL version 2.
- `wsl.exe --status`: default distribution is `Ubuntu`; default version is 2.
- `wsl.exe -d Ubuntu -- cat /etc/os-release`: Ubuntu 24.04.3 LTS.
- `wsl.exe -d Ubuntu -- nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader`: `NVIDIA GeForce RTX 5090, 595.97, 32607 MiB, 12.0`.
- `wsl.exe -d Ubuntu -- python3 --version`: Python 3.12.3.
- `docker`: not installed on the Windows host.

## Current Blocker State

- `~/github.com/lab` exists inside Ubuntu WSL2 on branch `main`.
- `services/torghut/.venv-rapids` does not exist inside WSL2 yet.
- `cudf`, `dask_cudf`, `cuml`, and `cugraph` are not installed inside WSL2 yet.
- `sudo -n true` reports non-interactive sudo is unavailable, so this Codex
  session cannot finish the apt/CUDA toolkit bootstrap without an interactive
  sudo step from the user.

## Production Execution Plan From Here

1. Use native WSL2 Ubuntu as the primary RAPIDS runtime. Do not attempt native
   Windows RAPIDS installs. The Windows host only supplies the NVIDIA display
   driver and WSL CUDA device bridge.
2. Install only the WSL-safe CUDA toolkit package inside Ubuntu, never the Linux
   display driver or broad `cuda`/`cuda-drivers` metapackages.
3. Create a dedicated `services/torghut/.venv-rapids` under WSL ext4 and install
   RAPIDS 26.04 `cu13` wheels from the NVIDIA PyPI index.
4. Run `scripts/check_rapids_wsl2_runtime.py`; do not proceed until it reports
   `cudf` importable and `nvidia-smi` sees the RTX 5090.
5. Copy or materialize only manifest-verified replay tapes to
   `~/torghut-rapids-artifacts/input` on WSL ext4.
6. Run `scripts/run_rapids_tape_feature_panel.py --backend rapids-cudf` and a
   pandas reference run on the same tape.
7. Compare row counts, feature keys, replay-tape digest, source query digest, and
   candidate-selection refs. Differences block use of the RAPIDS panel.
8. Feed validated RAPIDS panel refs into
   `scripts/run_whitepaper_autoresearch_profit_target.py` with
   `--rapids-tape-feature-panel` and `--rapids-tape-feature-rows`.
9. Keep all RAPIDS artifacts advisory: `promotion_proof=false`; exact replay,
   live-paper parity, and runtime-ledger profit proof remain required.

## Candidate And Sleeve Research Workload Map

- `cuDF`: first-class lane for replay tape feature panels, cross-sectional
  symbol/day factors, joins between tape rows and selected candidate specs,
  coverage diagnostics, and feature-matrix construction.
- `Dask-cuDF`: use only after single-GPU cuDF validation, for out-of-core panels
  or multi-symbol/month grids that exceed RTX 5090 memory. WSL2 RAPIDS currently
  supports only one GPU, so Dask is for partitioning and memory pressure, not
  multi-GPU scaling on this host.
- `cuML`: second-stage lane after feature panels are reproducible; use for
  clustering regimes, PCA/factor compression, random forests, and ranker
  experiments that produce candidate priors only.
- `cuGraph`: optional relationship lane for symbol/strategy co-movement,
  candidate overlap, and risk concentration graphs. It must not become a
  promotion gate.
- `CuPy` and `Numba-CUDA`: keep for dense vector math and path-dependent sleeve
  simulation kernels. RAPIDS does not replace them.

## Acceptance Gates

- WSL2 runtime check exits 0 and records RAPIDS/cuDF version plus RTX 5090
  device metadata.
- RAPIDS feature panel and pandas reference panel agree on row count, symbol/day
  groups, feature names, replay tape digest, and source query digest.
- Autoresearch candidate-selection manifest includes the RAPIDS ref with
  `promotion_proof=false` and blockers:
  `rapids_research_preview_only`, `exact_replay_required`,
  `runtime_ledger_proof_required`, and `live_paper_parity_required`.
- No RAPIDS code path writes live promotion state or marks a candidate
  promotion-ready.
- Native Windows tests and all three Torghut Pyright profiles pass after repo
  changes, followed by restoring optional GPU extras.

## Non-Negotiable Boundaries

- RAPIDS/cuDF is a research accelerator, not a promotion authority.
- RAPIDS outputs must include backend name, RAPIDS/cuDF version, device metadata, replay tape digest, source query digest, config hash, and `promotion_proof=false`.
- The WSL2 runtime must never write directly into live strategy promotion state.
- Exact replay, live-paper parity, runtime-ledger buckets, costs, lifecycle closure, and TigerBeetle refs remain the only promotion path.
- Large replay tapes and parquet panels must live on the WSL ext4 filesystem, not `/mnt/c`, to avoid WSL filesystem overhead.

## Files

- Create: `docs/torghut/rapids-wsl2-production-runtime.md`
- Create: `services/torghut/requirements/rapids-wsl2-cu13.txt`
- Create: `services/torghut/scripts/bootstrap_rapids_wsl2.sh`
- Create: `services/torghut/scripts/check_rapids_wsl2_runtime.py`
- Create: `services/torghut/scripts/run_rapids_tape_feature_panel.py`
- Modify: `services/torghut/app/trading/discovery/rapids_tape_features.py`
- Modify: `services/torghut/app/trading/discovery/gpu_backends.py`
- Test: `services/torghut/tests/test_rapids_tape_features.py`
- Test: `services/torghut/tests/test_quant_gpu_backends.py`
- Test: `services/torghut/tests/test_run_rapids_tape_feature_panel.py`
- Save notes: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-rapids-wsl2-production-runtime.md`

### Task 1: WSL2 Runtime Contract

**Files:**
- Create: `docs/torghut/rapids-wsl2-production-runtime.md`
- Create: `services/torghut/scripts/check_rapids_wsl2_runtime.py`
- Test: `services/torghut/tests/test_quant_gpu_backends.py`

- [x] **Step 1: Add the runtime contract doc**

Create `docs/torghut/rapids-wsl2-production-runtime.md` with these sections:

```markdown
# Torghut RAPIDS WSL2 Production Runtime

## Purpose

This runtime runs dataframe-heavy Torghut research over manifest-verified replay tapes using RAPIDS/cuDF inside WSL2 Ubuntu. It accelerates candidate narrowing, tape feature panels, cross-sectional factor work, and sleeve research. It does not authorize promotion.

## Host Contract

- Windows host GPU: RTX 5090, driver 595.97, compute capability 12.0.
- WSL distro: Ubuntu 24.04.3 LTS, WSL version 2.
- RAPIDS target: 26.04.
- Preferred CUDA package lane: `cu13`, because driver 595.97 satisfies RAPIDS 26.04 CUDA 13 driver requirements.
- Fallback CUDA package lane: `cu12`, only if the CUDA 13 RAPIDS install fails validation.
- Docker path: secondary. Docker is not installed on this host today.

## Storage Contract

- Keep repo clone, `.venv-rapids`, parquet panels, and large JSONL replay tapes under WSL ext4 paths such as `~/github.com/lab` and `~/torghut-rapids-artifacts`.
- Do not run high-volume RAPIDS jobs from `/mnt/c`.

## Promotion Contract

Every RAPIDS artifact must set `promotion_proof=false` and preserve blockers:

- `rapids_research_preview_only`
- `exact_replay_required`
- `runtime_ledger_proof_required`
- `live_paper_parity_required`

Exact replay and runtime-ledger proof remain the authority.
```

- [x] **Step 2: Add WSL2 runtime checker**

Create `services/torghut/scripts/check_rapids_wsl2_runtime.py`:

```python
#!/usr/bin/env python3
from __future__ import annotations

import json
import platform
import subprocess
from importlib import import_module
from typing import Any


def _run(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def _module_version(name: str) -> str | None:
    try:
        module = import_module(name)
    except Exception:
        return None
    return str(getattr(module, "__version__", "") or "unknown")


def main() -> int:
    payload = {
        "schema_version": "torghut.rapids-wsl2-runtime-check.v1",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "nvidia_smi": _run(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version,memory.total,compute_cap",
                "--format=csv,noheader",
            ]
        ),
        "modules": {
            "cudf": _module_version("cudf"),
            "dask_cudf": _module_version("dask_cudf"),
            "cuml": _module_version("cuml"),
            "cugraph": _module_version("cugraph"),
        },
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["modules"]["cudf"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 3: Add backend probe coverage**

Extend `services/torghut/tests/test_quant_gpu_backends.py` to assert `probe_gpu_research_backend("rapids-cudf")` includes schema `torghut.gpu-research-backend-report.v1`, module `cudf`, and a non-secret failure reason when `cudf` is not installed.

- [x] **Step 4: Run tests**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_quant_gpu_backends.py -q
```

Expected: pass.

### Task 2: Native WSL2 RAPIDS Bootstrap

**Files:**
- Create: `services/torghut/requirements/rapids-wsl2-cu13.txt`
- Create: `services/torghut/scripts/bootstrap_rapids_wsl2.sh`
- Modify: `docs/torghut/rapids-wsl2-production-runtime.md`

- [x] **Step 1: Add RAPIDS requirement file**

Create `services/torghut/requirements/rapids-wsl2-cu13.txt`:

```text
--extra-index-url https://pypi.nvidia.com
cudf-cu13==26.4.*
dask-cudf-cu13==26.4.*
rmm-cu13==26.4.*
cuml-cu13==26.4.*
cugraph-cu13==26.4.*
```

- [x] **Step 2: Add bootstrap script**

Create `services/torghut/scripts/bootstrap_rapids_wsl2.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if ! grep -qi microsoft /proc/version; then
  echo "not_running_under_wsl2" >&2
  exit 2
fi

if ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia_smi_unavailable_inside_wsl2" >&2
  exit 2
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  git \
  python3.12 \
  python3.12-venv \
  python3-pip \
  wget

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
fi

mkdir -p "${HOME}/torghut-rapids-artifacts"

if ! dpkg -s cuda-keyring >/dev/null 2>&1; then
  tmp_deb="$(mktemp --suffix=.deb)"
  wget -O "${tmp_deb}" \
    https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
  sudo dpkg -i "${tmp_deb}"
  rm -f "${tmp_deb}"
fi

sudo apt-get update
if apt-cache show cuda-toolkit-13-0 >/dev/null 2>&1; then
  sudo apt-get install -y cuda-toolkit-13-0
elif apt-cache show cuda-toolkit-13-1 >/dev/null 2>&1; then
  sudo apt-get install -y cuda-toolkit-13-1
else
  echo "cuda_toolkit_13_package_missing" >&2
  exit 2
fi

uv venv --python 3.12 .venv-rapids
source .venv-rapids/bin/activate
uv pip install --upgrade pip
uv pip install -r requirements/rapids-wsl2-cu13.txt
uv pip install -e ".[dev]"

python scripts/check_rapids_wsl2_runtime.py
python - <<'PY'
import cudf
print(cudf.Series([1, 2, 3]))
PY
```

- [x] **Step 3: Document the bootstrap command**

Add to `docs/torghut/rapids-wsl2-production-runtime.md`:

```markdown
## Bootstrap

Run from PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'mkdir -p ~/github.com && cd ~/github.com && test -d lab || git clone https://github.com/proompteng/lab.git lab'
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && bash scripts/bootstrap_rapids_wsl2.sh'
```

Run only from WSL ext4. Do not bootstrap under `/mnt/c`.
```

- [x] **Step 4: Validate bootstrap script syntax**

Run:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/c/Users/gkonu/.codex/worktrees/f49d/lab/services/torghut && bash -n scripts/bootstrap_rapids_wsl2.sh'
```

Expected: exit code 0.

### Task 3: RAPIDS Tape Feature CLI

**Files:**
- Create: `services/torghut/scripts/run_rapids_tape_feature_panel.py`
- Test: `services/torghut/tests/test_run_rapids_tape_feature_panel.py`

- [x] **Step 1: Add failing CLI test**

Create `services/torghut/tests/test_run_rapids_tape_feature_panel.py`:

```python
from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts import run_rapids_tape_feature_panel as cli


class TestRapidsTapeFeaturePanelCli(TestCase):
    def test_main_writes_panel_and_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "panel.json"
            rows = root / "rows.jsonl"
            panel = {
                "schema_version": "torghut.rapids-tape-feature-panel.v1",
                "promotion_proof": False,
                "rows": [
                    {
                        "schema_version": "torghut.rapids-tape-feature-row.v1",
                        "symbol": "NVDA",
                        "trading_day": "2026-05-29",
                    }
                ],
            }
            with (
                patch.object(
                    cli,
                    "_parse_args",
                    return_value=Namespace(
                        replay_tape_path=root / "tape.jsonl",
                        replay_tape_manifest=root / "tape.manifest.json",
                        output=output,
                        rows_output=rows,
                        backend="rapids-cudf",
                    ),
                ),
                patch.object(cli, "load_replay_tape", return_value=Namespace(rows=(), manifest=Namespace())),
                patch.object(
                    cli,
                    "build_rapids_tape_feature_panel",
                    return_value=Namespace(to_payload=lambda: panel),
                ),
            ):
                self.assertEqual(cli.main(), 0)

            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["promotion_proof"], False)
            self.assertEqual(len(rows.read_text(encoding="utf-8").splitlines()), 1)
```

- [x] **Step 2: Add CLI implementation**

Create `services/torghut/scripts/run_rapids_tape_feature_panel.py`:

```python
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.trading.discovery.rapids_tape_features import build_rapids_tape_feature_panel
from app.trading.discovery.replay_tape import load_replay_tape


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a RAPIDS/cuDF or pandas tape feature panel from a manifest-verified replay tape."
    )
    parser.add_argument("--replay-tape-path", type=Path, required=True)
    parser.add_argument("--replay-tape-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows-output", type=Path, required=True)
    parser.add_argument(
        "--backend",
        choices=("pandas", "auto", "rapids-cudf"),
        default="rapids-cudf",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    tape = load_replay_tape(args.replay_tape_path, manifest_path=args.replay_tape_manifest)
    panel = build_rapids_tape_feature_panel(
        rows=tape.rows,
        replay_tape_manifest=tape.manifest,
        backend_preference=args.backend,
    )
    payload = panel.to_payload()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.rows_output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    row_payloads = payload.get("rows")
    rows = row_payloads if isinstance(row_payloads, list) else []
    args.rows_output.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 3: Run CLI test**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_run_rapids_tape_feature_panel.py -q
```

Expected: pass.

### Task 4: WSL2 RAPIDS Smoke and Benchmark

**Files:**
- Modify: `docs/torghut/rapids-wsl2-production-runtime.md`
- Use: `services/torghut/scripts/run_rapids_tape_feature_panel.py`

- [ ] **Step 1: Copy or materialize a replay tape into WSL ext4**

Run from PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'mkdir -p ~/torghut-rapids-artifacts/input'
wsl.exe -d Ubuntu -- bash -lc 'cp /mnt/c/Users/gkonu/.codex/worktrees/f49d/lab/tmp/torghut-gpu-replay-tape-20260601T055007Z/replay-tape.jsonl ~/torghut-rapids-artifacts/input/replay-tape.jsonl'
wsl.exe -d Ubuntu -- bash -lc 'cp /mnt/c/Users/gkonu/.codex/worktrees/f49d/lab/tmp/torghut-gpu-replay-tape-20260601T055007Z/replay-tape.jsonl.manifest.json ~/torghut-rapids-artifacts/input/replay-tape.jsonl.manifest.json'
```

Expected: both files exist under `~/torghut-rapids-artifacts/input`.

- [ ] **Step 2: Run explicit RAPIDS feature panel**

Run from PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/run_rapids_tape_feature_panel.py --backend rapids-cudf --replay-tape-path ~/torghut-rapids-artifacts/input/replay-tape.jsonl --replay-tape-manifest ~/torghut-rapids-artifacts/input/replay-tape.jsonl.manifest.json --output ~/torghut-rapids-artifacts/rapids-tape-feature-panel.json --rows-output ~/torghut-rapids-artifacts/rapids-tape-feature-rows.jsonl'
```

Expected:

- `rapids-tape-feature-panel.json` exists.
- `promotion_proof` is `false`.
- `research_backend.selected_backend` is `rapids-cudf`.
- `research_backend.backend.device_name` contains `RTX 5090`.

- [ ] **Step 3: Compare pandas reference path**

Run:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/run_rapids_tape_feature_panel.py --backend pandas --replay-tape-path ~/torghut-rapids-artifacts/input/replay-tape.jsonl --replay-tape-manifest ~/torghut-rapids-artifacts/input/replay-tape.jsonl.manifest.json --output ~/torghut-rapids-artifacts/pandas-tape-feature-panel.json --rows-output ~/torghut-rapids-artifacts/pandas-tape-feature-rows.jsonl'
```

Expected: row count and feature keys match the RAPIDS output for the same replay tape.

### Task 5: Autoresearch Artifact Integration

**Files:**
- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Test: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`

- [x] **Step 1: Add CLI flags**

Add flags:

```python
parser.add_argument("--rapids-tape-feature-panel", type=Path, default=None)
parser.add_argument("--rapids-tape-feature-rows", type=Path, default=None)
```

- [x] **Step 2: Attach RAPIDS artifact refs to candidate selection**

After candidate selection is built, add:

```python
rapids_panel_path = getattr(args, "rapids_tape_feature_panel", None)
rapids_rows_path = getattr(args, "rapids_tape_feature_rows", None)
if rapids_panel_path is not None:
    candidate_selection = {
        **candidate_selection,
        "rapids_tape_feature_panel": {
            "schema_version": "torghut.rapids-tape-feature-panel-ref.v1",
            "panel_path": str(rapids_panel_path),
            "rows_path": str(rapids_rows_path or ""),
            "promotion_proof": False,
            "blockers": [
                "rapids_research_preview_only",
                "exact_replay_required",
                "runtime_ledger_proof_required",
                "live_paper_parity_required",
            ],
        },
    }
```

- [x] **Step 3: Add test**

In `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`, add a test that passes both flags and asserts `candidate-selection-manifest.json` includes `rapids_tape_feature_panel.promotion_proof == False` and the exact blockers above.

- [x] **Step 4: Run focused tests**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_run_whitepaper_autoresearch_profit_target.py -k "rapids_tape_feature_panel or runner_parse_args_covers_cli_defaults_and_flags" -q
```

Expected: pass.

### Task 6: Full Validation Matrix

**Files:**
- Modify: `docs/torghut/rapids-wsl2-production-runtime.md`
- Save: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-rapids-wsl2-production-runtime.md`

- [x] **Step 1: Native Windows validation**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_rapids_tape_features.py tests/test_run_rapids_tape_feature_panel.py tests/test_quant_gpu_backends.py -q
uv run --frozen ruff check app/trading/discovery/rapids_tape_features.py scripts/run_rapids_tape_feature_panel.py scripts/check_rapids_wsl2_runtime.py tests/test_run_rapids_tape_feature_panel.py
uv run --frozen pyright --project pyrightconfig.scripts.json
uv sync --frozen --extra dev --extra cuda-research --extra quant-gpu-research
```

Expected: tests pass, ruff passes, scripts Pyright reports 0 errors, CUDA extras restored.

- [ ] **Step 2: WSL2 RAPIDS validation**

Blocked on this host as of 2026-06-01: WSL2 Ubuntu sees the RTX 5090 via
`nvidia-smi`, but RAPIDS is not installed (`cudf`, `dask_cudf`, `cuml`, and
`cugraph` are null in `scripts/check_rapids_wsl2_runtime.py` output) and
`sudo -n true` reports non-interactive sudo is unavailable. Run
`scripts/bootstrap_rapids_wsl2.sh` from WSL ext4 after interactive sudo is
available.

Run:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && python scripts/check_rapids_wsl2_runtime.py'
wsl.exe -d Ubuntu -- bash -lc 'cd ~/github.com/lab/services/torghut && source .venv-rapids/bin/activate && pytest tests/test_rapids_tape_features.py tests/test_run_rapids_tape_feature_panel.py -q'
```

Expected: `cudf` is importable, `nvidia-smi` sees the RTX 5090, and tests pass.

- [ ] **Step 3: Artifact acceptance**

Inspect:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'python - <<PY
import json
from pathlib import Path
panel = json.loads(Path("~/torghut-rapids-artifacts/rapids-tape-feature-panel.json").expanduser().read_text())
assert panel["promotion_proof"] is False
assert panel["research_backend"]["selected_backend"] == "rapids-cudf"
print(panel["research_backend"]["backend"])
PY'
```

Expected: backend report shows `cudf`, RTX 5090 metadata, and no promotion proof.
