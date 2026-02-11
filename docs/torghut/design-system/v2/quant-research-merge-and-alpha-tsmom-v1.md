# Quant Research Merge + Alpha Baseline (TSMOM v1)

## Status
- Version: `v2`
- Last updated: **2026-02-11**
- Scope: research/proposal (not production-facing)

## Purpose
1) Capture what Torghut already is (today) as an autonomous trading system scaffold with strong paper-first safety.
2) Merge recent public quant + agentic-finance research (2024-2026) into a concrete implementation direction.
3) Ship a real, runnable “alpha baseline” (time-series momentum) that produces *measurable* results in an offline
   backtest with costs, without pretending to guarantee profitability.

This is not investment advice and does not guarantee profitability.

## Current Torghut State (What Exists In Code)
Torghut already has the main primitives you need for a safe, iterative alpha program:
- Online loop: ingest signals, evaluate strategies, run deterministic risk checks, execute with idempotency.
  - Decision engine: `services/torghut/app/trading/decisions.py`
  - Risk engine: `services/torghut/app/trading/risk.py`
  - Execution/idempotency: `services/torghut/app/trading/execution.py`
  - Pipeline scheduler: `services/torghut/app/trading/scheduler.py`
- Strategy catalog and GitOps path:
  - Deployed catalog: `argocd/applications/torghut/strategy-configmap.yaml`
  - Loader: `services/torghut/app/strategies/catalog.py`
- Offline evaluation scaffolding:
  - Walk-forward harness (signals -> decisions): `services/torghut/app/trading/evaluation.py`
  - Cost model building blocks: `services/torghut/app/trading/costs.py`

What Torghut does not (yet) have in a unified, end-to-end way:
- A standard offline research harness that goes from market data -> alpha -> positions -> costs -> equity curve
  in a single “research lane” with tight controls against overfitting.
- A research ledger that records every search/variant (parameters, datasets, costs) and makes “backtest hygiene”
  auditable.

## Recent Research Themes That Transfer To Torghut
Public “latest” research rarely reveals a live edge, but it does refine process and failure-mode coverage.

### Theme A: Agentic workflows are useful, but must be boxed
Takeaways from finance-agent benchmarks and public “AI for investing” research:
- Treat LLMs/agents as workflow accelerators and reviewers, not as execution authorities.
- Make evaluation gates harder as autonomy increases (shadow mode -> paper -> limited live).
- Track and budget the “tooling costs” (tokens, search, code churn) like any other trading cost.

References to fold into Torghut’s governance lane:
- Two Sigma “AI in Investment Management: 2026 Outlook” (Parts I and II).
- Man Institute “What AI can (and can’t yet) do for alpha” (2025).
- FinVault benchmark (2026), QuantAgent (2025), JaxMARL-HFT (2025) as “inspiration only”.

### Theme B: Backtest validity is where most alpha dies
Key controls Torghut should require for anything labeled “alpha candidate”:
- Walk-forward, purged splits, and embargo to reduce leakage.
- Multiple-testing awareness (deflated Sharpe / reality-check style discipline).
- Sensitivity plots: avoid razor-thin optima.

Foundational references are already in `docs/torghut/design-system/v2/research-reading-list.md`:
- White’s Reality Check, PBO/CSCV, Deflated Sharpe Ratio.

### Theme C: “ML/LOB/HFT papers” are mostly downstream of data realism
Modern papers on transformers over limit order book or RL execution can be useful, but only after Torghut has:
- High-integrity order book data with clear timestamp semantics.
- A simulator that matches fill reality closely enough to avoid training on fiction.
- Strong safety constraints (kill switches, firewall, deterministic risk final authority).

Actionable plan: keep these as “advanced lane” inputs, not as MVP alpha drivers.

## Alpha Baseline Shipped In This Repo: TSMOM v1 (Offline)
We now include a runnable baseline time-series momentum strategy (trend following proxy) with:
- lookback return signal,
- volatility targeting,
- gross leverage cap across symbols,
- turnover-based cost penalty (bps per unit turnover),
- standard performance summary (CAGR, Sharpe, max drawdown).

Code:
- Strategy: `services/torghut/app/trading/alpha/tsmom.py`
- Stooq data source: `services/torghut/app/trading/alpha/data_sources.py`
- Metrics: `services/torghut/app/trading/alpha/metrics.py`
- Search: `services/torghut/app/trading/alpha/search.py`
- CLI runner: `services/torghut/scripts/backtest_tsmom_stooq.py`
- Grid search runner: `services/torghut/scripts/search_tsmom_alpha.py`
- Tests: `services/torghut/tests/test_alpha_tsmom.py`
- Search tests: `services/torghut/tests/test_alpha_search.py`

### Why TSMOM as the baseline
Time-series momentum is a widely studied “alpha family” that is:
- simple enough to implement correctly,
- robust enough to be a good backtest-hygiene testbed,
- a direct forcing function for volatility targeting, costs, and regime behavior.

### Run It (Local)
From `services/torghut/`:
```bash
uv run python scripts/backtest_tsmom_stooq.py \
  --symbols spy.us,qqq.us,tlt.us,ief.us \
  --start 2010-01-01 --end 2025-12-31 \
  --lookback 60 --vol-lookback 20 \
  --target-vol 0.01 --max-gross 1.0 \
  --cost-bps 5
```

This prints a JSON summary to stdout and can optionally emit `--json` and `--csv` outputs.

### Parameter Search + Out-of-Sample Gate
From `services/torghut/`:
```bash
uv run python scripts/search_tsmom_alpha.py \
  --symbols spy.us,qqq.us,tlt.us,ief.us,gld.us \
  --start 2010-01-01 --train-end 2019-12-31 --end 2025-12-31 \
  --lookbacks 20,40,60,120 --vol-lookbacks 10,20,40 \
  --target-vols 0.0075,0.01,0.0125 --max-grosses 0.75,1.0 \
  --cost-bps 5 --json /tmp/torghut_tsmom_search_final.json
```

Recorded run snapshot on **2026-02-11**:
- Acceptance: `accepted=true` (gate requires positive test return and test Sharpe)
- Best ranked config (by train metrics): `lookback=120`, `vol_lookback=20`, `target_daily_vol=0.0075`, `max_gross=1.0`
- Train summary:
  - total return: `1.0948`
  - CAGR: `0.0769`
  - Sharpe: `0.9529`
  - max drawdown: `-0.1462`
- Test summary:
  - total return: `0.5293`
  - CAGR: `0.0736`
  - Sharpe: `0.7372`
  - max drawdown: `-0.2187`

Interpretation:
- This is a reproducible, cost-aware, out-of-sample positive baseline, not proof of production alpha durability.
- Promotion to production still requires stricter walk-forward and multiple-testing controls.

## How This Connects Back To Online Torghut
Offline alpha work must be “promotable” into the online loop without redefining signals:
- MVP: use offline harness for research only; online loop continues to consume TA signals.
- Next: add a “feature contract” so offline and online compute the same inputs (or the online path is strictly a
  function of ClickHouse-stored features).

Concrete next internal deliverables:
1) Expand the offline harness to support purged walk-forward splits and parameter sweeps with a “trial budget”.
2) Introduce a research ledger record (even if a JSON file first, then Postgres) that tracks:
   - dataset version, parameters tested, costs, and results.
3) Add promotion gates: a strategy cannot be enabled in GitOps unless it has an offline run id and summary attached.

## Non-Negotiables (To Keep “Autonomous” From Becoming “Unsafe”)
- Paper-by-default.
- Deterministic risk remains final authority.
- LLM/agent components cannot have broker credentials.
- Every reported result must be reproducible from pinned inputs and code.
