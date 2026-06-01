# Torghut Local CUDA Research Acceleration

The local RTX 5090 lane is for advisory research throughput: candidate ranking,
candidate selection triage, and sleeve search prioritization. It does not change
live order submission, promotion authority, runtime-ledger gates, or paper-route
import rules.

## Whitepaper Autoresearch Selection

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

If CUDA PyTorch is unavailable in the Python environment, the ranker falls back
to the existing NumPy path and records the actual backend in the model payload.

## Replay Evidence Boundary

A strict real-replay proof run against the CUDA-ranked selection remains the
required next gate. The current checked run selected `6` replay candidates from
`14680` compiled specs with `backend=torch-cuda`, but strict real replay failed
honestly because recent `torghut.ta_signals` PT1S coverage has only `9` trading
days while the configured `6/3/2` train/holdout/second-OOS proof window requires
`11`.

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
