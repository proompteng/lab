# Torghut CUDA Research Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the local RTX 5090 to accelerate Torghut candidate and sleeve research while keeping promotion authority in runtime-ledger, live-paper, exact-replay, and post-cost profitability evidence.

**Architecture:** Add an optional CUDA ranker backend behind explicit backend preference plumbing, then use the faster ranker to prioritize candidate/sleeve replay queues. The GPU path may rank, triage, and search; it must not set promotion flags, relax blockers, or replace realized runtime-ledger proof packets.

**Tech Stack:** Python 3.11-3.12, uv, optional PyTorch CUDA, NumPy fallback, Torghut MLX ranker artifacts, runtime-ledger proof packets, paper-route evidence artifacts.

---

## Files

- Create: `docs/superpowers/plans/2026-06-01-torghut-cuda-research-acceleration.md`
- Modify: `services/torghut/app/trading/discovery/mlx_training_data.py`
- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Test: `services/torghut/tests/test_whitepaper_autoresearch_artifacts.py`
- Test: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`
- Create: `docs/torghut/local-cuda-research-acceleration.md`
- Save notes: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-cuda-ranker-backend-slice.md`

## Non-Negotiable Gates

- CUDA output is advisory research evidence only.
- Promotion remains blocked unless live-paper parity, runtime-ledger buckets, exact replay, explicit costs, lineage, TigerBeetle refs, and closed lifecycle checks pass.
- `simple_submit_disabled`, `alpha_readiness_not_promotion_eligible`, and `runtime_ledger_source_collection_pending` must not be bypassed by this plan.
- No required PyTorch dependency is added to the base Torghut environment in this slice; CUDA support is optional and selected explicitly.

## Implementation Checkpoint

- Added an optional `cuda-research` extra in `services/torghut/pyproject.toml`
  using the explicit PyTorch CUDA 12.8 wheel index; base Torghut dependencies
  remain unchanged.
- Added `services/torghut/tests/test_cuda_research_runtime_contract.py` to keep
  the CUDA extra and explicit wheel source reproducible.
- Added a Windows-safe real-replay timeout path: platforms without `SIGALRM`
  run timed replay work in a terminable child process instead of disabling the
  timeout.
- Verified local CUDA with `torch==2.11.0+cu128`, CUDA `12.8`, and
  `NVIDIA GeForce RTX 5090`.
- Latest strict real-replay evidence remains blocked by data coverage:
  `torghut.ta_signals` PT1S has `9` recent trading days, while the configured
  proof window requires `11`.
- Follow-up retention hardening extends Torghut live/sim Kafka replay-source
  topics and ClickHouse TA table TTLs to `35` calendar days, enough for a
  `25` trading-day proof horizon. This prevents future proof windows from
  failing for the same source-retention/TTL reason; it does not fabricate
  already-expired rows.

### Task 1: Persist This Plan

**Files:**

- Create: `docs/superpowers/plans/2026-06-01-torghut-cuda-research-acceleration.md`

- [ ] **Step 1: Write the plan**

Create this file with the goal, architecture, gates, tasks, and verification commands.

- [ ] **Step 2: Verify the plan is tracked**

Run: `git status --short docs/superpowers/plans/2026-06-01-torghut-cuda-research-acceleration.md`

Expected: the file appears as an added path.

### Task 2: Add a Failing CUDA Backend Test

**Files:**

- Modify: `services/torghut/tests/test_whitepaper_autoresearch_artifacts.py`

- [ ] **Step 1: Add a fake torch CUDA test**

Add this test near the existing MLX ranker tests:

```python
    def test_ranker_uses_torch_cuda_backend_when_requested(self) -> None:
        rows = [
            MlxTrainingRow(
                candidate_spec_id="low",
                feature_names=("edge", "risk"),
                feature_values=(0.1, 0.9),
                target=10.0,
            ),
            MlxTrainingRow(
                candidate_spec_id="high",
                feature_names=("edge", "risk"),
                feature_values=(0.9, 0.1),
                target=100.0,
            ),
        ]

        model = train_mlx_ranker(rows, backend_preference="torch-cuda", steps=8)

        self.assertEqual(model.backend, "torch-cuda")
```

- [ ] **Step 2: Run the test and confirm red**

Run: `uv run --frozen pytest tests/test_whitepaper_autoresearch_artifacts.py::TestWhitepaperAutoresearchArtifacts::test_ranker_uses_torch_cuda_backend_when_requested -q`

Expected: fail because `torch-cuda` is not currently a supported array backend.

### Task 3: Implement Optional Torch CUDA Backend

**Files:**

- Modify: `services/torghut/app/trading/discovery/mlx_training_data.py`

- [ ] **Step 1: Add a tiny torch adapter**

Add an internal adapter that exposes only the ranker operations already used by `train_mlx_ranker`: `array`, `zeros`, `float32`, matrix multiply through tensors, `.T`, `.mean()`, and `.tolist()`.

```python
class _TorchCudaArrayBackend:
    float32: Any

    def __init__(self, torch_module: Any, *, device: str) -> None:
        self._torch = torch_module
        self._device = device
        self.float32 = torch_module.float32

    def array(self, value: Any, *, dtype: Any | None = None) -> Any:
        return self._torch.tensor(value, dtype=dtype, device=self._device)

    def zeros(self, shape: Any, *, dtype: Any | None = None) -> Any:
        return self._torch.zeros(shape, dtype=dtype, device=self._device)
```

- [ ] **Step 2: Wire backend selection**

Extend `_import_array_backend()` so `torch-cuda`, `cuda`, and `torch` attempt dynamic `import torch`, require `torch.cuda.is_available()` for CUDA names, and return `("torch-cuda", _TorchCudaArrayBackend(...))` when available. If unavailable, fall through to the existing NumPy fallback for advisory research continuity.

- [ ] **Step 3: Run the CUDA backend test and confirm green**

Run: `uv run --frozen pytest tests/test_whitepaper_autoresearch_artifacts.py::TestWhitepaperAutoresearchArtifacts::test_ranker_uses_torch_cuda_backend_when_requested -q`

Expected: pass on a host with usable CUDA PyTorch; pass with NumPy fallback only when the test injects a fake torch module.

### Task 4: Thread Backend Preference Through Whitepaper Autoresearch

**Files:**

- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Modify: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`

- [ ] **Step 1: Add a CLI argument**

Add:

```python
    parser.add_argument(
        "--ranker-backend-preference",
        default="mlx",
        choices=("mlx", "numpy", "numpy-fallback", "torch", "torch-cuda", "cuda"),
        help=(
            "Array backend for advisory MLX ranker training. CUDA choices only "
            "accelerate research ranking and do not change promotion gates."
        ),
    )
```

- [ ] **Step 2: Pass the preference into ranker training**

Update `_pre_replay_proposal_model_and_rows()` and `_proposal_model_and_rows()` to accept `ranker_backend_preference: str`, then pass it to `train_mlx_ranker()`.

- [ ] **Step 3: Add a propagation test**

Patch `runner.train_mlx_ranker` in the runner test and assert the backend preference from args is passed into both pre-replay and post-replay ranker calls.

- [ ] **Step 4: Run the propagation test**

Run: `uv run --frozen pytest tests/test_run_whitepaper_autoresearch_profit_target.py -k "ranker_backend_preference" -q`

Expected: pass.

### Task 5: Add Local 5090 Operations Note

**Files:**

- Create: `docs/torghut/local-cuda-research-acceleration.md`

- [ ] **Step 1: Document the host lane**

Document the exact command shape:

```powershell
cd services/torghut
uv run --frozen python scripts/run_whitepaper_autoresearch_profit_target.py `
  --output-dir <run-dir> `
  --ranker-backend-preference torch-cuda `
  --selection-only
```

State that this produces candidate-selection artifacts only unless replay/persistence flags are separately supplied, and that no live order or promotion gate is changed.

- [ ] **Step 2: Verify docs are present**

Run: `rg -n "torch-cuda|promotion" docs/torghut/local-cuda-research-acceleration.md`

Expected: both strings are present.

### Task 6: Verification

**Files:**

- Validate all files modified in this plan.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
cd services/torghut
uv run --frozen pytest tests/test_whitepaper_autoresearch_artifacts.py::TestWhitepaperAutoresearchArtifacts::test_ranker_uses_torch_cuda_backend_when_requested -q
uv run --frozen pytest tests/test_run_whitepaper_autoresearch_profit_target.py -k "ranker_backend_preference" -q
```

Expected: both commands exit 0.

- [ ] **Step 2: Run formatting and lint checks for touched Python**

Run:

```powershell
cd services/torghut
uv run --frozen ruff check app/trading/discovery/mlx_training_data.py scripts/run_whitepaper_autoresearch_profit_target.py tests/test_whitepaper_autoresearch_artifacts.py tests/test_run_whitepaper_autoresearch_profit_target.py
```

Expected: exit 0.

- [ ] **Step 3: Run Torghut pyright profiles**

Run:

```powershell
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Expected: all commands exit 0 before claiming type checks pass.

### Task 7: Save Notes

**Files:**

- Create: `C:/Users/gkonu/github.com/cerebrum/Torghut/<timestamp>-cuda-ranker-backend-slice.md`

- [ ] **Step 1: Save an Obsidian note**

Record the repo plan path, code files changed, test commands, and whether PyTorch CUDA was present on this host.

- [ ] **Step 2: Save a memories-service entry**

Run:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" run --filter memories save-memory --task-name torghut-cuda-research-acceleration --content "<summary>" --summary "<short summary>" --tags torghut,cuda,research
```

Expected: the memory command exits 0 or reports the exact environment blocker.
