# Torghut Local CUDA Research Acceleration

The current local RTX 5090 implementation has explicit advisory lanes:

- `torch-cuda`: candidate ranking, candidate selection triage, and sleeve search
  prioritization.
- `cupy`: manifest-verified replay-tape preview scoring and NumPy-shaped vector
  work.
- `numba-cuda`: custom sleeve/path simulation kernels with CPU equivalence tests.

The production stack is tracked in
`docs/torghut/production-gpu-research-stack.md`; RAPIDS/cuDF is documented and
implemented behind an explicit backend, but production execution should happen
under WSL2/Linux/container rather than native Windows Python.

This lane does not change live order submission, promotion authority,
runtime-ledger gates, or paper-route import rules.

## Whitepaper Autoresearch Ranker Selection

Install the optional CUDA research extra before using the local RTX 5090 lane:

```powershell
cd services/torghut
uv sync --frozen --extra dev --extra cuda-research
```

Verify the runtime sees the GPU:

```powershell
uv run --frozen --extra dev --extra cuda-research python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

The verified local runtime for this slice was `torch==2.11.0+cu128`,
CUDA `12.8`, device `NVIDIA GeForce RTX 5090`, compute capability `12.0`.

Install the quant GPU extra before using CuPy or Numba-CUDA:

```powershell
cd services/torghut
uv sync --frozen --extra dev --extra quant-gpu-research
```

Verify explicit quant GPU backends:

```powershell
uv run --frozen --extra dev --extra quant-gpu-research python scripts/probe_quant_gpu_backends.py --backend cupy --backend numba-cuda --backend rapids-cudf
```

On this host, `cupy==13.6.0` and `numba-cuda==0.65.1` see
`NVIDIA GeForce RTX 5090`, compute capability `12.0`. `rapids-cudf` is not
installed in the native Windows venv. The CuPy probe preloads NVRTC through
NVIDIA `cuda.pathfinder` on Windows and runs an actual `cupy.diff` smoke
operation before reporting availability.

Use the CUDA backend explicitly when running a selection-only research pass:

```powershell
cd services/torghut
uv run --frozen --extra dev --extra cuda-research python scripts/run_whitepaper_autoresearch_profit_target.py `
  --output-dir <run-dir> `
  --ranker-backend-preference torch-cuda `
  --selection-only
```

The resulting artifacts can prioritize replay candidates:

- `pre-replay-mlx-ranker-model.json`
- `pre-replay-mlx-proposal-scores.jsonl`
- `candidate-selection-manifest.json`
- `selected-candidate-specs.jsonl`

If PyTorch CUDA is unavailable in the Python environment, the ranker falls back
to the existing NumPy path and records the actual backend in the model payload.
Do not use a generic `cuda` backend name for this path; the implemented backend
is explicitly `torch-cuda`.

## Replay Evidence Boundary

A strict real-replay proof run against the GPU-ranked and CuPy-previewed
selection remains the required next gate. The current checked
`torch-cuda` selection run compiled/scored `14680` specs and selected `24`
candidate specs. The checked CuPy replay preview used the manifest-verified
raw-signal tape
`tmp/torghut-gpu-replay-tape-20260601T055007Z/replay-tape.jsonl` with digest
`fe2a7ead4d0b331eaebd990013f53f4287c8deabbc1aea2f8259e99d0545b43d`, selected
backend `cupy`, and kept `promotion_proof=false`.

The checked Numba-CUDA sleeve simulation preview used the same candidate specs,
preview scores, and replay tape:

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

Artifacts:

- `tmp/torghut-gpu-sleeve-simulation-20260601T061100Z/sleeve-simulation-preview-manifest.json`
- `tmp/torghut-gpu-sleeve-simulation-20260601T061100Z/sleeve-simulation-preview-rows.jsonl`

The same sleeve simulation stage is now available directly inside
`scripts/run_whitepaper_autoresearch_profit_target.py`:

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

Integrated artifacts:

- `tmp/torghut-gpu-integrated-preview-20260601T064500Z/replay-tape-preview-manifest.json`
- `tmp/torghut-gpu-integrated-preview-20260601T064500Z/sleeve-simulation-preview-manifest.json`
- `tmp/torghut-gpu-integrated-preview-20260601T064500Z/sleeve-simulation-preview-rows.jsonl`

This is still preview-only and keeps `promotion_proof=false`.

Strict executable replay is still blocked honestly: the latest complete-window
preflight could not find a 5-day complete executable window for
2026-05-01 through 2026-05-31. The raw preview tape covers four trading days
from 2026-05-26 through 2026-05-29 and is preview-only.

Replay tape requested-day coverage now uses the shared US equities full-day
holiday calendar, so Memorial Day 2026-05-25 is not treated as missing strict
coverage. The remaining blocker is source executable quote-backed coverage and
stale quote gaps on actual trading sessions.

A shorter `5/2/2` diagnostic replay is useful only for candidate rejection and
ranking feedback. It is not promotion proof and must not be used to clear
runtime-ledger, live-paper, or firewall blockers.

## Retention Prerequisite

The replay source and derived TA retention must cover the proof horizon before
starting non-destructive TA replay. The production contract for this lane is
`35` calendar days, enough for a `25` trading-day proof window:

- Kafka source topics: trades, quotes, and bars
- Kafka derived TA topics: microbars and signals
- ClickHouse TA tables: `ta_microbars` and `ta_signals`

If the preflight reports source retention shortfall, do not start a replay; wait
for new retained days or restore an immutable archive source.

## Promotion Boundary

CUDA-ranked candidates remain research candidates until the normal Torghut
evidence stack proves them:

- real or approved replay evidence with explicit costs
- live-paper parity evidence
- runtime-ledger bucket closure
- lifecycle closure and TigerBeetle journal references
- post-cost PnL against the active profit target
- existing firewall and promotion blockers cleared by their owning services

The CUDA ranker must not clear `simple_submit_disabled`,
`alpha_readiness_not_promotion_eligible`, or
`runtime_ledger_source_collection_pending`.
