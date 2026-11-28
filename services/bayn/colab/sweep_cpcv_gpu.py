#!/usr/bin/env python3
"""Vectorized GPU/CPU Purged CPCV & Cost-Surface Sweep Engine for Bayn.

Runs out-of-the-box on Google Colab AI Ultra (A100/H100/L4/TPU) and Galactic's
local 8x RTX PRO 6000 Blackwell GPUs via PyTorch when available, and falls back
cleanly to NumPy CPU for deterministic CI unit testing.

Fail-closed invariants:
  - Verifies MANIFEST.json schemaVersion == "bayn.colab-dev-cube.v1" and every
    file's SHA-256 digest & byte size BEFORE reading any market data.
  - Refuses any devCutoff > "2023-12-29" or any row dated past devCutoff or at/after
    excludedHoldoutStart ("2024-01-02").
  - Emits ONE compact (<50 KB) experiment_receipt.json suitable for auditing and
    compiling into services/bayn/src/strategy/... without leaking holdout data.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import itertools
import json
import math
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import torch  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - optional GPU accelerator
    torch = None  # type: ignore[assignment]

SCHEMA_VERSION_CUBE = "bayn.colab-dev-cube.v1"
SCHEMA_VERSION_RECEIPT = "bayn.colab-cpcv-receipt.v1"
CANONICAL_DEV_CUTOFF = "2023-12-29"
CANONICAL_HOLDOUT_START = "2024-01-02"
COST_SURFACE_BPS: tuple[int, ...] = (2, 5, 10, 15)
BASELINE_KEYS: tuple[str, ...] = ("B0", "F4", "O1")
MAX_RECEIPT_BYTES = 50_000
ANNUAL_SESSIONS = 252
EULER_GAMMA = 0.5772156649015329


class CubeIntegrityError(ValueError):
    """Raised when MANIFEST.json schema, files, or SHA-256 digests fail verification."""


class HoldoutLeakageError(ValueError):
    """Raised when a cutoff or data row violates the sealed holdout boundary."""


class ReceiptSizeError(ValueError):
    """Raised when the emitted experiment_receipt.json exceeds the 50 KB budget."""


@dataclass(frozen=True)
class CandidateParams:
    lookback_days: int
    vol_window_days: int
    entry_z_score: float
    rebalance_cadence_days: int
    top_k: int
    target_vol: float
    long_only: bool = True

    def candidate_id(self) -> str:
        mode = "L" if self.long_only else "LS"
        return (
            f"{mode}/lb{self.lookback_days}/vw{self.vol_window_days}/"
            f"z{self.entry_z_score:.2f}/cad{self.rebalance_cadence_days}/"
            f"k{self.top_k}/tv{self.target_vol:.2f}"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "lookbackDays": self.lookback_days,
            "volWindowDays": self.vol_window_days,
            "entryZScore": self.entry_z_score,
            "rebalanceCadenceDays": self.rebalance_cadence_days,
            "topK": self.top_k,
            "targetVol": self.target_vol,
            "longOnly": self.long_only,
        }


@dataclass(frozen=True)
class CpcvSplit:
    split_id: int
    test_groups: tuple[int, ...]
    train_indices: np.ndarray
    test_indices: np.ndarray
    purged_indices: np.ndarray
    embargoed_indices: np.ndarray


@dataclass(frozen=True)
class DevCubeData:
    manifest: dict[str, Any]
    dev_cube_sha256: str
    dev_cutoff: str
    excluded_holdout_start: str
    source_commit: str
    dates: tuple[str, ...]
    symbols: tuple[str, ...]
    closes: np.ndarray  # shape (T, A), float64
    returns: np.ndarray  # shape (T, A), float64
    baselines: dict[str, np.ndarray]  # optional B0/F4/O1 series of shape (T,)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1 << 16)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def _assert_not_holdout(date: str, dev_cutoff: str, excluded_holdout_start: str, label: str) -> None:
    if date > dev_cutoff or date >= excluded_holdout_start or date > CANONICAL_DEV_CUTOFF:
        raise HoldoutLeakageError(
            f"Refusing {label} on {date}: exceeds devCutoff ({dev_cutoff}) or enters "
            f"sealed holdout ({excluded_holdout_start})"
        )


def verify_and_load_dev_cube(cube_dir: Path) -> DevCubeData:
    """Verify MANIFEST.json digests and load daily closes + optional baseline returns."""
    manifest_path = cube_dir / "MANIFEST.json"
    if not manifest_path.is_file():
        raise CubeIntegrityError(f"Missing MANIFEST.json in {cube_dir}")

    manifest_bytes = manifest_path.read_bytes()
    dev_cube_sha256 = _sha256_bytes(manifest_bytes)
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CubeIntegrityError("Invalid JSON in MANIFEST.json") from exc

    if manifest.get("schemaVersion") != SCHEMA_VERSION_CUBE:
        raise CubeIntegrityError(
            f"Unsupported manifest schemaVersion: {manifest.get('schemaVersion')!r}; "
            f"expected {SCHEMA_VERSION_CUBE!r}"
        )

    dev_cutoff = str(manifest.get("devCutoff", ""))
    excluded_holdout_start = str(manifest.get("excludedHoldoutStart", CANONICAL_HOLDOUT_START))
    if not dev_cutoff or dev_cutoff > CANONICAL_DEV_CUTOFF or dev_cutoff >= excluded_holdout_start:
        raise HoldoutLeakageError(
            f"Invalid manifest devCutoff={dev_cutoff!r} vs canonical {CANONICAL_DEV_CUTOFF!r} "
            f"/ holdout {excluded_holdout_start!r}"
        )

    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise CubeIntegrityError("MANIFEST.json contains no files")

    by_kind: dict[str, Path] = {}
    for entry in files:
        rel_path = entry.get("path")
        expected_sha = entry.get("sha256")
        expected_bytes = entry.get("bytes")
        kind = entry.get("kind")
        if not isinstance(rel_path, str) or not isinstance(expected_sha, str) or not isinstance(expected_bytes, int):
            raise CubeIntegrityError(f"Malformed file entry in MANIFEST.json: {entry!r}")
        full_path = (cube_dir / rel_path).resolve()
        if cube_dir.resolve() not in full_path.parents or not full_path.is_file():
            raise CubeIntegrityError(f"Missing or invalid cube file path: {rel_path}")
        actual_sha, actual_bytes = _sha256_file(full_path)
        if actual_sha != expected_sha or actual_bytes != expected_bytes:
            raise CubeIntegrityError(
                f"SHA-256 or size mismatch for {rel_path}: "
                f"expected ({expected_sha}, {expected_bytes}), got ({actual_sha}, {actual_bytes})"
            )
        if isinstance(kind, str):
            by_kind[kind] = full_path

    if "daily_bars" not in by_kind:
        raise CubeIntegrityError("MANIFEST.json is missing required 'daily_bars' cube file")

    cube_format = manifest.get("format", "jsonl.gz")

    def iter_rows(path: Path) -> list[dict[str, Any]]:
        with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
            if cube_format == "jsonl.gz" or path.name.endswith(".jsonl.gz"):
                return [json.loads(line) for line in handle if line.strip()]
            if cube_format == "csv.gz" or path.name.endswith(".csv.gz"):
                return list(csv.DictReader(handle))
            raise CubeIntegrityError(f"Unsupported cube format: {cube_format!r}")

    # Validate calendar dates if present
    if "calendar" in by_kind:
        for row in iter_rows(by_kind["calendar"]):
            _assert_not_holdout(str(row["date"]), dev_cutoff, excluded_holdout_start, "calendar session")

    daily_rows = iter_rows(by_kind["daily_bars"])
    if not daily_rows:
        raise CubeIntegrityError("daily_bars cube contains zero rows")

    dates_set: set[str] = set()
    symbols_set: set[str] = set()
    close_map: dict[tuple[str, str], float] = {}
    for row in daily_rows:
        date = str(row["date"])
        symbol = str(row["symbol"])
        _assert_not_holdout(date, dev_cutoff, excluded_holdout_start, f"daily bar ({symbol})")
        close_val = float(row["close"])
        if not math.isfinite(close_val) or close_val <= 0.0:
            raise CubeIntegrityError(f"Invalid close price for {symbol} on {date}: {close_val}")
        key = (date, symbol)
        if key in close_map:
            raise CubeIntegrityError(f"Duplicate daily bar for {symbol} on {date}")
        close_map[key] = close_val
        dates_set.add(date)
        symbols_set.add(symbol)

    dates = tuple(sorted(dates_set))
    symbols = tuple(sorted(symbols_set))
    t_len = len(dates)
    a_len = len(symbols)
    closes = np.full((t_len, a_len), np.nan, dtype=np.float64)
    for ti, d in enumerate(dates):
        for ai, s in enumerate(symbols):
            val = close_map.get((d, s))
            if val is not None:
                closes[ti, ai] = val

    # Close-to-close simple returns (0.0 on first observation or missing prior bar).
    returns = np.zeros((t_len, a_len), dtype=np.float64)
    if t_len > 1:
        prev = closes[:-1]
        curr = closes[1:]
        valid = np.isfinite(prev) & np.isfinite(curr) & (prev > 0.0)
        returns[1:] = np.where(valid, curr / prev - 1.0, 0.0)

    baselines: dict[str, np.ndarray] = {}
    if "baseline_returns" in by_kind:
        date_to_idx = {d: i for i, d in enumerate(dates)}
        base_rows = iter_rows(by_kind["baseline_returns"])
        for bkey in BASELINE_KEYS:
            baselines[bkey] = np.zeros(t_len, dtype=np.float64)
        for row in base_rows:
            date = str(row["date"])
            _assert_not_holdout(date, dev_cutoff, excluded_holdout_start, "baseline return row")
            idx = date_to_idx.get(date)
            if idx is None:
                continue
            for bkey in BASELINE_KEYS:
                if bkey in row and row[bkey] != "":
                    val = float(row[bkey])
                    if not math.isfinite(val):
                        raise CubeIntegrityError(f"Non-finite baseline return {bkey} on {date}")
                    baselines[bkey][idx] = val

    return DevCubeData(
        manifest=manifest,
        dev_cube_sha256=dev_cube_sha256,
        dev_cutoff=dev_cutoff,
        excluded_holdout_start=excluded_holdout_start,
        source_commit=str(manifest.get("sourceCommit", "")),
        dates=dates,
        symbols=symbols,
        closes=closes,
        returns=returns,
        baselines=baselines,
    )


def generate_cpcv_splits(
    n_sessions: int,
    n_groups: int = 6,
    k_test_groups: int = 2,
    purge_sessions: int = 20,
    embargo_sessions: int = 5,
) -> list[CpcvSplit]:
    """Generate Combinatorial Purged Cross-Validation splits with purge & embargo gaps."""
    if n_groups < 2 or k_test_groups < 1 or k_test_groups >= n_groups:
        raise ValueError(f"Invalid CPCV configuration: n_groups={n_groups}, k_test_groups={k_test_groups}")
    if purge_sessions < 0 or embargo_sessions < 0:
        raise ValueError("purge_sessions and embargo_sessions must be non-negative")
    if n_sessions < n_groups:
        raise ValueError(f"n_sessions ({n_sessions}) must be >= n_groups ({n_groups})")

    # Partition [0, n_sessions) into n_groups contiguous blocks.
    bounds: list[tuple[int, int]] = []
    base = n_sessions // n_groups
    rem = n_sessions % n_groups
    cursor = 0
    for g in range(n_groups):
        size = base + (1 if g < rem else 0)
        bounds.append((cursor, cursor + size))
        cursor += size

    splits: list[CpcvSplit] = []
    for split_id, test_groups in enumerate(itertools.combinations(range(n_groups), k_test_groups)):
        test_mask = np.zeros(n_sessions, dtype=bool)
        purge_mask = np.zeros(n_sessions, dtype=bool)
        embargo_mask = np.zeros(n_sessions, dtype=bool)

        # Merge adjacent selected test groups into contiguous test intervals before applying purge/embargo.
        merged_blocks: list[tuple[int, int]] = []
        for g in test_groups:
            start, end = bounds[g]
            if merged_blocks and merged_blocks[-1][1] == start:
                merged_blocks[-1] = (merged_blocks[-1][0], end)
            else:
                merged_blocks.append((start, end))

        for start, end in merged_blocks:
            test_mask[start:end] = True
            p_start = max(0, start - purge_sessions)
            if p_start < start:
                purge_mask[p_start:start] = True
            e_end = min(n_sessions, end + embargo_sessions)
            if end < e_end:
                embargo_mask[end:e_end] = True

        # Purge/embargo never override test indices; they exclude nearby training indices.
        purge_mask &= ~test_mask
        embargo_mask &= ~test_mask
        train_mask = ~(test_mask | purge_mask | embargo_mask)

        splits.append(
            CpcvSplit(
                split_id=split_id,
                test_groups=test_groups,
                train_indices=np.flatnonzero(train_mask),
                test_indices=np.flatnonzero(test_mask),
                purged_indices=np.flatnonzero(purge_mask),
                embargoed_indices=np.flatnonzero(embargo_mask),
            )
        )
    return splits


def normal_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def normal_quantile(p: float) -> float:
    """High-precision standard normal inverse CDF via bisection on math.erf."""
    if not (0.0 < p < 1.0):
        raise ValueError(f"Probability must lie strictly in (0, 1), got {p}")
    lo, hi = -12.0, 12.0
    for _ in range(64):
        mid = 0.5 * (lo + hi)
        if normal_cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def expected_max_daily_sharpe(trial_daily_sharpes: np.ndarray, trials_tested: int | None = None) -> float:
    """Bailey & Lopez de Prado expected maximum daily Sharpe across N independent trials."""
    n_trials = int(len(trial_daily_sharpes) if trials_tested is None else trials_tested)
    if n_trials < 2 or len(trial_daily_sharpes) < 2:
        return 0.0
    finite = trial_daily_sharpes[np.isfinite(trial_daily_sharpes)]
    if len(finite) < 2:
        return 0.0
    sigma_sr = float(np.std(finite, ddof=1))
    if not math.isfinite(sigma_sr) or sigma_sr <= 0.0:
        return 0.0
    z1 = normal_quantile(1.0 - 1.0 / n_trials)
    z2 = normal_quantile(1.0 - 1.0 / (n_trials * math.e))
    return max(0.0, sigma_sr * ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2))


def deflated_sharpe_ratio(
    daily_returns: np.ndarray,
    trials_tested: int,
    trial_daily_sharpe_std: float,
) -> tuple[float | None, float]:
    """Exact Bailey & Lopez de Prado Deflated Sharpe Ratio (DSR).

    Returns (dsr_probability, expected_max_daily_sharpe_sr0).
    Matches services/bayn/tools/research-lib/statistics.ts.
    """
    arr = np.asarray(daily_returns, dtype=np.float64)
    n_obs = len(arr)
    if n_obs < 3 or not np.all(np.isfinite(arr)):
        return None, 0.0
    std = float(np.std(arr, ddof=1))
    if not math.isfinite(std) or std <= 0.0:
        return None, 0.0
    sr_obs = float(np.mean(arr)) / std

    if trials_tested >= 2 and math.isfinite(trial_daily_sharpe_std) and trial_daily_sharpe_std > 0.0:
        z1 = normal_quantile(1.0 - 1.0 / trials_tested)
        z2 = normal_quantile(1.0 - 1.0 / (trials_tested * math.e))
        sr0 = max(0.0, trial_daily_sharpe_std * ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2))
    else:
        sr0 = 0.0

    centered = arr - float(np.mean(arr))
    var = float(np.mean(centered**2))
    if var <= 0.0:
        return None, sr0
    skew = float(np.mean(centered**3)) / (var**1.5)
    kurtosis = float(np.mean(centered**4)) / (var**2)
    denom_inner = 1.0 - skew * sr_obs + ((kurtosis - 1.0) * (sr_obs**2)) / 4.0
    if denom_inner <= 0.0:
        return None, sr0
    z_score = ((sr_obs - sr0) * math.sqrt(n_obs - 1)) / math.sqrt(denom_inner)
    return normal_cdf(z_score), sr0


def compute_series_metrics(daily_returns: np.ndarray, daily_turnover: np.ndarray) -> dict[str, float | None]:
    """Compute CAGR, annualized Sharpe, MaxDD, and mean daily turnover."""
    arr = np.asarray(daily_returns, dtype=np.float64)
    t_len = len(arr)
    if t_len < 2 or not np.all(np.isfinite(arr)):
        return {"cagr": None, "sharpe": None, "maxDrawdown": None, "dailyTurnover": None}

    nav = np.cumprod(1.0 + arr)
    terminal = float(nav[-1])
    peaks = np.maximum.accumulate(np.concatenate(([1.0], nav)))[1:]
    drawdowns = np.where(peaks > 0.0, 1.0 - nav / peaks, 1.0)
    max_dd = float(np.max(drawdowns))
    years = t_len / float(ANNUAL_SESSIONS)
    cagr = (terminal ** (1.0 / years) - 1.0) if (terminal > 0.0 and years > 0.0) else None

    std = float(np.std(arr, ddof=1))
    ann_sharpe = (float(np.mean(arr)) / std * math.sqrt(ANNUAL_SESSIONS)) if (std > 0.0) else None
    mean_turnover = float(np.mean(daily_turnover)) if len(daily_turnover) == t_len else 0.0
    return {
        "cagr": cagr,
        "sharpe": ann_sharpe,
        "maxDrawdown": max_dd,
        "dailyTurnover": mean_turnover,
    }


def pearson_corr(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) != len(y) or len(x) < 2:
        return 0.0
    sx = float(np.std(x, ddof=1))
    sy = float(np.std(y, ddof=1))
    if sx <= 0.0 or sy <= 0.0:
        return 0.0
    xc = x - float(np.mean(x))
    yc = y - float(np.mean(y))
    return float(np.clip(np.dot(xc, yc) / ((len(x) - 1) * sx * sy), -1.0, 1.0))


def marginal_portfolio_metrics(
    candidate_returns: np.ndarray,
    baselines: dict[str, np.ndarray],
    sleeve_weight: float = 0.25,
    corr_free_threshold: float = 0.20,
    corr_penalty_weight: float = 0.50,
) -> dict[str, Any]:
    """Compute correlation penalty and marginal Sharpe lift against reference B0/F4/O1 baselines."""
    corrs: dict[str, float | None] = {}
    per_base_marginal: dict[str, float | None] = {}
    active_series: list[np.ndarray] = []

    for key in BASELINE_KEYS:
        series = baselines.get(key)
        if series is None or len(series) != len(candidate_returns) or float(np.std(series, ddof=1)) <= 0.0:
            corrs[key] = None
            per_base_marginal[key] = None
            continue
        active_series.append(series)
        corrs[key] = pearson_corr(candidate_returns, series)
        base_sr = compute_series_metrics(series, np.zeros_like(series))["sharpe"]
        blend = (1.0 - sleeve_weight) * series + sleeve_weight * candidate_returns
        blend_sr = compute_series_metrics(blend, np.zeros_like(blend))["sharpe"]
        if base_sr is not None and blend_sr is not None:
            per_base_marginal[key] = blend_sr - base_sr
        else:
            per_base_marginal[key] = None

    valid_corrs = [abs(v) for v in corrs.values() if v is not None]
    max_abs_corr = max(valid_corrs) if valid_corrs else 0.0
    corr_penalty = corr_penalty_weight * max(0.0, max_abs_corr - corr_free_threshold)

    marginal_sharpe = 0.0
    if active_series:
        composite_base = np.mean(np.stack(active_series, axis=0), axis=0)
        base_sr = compute_series_metrics(composite_base, np.zeros_like(composite_base))["sharpe"]
        blend = (1.0 - sleeve_weight) * composite_base + sleeve_weight * candidate_returns
        blend_sr = compute_series_metrics(blend, np.zeros_like(blend))["sharpe"]
        if base_sr is not None and blend_sr is not None:
            marginal_sharpe = blend_sr - base_sr

    return {
        "correlations": corrs,
        "maxAbsCorrelation": max_abs_corr,
        "correlationPenalty": corr_penalty,
        "marginalPortfolioSharpe": marginal_sharpe,
        "perBaselineMarginalSharpe": per_base_marginal,
    }


def resolve_device(requested: str = "auto") -> tuple[str, Any]:
    """Select CUDA/XLA PyTorch accelerator when available, else NumPy CPU."""
    if requested == "cpu":
        return "numpy-cpu", None
    if requested == "cuda":
        if torch is None:
            raise RuntimeError("CUDA requested via --device cuda, but PyTorch is not installed")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested via --device cuda, but torch.cuda.is_available() is False")
        return "cuda", torch.device("cuda")
    if requested != "auto":
        raise ValueError(f"Unsupported device request: {requested!r}")
    if torch is None:
        return "numpy-cpu", None
    if torch.cuda.is_available():
        return "cuda", torch.device("cuda")
    try:  # pragma: no cover - Google Colab TPU runtime
        import torch_xla.core.xla_model as xm  # type: ignore[import-not-found]

        return "xla", xm.xla_device()
    except ImportError:
        return "numpy-cpu", None


def default_parameter_grid(n_assets: int) -> list[CandidateParams]:
    """Deterministic grid of causal cross-sectional momentum / vol-scaled parameters."""
    top_k_levels = sorted({max(1, min(k, n_assets)) for k in (2, 4, 6)})
    grid: list[CandidateParams] = []
    for lookback in (21, 63, 126):
        for vol_window in (20, 60):
            for entry_z in (0.0, 0.5, 1.0):
                for cadence in (5, 21):
                    for top_k in top_k_levels:
                        for target_vol in (0.08, 0.12):
                            grid.append(
                                CandidateParams(
                                    lookback_days=lookback,
                                    vol_window_days=vol_window,
                                    entry_z_score=entry_z,
                                    rebalance_cadence_days=cadence,
                                    top_k=top_k,
                                    target_vol=target_vol,
                                    long_only=True,
                                )
                            )
    return grid


@dataclass(frozen=True)
class PrecomputedFeatures:
    close_valid: np.ndarray  # shape (T, A), bool
    mom: dict[int, np.ndarray]
    mom_valid: dict[int, np.ndarray]
    vol: dict[int, np.ndarray]
    vol_valid: dict[int, np.ndarray]


def _precompute_features(
    closes: np.ndarray,
    returns: np.ndarray,
    lookbacks: set[int],
    vol_windows: set[int],
) -> PrecomputedFeatures:
    """Precompute causal rolling momentum, trailing volatility, and strict validity masks."""
    t_len, a_len = closes.shape
    close_valid = np.isfinite(closes) & (closes > 0.0)
    ret_valid = np.zeros((t_len, a_len), dtype=bool)
    if t_len > 1:
        ret_valid[1:] = close_valid[:-1] & close_valid[1:]

    csum_close = np.vstack([np.zeros((1, a_len), dtype=np.int64), np.cumsum(close_valid.astype(np.int64), axis=0)])
    csum_ret_valid = np.vstack([np.zeros((1, a_len), dtype=np.int64), np.cumsum(ret_valid.astype(np.int64), axis=0)])
    clean_returns = np.where(ret_valid, returns, 0.0)
    csum_r = np.vstack([np.zeros((1, a_len), dtype=np.float64), np.cumsum(clean_returns, axis=0)])
    csum_r2 = np.vstack([np.zeros((1, a_len), dtype=np.float64), np.cumsum(clean_returns * clean_returns, axis=0)])

    mom_cache: dict[int, np.ndarray] = {}
    mom_valid_cache: dict[int, np.ndarray] = {}
    for lb in sorted(lookbacks):
        mom = np.full((t_len, a_len), np.nan, dtype=np.float64)
        mom_valid = np.zeros((t_len, a_len), dtype=bool)
        if lb >= 1 and lb < t_len:
            past = closes[:-lb]
            curr = closes[lb:]
            full_window = (csum_close[lb + 1 :] - csum_close[: t_len - lb]) == (lb + 1)
            valid = full_window & np.isfinite(past) & np.isfinite(curr) & (past > 0.0) & (curr > 0.0)
            mom_valid[lb:] = valid
            mom[lb:] = np.where(valid, curr / past - 1.0, np.nan)
        mom_cache[lb] = mom
        mom_valid_cache[lb] = mom_valid

    vol_cache: dict[int, np.ndarray] = {}
    vol_valid_cache: dict[int, np.ndarray] = {}
    for vw in sorted(vol_windows):
        vol = np.full((t_len, a_len), np.nan, dtype=np.float64)
        vol_valid = np.zeros((t_len, a_len), dtype=bool)
        if vw >= 2 and vw < t_len:
            full_window = (csum_ret_valid[vw:] - csum_ret_valid[:-vw]) == vw
            window_mean = (csum_r[vw:] - csum_r[:-vw]) / float(vw)
            window_var = np.maximum(
                0.0,
                (csum_r2[vw:] - csum_r2[:-vw] - float(vw) * window_mean * window_mean) / float(vw - 1),
            )
            ann_vol = np.sqrt(window_var * ANNUAL_SESSIONS)
            # Align strictly causally: window [t - vw + 1 .. t] uses vw valid returns up to close of day t.
            vol_valid[vw - 1 :] = full_window
            vol[vw - 1 :] = np.where(full_window, np.maximum(0.04, ann_vol), np.nan)
        vol_cache[vw] = vol
        vol_valid_cache[vw] = vol_valid

    return PrecomputedFeatures(
        close_valid=close_valid,
        mom=mom_cache,
        mom_valid=mom_valid_cache,
        vol=vol_cache,
        vol_valid=vol_valid_cache,
    )


def _build_candidate_weights(
    params: CandidateParams,
    mom: np.ndarray,
    vol: np.ndarray,
    valid_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Build causal scheduled target weights W_target[t, a] and rebalance_mask[t].

    Assets failing valid_mask (missing price, incomplete momentum lookback, or incomplete
    volatility window) are excluded from cross-sectional z-scoring, ranking, and weighting.
    Between rebalance dates, weights drift according to realized returns in
    _evaluate_weights_vectorized rather than being silently rebalanced daily.
    """
    t_len, a_len = mom.shape
    target_weights = np.zeros((t_len, a_len), dtype=np.float64)
    rebalance_mask = np.zeros(t_len, dtype=bool)
    warmup = max(params.lookback_days, params.vol_window_days)
    if warmup >= t_len:
        return target_weights, rebalance_mask

    if valid_mask is None:
        mask = np.isfinite(mom) & np.isfinite(vol) & (vol > 0.0)
    else:
        mask = valid_mask & np.isfinite(mom) & np.isfinite(vol) & (vol > 0.0)

    # Cross-sectional z-score of risk-adjusted momentum strictly over valid assets at each date.
    safe_vol = np.where(mask, np.maximum(vol, 0.04), 1.0)
    raw_score = np.where(mask, mom / safe_vol, 0.0)
    valid_count = np.sum(mask, axis=1, keepdims=True).astype(np.float64)
    safe_count = np.where(valid_count > 0.0, valid_count, 1.0)
    row_mean = np.sum(raw_score, axis=1, keepdims=True) / safe_count
    centered = np.where(mask, raw_score - row_mean, 0.0)
    row_var = np.sum(centered * centered, axis=1, keepdims=True) / safe_count
    row_std = np.sqrt(row_var)
    safe_std = np.where(row_std > 1e-12, row_std, 1.0)
    z_scores = np.where(mask, np.where(row_std > 1e-12, centered / safe_std, 0.0), np.nan)

    for t in range(warmup, t_len):
        if (t - warmup) % params.rebalance_cadence_days == 0:
            rebalance_mask[t] = True
            scores_t = z_scores[t]
            eligible = np.flatnonzero(mask[t] & np.isfinite(scores_t) & (scores_t >= params.entry_z_score))
            if len(eligible) > 0:
                order = eligible[np.argsort(-scores_t[eligible], kind="mergesort")]
                chosen = order[: params.top_k]
                inv_vol = 1.0 / np.maximum(vol[t, chosen], 0.04)
                base_w = inv_vol / float(np.sum(inv_vol))
                # Volatility scaling capped at 1.0x gross leverage (no unmodeled margin).
                port_vol = float(np.sqrt(np.sum((base_w * vol[t, chosen]) ** 2)))
                scale = min(1.0, params.target_vol / max(port_vol, 0.04))
                target_weights[t, chosen] = base_w * scale
    return target_weights, rebalance_mask


def _evaluate_weights_vectorized(
    target_weights_stack: np.ndarray,  # (M, T, A)
    rebalance_masks: np.ndarray,  # (M, T) bool
    asset_returns: np.ndarray,  # (T, A)
    cost_bps: tuple[int, ...],
    backend: str,
    device: Any,
    *,
    return_realized_weights: bool = False,
) -> tuple[np.ndarray, np.ndarray] | tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Simulate drifted portfolio weights, one-way turnover, and net returns (M, C, T).

    Between scheduled rebalance dates, end-of-day weights drift with realized returns:
        w_post = w_t * (1 + r_t) / (1 + sum(w_t * r_t))
    with implied cash weight c_post = (1 - sum(w_t)) / (1 + sum(w_t * r_t)).
    On rebalance dates, one-way turnover is measured against the drifted end-of-day
    weights: 0.5 * sum(|w_target - w_drifted|), charging true drift restoration costs.
    """
    m_count, t_len, a_len = target_weights_stack.shape
    c_count = len(cost_bps)
    if backend in ("cuda", "xla") and torch is not None and device is not None:  # pragma: no cover - GPU path
        with torch.no_grad():
            targets_t = torch.as_tensor(target_weights_stack, dtype=torch.float64, device=device)
            reb_t = torch.as_tensor(rebalance_masks, dtype=torch.bool, device=device)
            r_t = torch.as_tensor(asset_returns, dtype=torch.float64, device=device)
            w_curr = torch.zeros((m_count, a_len), dtype=torch.float64, device=device)
            gross = torch.zeros((m_count, t_len), dtype=torch.float64, device=device)
            turnover = torch.zeros((m_count, t_len), dtype=torch.float64, device=device)
            realized = (
                torch.zeros((m_count, t_len, a_len), dtype=torch.float64, device=device)
                if return_realized_weights
                else None
            )
            for t in range(t_len):
                ret_day = r_t[t]
                g_day = torch.sum(w_curr * ret_day[None, :], dim=-1)
                gross[:, t] = g_day
                denom = 1.0 + g_day
                safe_denom = torch.where(denom > 1e-12, denom, torch.ones_like(denom))
                w_drifted = torch.where(
                    (denom > 1e-12)[:, None],
                    w_curr * (1.0 + ret_day[None, :]) / safe_denom[:, None],
                    torch.zeros_like(w_curr),
                )
                is_reb = reb_t[:, t]
                target_day = targets_t[:, t, :]
                day_turnover = 0.5 * torch.sum(torch.abs(target_day - w_drifted), dim=-1)
                turnover[:, t] = torch.where(is_reb, day_turnover, torch.zeros_like(day_turnover))
                w_curr = torch.where(is_reb[:, None], target_day, w_drifted)
                if realized is not None:
                    realized[:, t, :] = w_curr
            costs = torch.tensor([bp / 10_000.0 for bp in cost_bps], dtype=torch.float64, device=device)
            net = gross[:, None, :] - costs[None, :, None] * turnover[:, None, :]
            if realized is not None:
                return net.cpu().numpy(), turnover.cpu().numpy(), realized.cpu().numpy()
            return net.cpu().numpy(), turnover.cpu().numpy()

    w_curr = np.zeros((m_count, a_len), dtype=np.float64)
    gross = np.zeros((m_count, t_len), dtype=np.float64)
    turnover = np.zeros((m_count, t_len), dtype=np.float64)
    realized_np = np.zeros((m_count, t_len, a_len), dtype=np.float64) if return_realized_weights else None

    for t in range(t_len):
        ret_day = asset_returns[t]
        g_day = np.sum(w_curr * ret_day[None, :], axis=-1)
        gross[:, t] = g_day
        denom = 1.0 + g_day
        safe_denom = np.where(denom > 1e-12, denom, 1.0)
        w_drifted = np.where(
            (denom > 1e-12)[:, None],
            w_curr * (1.0 + ret_day[None, :]) / safe_denom[:, None],
            0.0,
        )
        is_reb = rebalance_masks[:, t]
        target_day = target_weights_stack[:, t, :]
        day_turnover = 0.5 * np.sum(np.abs(target_day - w_drifted), axis=-1)
        turnover[:, t] = np.where(is_reb, day_turnover, 0.0)
        w_curr = np.where(is_reb[:, None], target_day, w_drifted)
        if realized_np is not None:
            realized_np[:, t, :] = w_curr

    costs = np.array([bp / 10_000.0 for bp in cost_bps], dtype=np.float64)
    net = gross[:, None, :] - costs[None, :, None] * turnover[:, None, :]
    assert net.shape == (m_count, c_count, t_len)
    if realized_np is not None:
        return net, turnover, realized_np
    return net, turnover


def compute_plateau_scores(
    candidates: list[CandidateParams],
    point_sharpes: list[float],
) -> list[dict[str, Any]]:
    """Compute median neighborhood Sharpe (L1 distance <= 1 in grid index space) for each candidate."""
    axes = (
        sorted({c.lookback_days for c in candidates}),
        sorted({c.vol_window_days for c in candidates}),
        sorted({c.entry_z_score for c in candidates}),
        sorted({c.rebalance_cadence_days for c in candidates}),
        sorted({c.top_k for c in candidates}),
        sorted({c.target_vol for c in candidates}),
        sorted({c.long_only for c in candidates}),
    )
    coords: list[tuple[int, ...]] = [
        (
            axes[0].index(c.lookback_days),
            axes[1].index(c.vol_window_days),
            axes[2].index(c.entry_z_score),
            axes[3].index(c.rebalance_cadence_days),
            axes[4].index(c.top_k),
            axes[5].index(c.target_vol),
            axes[6].index(c.long_only),
        )
        for c in candidates
    ]

    results: list[dict[str, Any]] = []
    for i, coord_i in enumerate(coords):
        neighborhood: list[float] = []
        for j, coord_j in enumerate(coords):
            l1 = sum(abs(a - b) for a, b in zip(coord_i, coord_j, strict=True))
            if l1 <= 1 and math.isfinite(point_sharpes[j]):
                neighborhood.append(point_sharpes[j])
        med = float(statistics.median(neighborhood)) if neighborhood else float("nan")
        pt = point_sharpes[i]
        results.append(
            {
                "medianNeighborSharpe": med if math.isfinite(med) else None,
                "neighborCount": len(neighborhood),
                "pointSharpe": pt if math.isfinite(pt) else None,
                "plateauSpread": (pt - med) if (math.isfinite(pt) and math.isfinite(med)) else None,
            }
        )
    return results


def _annualized_sharpe(series: np.ndarray) -> float | None:
    if len(series) < 2 or not np.all(np.isfinite(series)):
        return None
    std = float(np.std(series, ddof=1))
    if not math.isfinite(std) or std <= 0.0:
        return None
    return float(np.mean(series)) / std * math.sqrt(ANNUAL_SESSIONS)


def run_cpcv_sweep(
    cube: DevCubeData,
    *,
    candidates: list[CandidateParams] | None = None,
    n_groups: int = 6,
    k_test_groups: int = 2,
    purge_sessions: int = 20,
    embargo_sessions: int = 5,
    device_request: str = "auto",
    top_n: int = 5,
    git_sha: str | None = None,
    cost_bps: tuple[int, ...] = COST_SURFACE_BPS,
    selection_cost_bp: int = 5,
    stress_cost_bp: int = 10,
) -> dict[str, Any]:
    """Run vectorized Purged CPCV sweep across all candidates and emit a compact receipt."""
    if selection_cost_bp not in cost_bps or stress_cost_bp not in cost_bps:
        raise ValueError("selection_cost_bp and stress_cost_bp must be included in cost_bps")

    backend, device = resolve_device(device_request)
    grid = candidates if candidates is not None else default_parameter_grid(len(cube.symbols))
    if not grid:
        raise ValueError("Parameter grid must not be empty")

    splits = generate_cpcv_splits(
        n_sessions=len(cube.dates),
        n_groups=n_groups,
        k_test_groups=k_test_groups,
        purge_sessions=purge_sessions,
        embargo_sessions=embargo_sessions,
    )

    features = _precompute_features(
        cube.closes,
        cube.returns,
        {c.lookback_days for c in grid},
        {c.vol_window_days for c in grid},
    )

    target_weights_list: list[np.ndarray] = []
    rebalance_masks_list: list[np.ndarray] = []
    for c in grid:
        valid_mask = features.close_valid & features.mom_valid[c.lookback_days] & features.vol_valid[c.vol_window_days]
        t_w, r_m = _build_candidate_weights(
            c,
            features.mom[c.lookback_days],
            features.vol[c.vol_window_days],
            valid_mask=valid_mask,
        )
        target_weights_list.append(t_w)
        rebalance_masks_list.append(r_m)

    target_weights_stack = np.stack(target_weights_list, axis=0)
    rebalance_masks = np.stack(rebalance_masks_list, axis=0)
    net_returns, turnover = _evaluate_weights_vectorized(
        target_weights_stack,
        rebalance_masks,
        cube.returns,
        cost_bps,
        backend,
        device,
    )

    sel_idx = cost_bps.index(selection_cost_bp)
    stress_idx = cost_bps.index(stress_cost_bp)
    n_trials = len(grid)
    n_splits = len(splits)
    candidate_ids = [c.candidate_id() for c in grid]

    # Cross-sectional daily Sharpe dispersion across all N trials at selection & stress costs for DSR.
    def daily_sharpes_at(c_idx: int) -> np.ndarray:
        series = net_returns[:, c_idx, :]
        means = np.mean(series, axis=1)
        stds = np.std(series, axis=1, ddof=1)
        return np.where(stds > 0.0, means / stds, 0.0)

    sel_daily_sharpes = daily_sharpes_at(sel_idx)
    stress_daily_sharpes = daily_sharpes_at(stress_idx)
    sel_sr_std = float(np.std(sel_daily_sharpes, ddof=1)) if n_trials >= 2 else 0.0
    stress_sr_std = float(np.std(stress_daily_sharpes, ddof=1)) if n_trials >= 2 else 0.0

    # Compute per-split in-sample train Sharpes (strictly on purged/embargoed train_indices)
    # and out-of-sample test Sharpes (strictly on test_indices) for every candidate & cost.
    train_sharpes = np.full((len(cost_bps), n_splits, n_trials), np.nan, dtype=np.float64)
    test_sharpes = np.full((len(cost_bps), n_splits, n_trials), np.nan, dtype=np.float64)

    cpcv_summary: list[dict[str, dict[str, float | None]]] = []
    selection_cpcv_sharpes: list[float] = []
    selection_train_sharpes: list[float | None] = []
    stress_cpcv_sharpes: list[float] = []
    dsr_records: list[dict[str, float | int | None]] = []
    baseline_records: list[dict[str, Any]] = []

    for i in range(n_trials):
        by_cost: dict[str, dict[str, float | None]] = {}
        for c_i, bp in enumerate(cost_bps):
            r_series = net_returns[i, c_i]
            t_series = turnover[i]
            full_metrics = compute_series_metrics(r_series, t_series)
            fold_train_sharpes: list[float] = []
            fold_test_sharpes: list[float] = []
            for s_i, sp in enumerate(splits):
                tr_sr = _annualized_sharpe(r_series[sp.train_indices])
                if tr_sr is not None:
                    train_sharpes[c_i, s_i, i] = tr_sr
                    fold_train_sharpes.append(tr_sr)
                te_sr = _annualized_sharpe(r_series[sp.test_indices])
                if te_sr is not None:
                    test_sharpes[c_i, s_i, i] = te_sr
                    fold_test_sharpes.append(te_sr)
            by_cost[str(bp)] = {
                **full_metrics,
                "cpcvTrainMeanSharpe": float(np.mean(fold_train_sharpes)) if fold_train_sharpes else None,
                "cpcvTrainMedianSharpe": float(statistics.median(fold_train_sharpes)) if fold_train_sharpes else None,
                "cpcvTrainMinSharpe": float(min(fold_train_sharpes)) if fold_train_sharpes else None,
                "cpcvMeanSharpe": float(np.mean(fold_test_sharpes)) if fold_test_sharpes else None,
                "cpcvMedianSharpe": float(statistics.median(fold_test_sharpes)) if fold_test_sharpes else None,
                "cpcvMinSharpe": float(min(fold_test_sharpes)) if fold_test_sharpes else None,
            }
        cpcv_summary.append(by_cost)

        sel_med = by_cost[str(selection_cost_bp)]["cpcvMedianSharpe"]
        sel_train_med = by_cost[str(selection_cost_bp)]["cpcvTrainMedianSharpe"]
        stress_med = by_cost[str(stress_cost_bp)]["cpcvMedianSharpe"]
        selection_cpcv_sharpes.append(sel_med if sel_med is not None else float("-inf"))
        selection_train_sharpes.append(sel_train_med)
        stress_cpcv_sharpes.append(stress_med if stress_med is not None else float("-inf"))

        dsr_sel, sr0_sel = deflated_sharpe_ratio(net_returns[i, sel_idx], n_trials, sel_sr_std)
        dsr_stress, _ = deflated_sharpe_ratio(net_returns[i, stress_idx], n_trials, stress_sr_std)
        dsr_records.append(
            {
                "dsr5bp": dsr_sel,
                "dsr10bp": dsr_stress,
                "expectedMaxDailySharpe5bp": sr0_sel,
                "trialsTested": n_trials,
            }
        )
        baseline_records.append(marginal_portfolio_metrics(net_returns[i, sel_idx], cube.baselines))

    # On each CPCV split, rank and select the winner strictly on purged/embargoed train_indices,
    # then evaluate the train-selected winner strictly on test_indices (PBO & OOS rank degradation).
    train_selection_counts = [0] * n_trials
    candidate_train_ranks: list[list[float]] = [[] for _ in range(n_trials)]
    winner_train_sharpes: list[float] = []
    winner_test_sharpes: list[float] = []
    winner_stress_test_sharpes: list[float] = []
    winner_sharpe_degradations: list[float] = []
    split_omegas: list[float] = []
    split_logits: list[float] = []
    split_rank_degradations: list[float] = []
    split_selections: list[dict[str, Any]] = []

    for s_i, sp in enumerate(splits):
        tr_row = train_sharpes[sel_idx, s_i, :]
        te_row = test_sharpes[sel_idx, s_i, :]
        te_stress_row = test_sharpes[stress_idx, s_i, :]

        valid_tr = np.flatnonzero(np.isfinite(tr_row))
        if len(valid_tr) == 0:
            split_selections.append(
                {
                    "splitId": sp.split_id,
                    "testGroups": list(sp.test_groups),
                    "trainSessions": int(len(sp.train_indices)),
                    "testSessions": int(len(sp.test_indices)),
                    "purgedSessions": int(len(sp.purged_indices)),
                    "embargoedSessions": int(len(sp.embargoed_indices)),
                    "trainWinnerId": None,
                    "trainWinnerTrainSharpe": None,
                    "trainWinnerTestSharpe": None,
                    "oosRelativeRank": None,
                    "oosRankDegradation": None,
                }
            )
            continue

        # In-sample ranking strictly from purged/embargoed train_indices (1 = best).
        tr_safe = np.where(np.isfinite(tr_row), tr_row, float("-inf"))
        for i in range(n_trials):
            greater = int(np.sum(tr_safe > tr_safe[i]))
            equal = int(np.sum(tr_safe == tr_safe[i]))
            candidate_train_ranks[i].append(greater + 0.5 * (equal + 1.0))

        # Deterministic selection of train-only winner (tie-break by candidateId).
        winner_idx = min(valid_tr.tolist(), key=lambda idx: (-float(tr_row[idx]), candidate_ids[idx]))
        train_selection_counts[winner_idx] += 1

        w_train_sr = float(tr_row[winner_idx])
        w_test_sr = float(te_row[winner_idx]) if math.isfinite(te_row[winner_idx]) else None
        w_stress_sr = float(te_stress_row[winner_idx]) if math.isfinite(te_stress_row[winner_idx]) else None
        winner_train_sharpes.append(w_train_sr)
        if w_test_sr is not None:
            winner_test_sharpes.append(w_test_sr)
            winner_sharpe_degradations.append(w_train_sr - w_test_sr)
        if w_stress_sr is not None:
            winner_stress_test_sharpes.append(w_stress_sr)

        omega_bar: float | None = None
        rank_deg: float | None = None
        if n_trials >= 2 and w_test_sr is not None:
            oos_safe = np.where(np.isfinite(te_row), te_row, float("-inf"))
            less = int(np.sum(oos_safe < w_test_sr))
            equal = int(np.sum(oos_safe == w_test_sr))
            rank_1_based = less + 0.5 * (equal + 1.0)
            omega_bar = rank_1_based / float(n_trials + 1)
            logit = math.log(omega_bar / (1.0 - omega_bar))
            rank_deg = 1.0 - (rank_1_based - 1.0) / float(n_trials - 1)
            split_omegas.append(omega_bar)
            split_logits.append(logit)
            split_rank_degradations.append(rank_deg)

        split_selections.append(
            {
                "splitId": sp.split_id,
                "testGroups": list(sp.test_groups),
                "trainSessions": int(len(sp.train_indices)),
                "testSessions": int(len(sp.test_indices)),
                "purgedSessions": int(len(sp.purged_indices)),
                "embargoedSessions": int(len(sp.embargoed_indices)),
                "trainWinnerId": candidate_ids[winner_idx],
                "trainWinnerTrainSharpe": w_train_sr,
                "trainWinnerTestSharpe": w_test_sr,
                "oosRelativeRank": omega_bar,
                "oosRankDegradation": rank_deg,
            }
        )

    pbo = (sum(1 for w in split_omegas if w < 0.5) / float(len(split_omegas))) if split_omegas else None

    plateau_info = compute_plateau_scores(grid, selection_cpcv_sharpes)

    # Composite ranking favors plateau-robust, train-consistent, DSR-surviving, stress-resilient, decorrelated sleeves.
    scored_indices: list[tuple[float, int]] = []
    composite_scores: list[float] = []
    for i in range(n_trials):
        p_med = plateau_info[i]["medianNeighborSharpe"]
        s_med = stress_cpcv_sharpes[i]
        train_med = selection_train_sharpes[i]
        sel_med = selection_cpcv_sharpes[i]
        dsr_val = dsr_records[i]["dsr5bp"]
        b_rec = baseline_records[i]
        if p_med is None or not math.isfinite(s_med) or train_med is None:
            score = -1e9
        else:
            dsr_factor = float(dsr_val) if isinstance(dsr_val, float) and math.isfinite(dsr_val) else 0.0
            overfit_gap = max(0.0, train_med - sel_med) if math.isfinite(sel_med) else 0.0
            score = (
                0.45 * p_med
                + 0.15 * train_med
                + 0.25 * s_med
                + 0.20 * dsr_factor
                + 0.35 * float(b_rec["marginalPortfolioSharpe"])
                - float(b_rec["correlationPenalty"])
                - 0.15 * overfit_gap
            )
        composite_scores.append(score)
        scored_indices.append((score, i))

    scored_indices.sort(key=lambda item: (-item[0], candidate_ids[item[1]]))
    top_candidates: list[dict[str, Any]] = []
    for rank, (score, idx) in enumerate(scored_indices[: max(1, top_n)], start=1):
        tr_med = selection_train_sharpes[idx]
        te_med = cpcv_summary[idx][str(selection_cost_bp)]["cpcvMedianSharpe"]
        top_candidates.append(
            {
                "rank": rank,
                "candidateId": candidate_ids[idx],
                "parameters": grid[idx].to_dict(),
                "plateau": {
                    **plateau_info[idx],
                    "compositeScore": score,
                },
                "cpcvSelection": {
                    "trainSelectionCount": int(train_selection_counts[idx]),
                    "trainSelectionFrequency": float(train_selection_counts[idx]) / float(n_splits),
                    "meanTrainRank": (
                        float(np.mean(candidate_train_ranks[idx])) if candidate_train_ranks[idx] else None
                    ),
                    "trainMedianSharpe5bp": tr_med,
                    "testMedianSharpe5bp": te_med,
                    "sharpeDegradation5bp": (tr_med - te_med) if (tr_med is not None and te_med is not None) else None,
                },
                "dsr": dsr_records[idx],
                "baselines": baseline_records[idx],
                "costSurface": cpcv_summary[idx],
            }
        )

    receipt: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION_RECEIPT,
        "gitSha": git_sha or cube.source_commit,
        "devCubeSha256": cube.dev_cube_sha256,
        "devCutoff": cube.dev_cutoff,
        "excludedHoldoutStart": cube.excluded_holdout_start,
        "computeBackend": backend,
        "sessions": len(cube.dates),
        "symbols": list(cube.symbols),
        "cpcv": {
            "nGroups": n_groups,
            "kTestGroups": k_test_groups,
            "nSplits": n_splits,
            "purgeSessions": purge_sessions,
            "embargoSessions": embargo_sessions,
            "meanTrainSessions": float(np.mean([len(sp.train_indices) for sp in splits])),
            "meanTestSessions": float(np.mean([len(sp.test_indices) for sp in splits])),
            "meanPurgedSessions": float(np.mean([len(sp.purged_indices) for sp in splits])),
            "meanEmbargoedSessions": float(np.mean([len(sp.embargoed_indices) for sp in splits])),
            "pbo": pbo,
            "medianLogit": float(statistics.median(split_logits)) if split_logits else None,
            "meanOosRelativeRank": float(np.mean(split_omegas)) if split_omegas else None,
            "meanOosRankDegradation": (
                float(np.mean(split_rank_degradations)) if split_rank_degradations else None
            ),
            "selectedWinnerTrainMeanSharpe": (
                float(np.mean(winner_train_sharpes)) if winner_train_sharpes else None
            ),
            "selectedWinnerTrainMedianSharpe": (
                float(statistics.median(winner_train_sharpes)) if winner_train_sharpes else None
            ),
            "selectedWinnerTestMeanSharpe": (
                float(np.mean(winner_test_sharpes)) if winner_test_sharpes else None
            ),
            "selectedWinnerTestMedianSharpe": (
                float(statistics.median(winner_test_sharpes)) if winner_test_sharpes else None
            ),
            "selectedWinnerStressTestMedianSharpe": (
                float(statistics.median(winner_stress_test_sharpes)) if winner_stress_test_sharpes else None
            ),
            "selectedWinnerMeanSharpeDegradation": (
                float(np.mean(winner_sharpe_degradations)) if winner_sharpe_degradations else None
            ),
            "splitSelections": split_selections,
        },
        "trialsTested": n_trials,
        "costSurfaceBps": list(cost_bps),
        "topCandidates": top_candidates,
    }
    encoded = json.dumps(receipt, indent=2, sort_keys=False).encode("utf-8") + b"\n"
    if len(encoded) >= MAX_RECEIPT_BYTES:
        raise ReceiptSizeError(f"experiment_receipt.json exceeds {MAX_RECEIPT_BYTES} bytes: {len(encoded)}")
    return receipt


def write_receipt(receipt: dict[str, Any], out_path: Path) -> int:
    payload = (json.dumps(receipt, indent=2) + "\n").encode("utf-8")
    if len(payload) >= MAX_RECEIPT_BYTES:
        raise ReceiptSizeError(f"experiment_receipt.json exceeds {MAX_RECEIPT_BYTES} bytes: {len(payload)}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(payload)
    return len(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bayn Dev-Split GPU/CPU Purged CPCV & Cost-Surface Sweep Engine")
    parser.add_argument("--cube-dir", type=Path, required=True, help="Directory containing dev cube + MANIFEST.json")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("experiment_receipt.json"),
        help="Output path for compact <50 KB experiment_receipt.json",
    )
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--groups", type=int, default=6, help="Number of CPCV chronological blocks (N)")
    parser.add_argument("--test-groups", type=int, default=2, help="Number of CPCV test blocks per split (k)")
    parser.add_argument("--purge", type=int, default=20, help="Purged sessions immediately before each test block")
    parser.add_argument("--embargo", type=int, default=5, help="Embargo sessions immediately after each test block")
    parser.add_argument("--top-n", type=int, default=5, help="Number of top plateau candidates in receipt")
    parser.add_argument("--git-sha", type=str, default=None, help="Override git commit SHA recorded in receipt")
    args = parser.parse_args(argv)

    cube = verify_and_load_dev_cube(args.cube_dir)
    receipt = run_cpcv_sweep(
        cube,
        n_groups=args.groups,
        k_test_groups=args.test_groups,
        purge_sessions=args.purge,
        embargo_sessions=args.embargo,
        device_request=args.device,
        top_n=args.top_n,
        git_sha=args.git_sha,
    )
    byte_count = write_receipt(receipt, args.out)
    print(
        json.dumps(
            {
                "schemaVersion": receipt["schemaVersion"],
                "out": str(args.out),
                "bytes": byte_count,
                "computeBackend": receipt["computeBackend"],
                "trialsTested": receipt["trialsTested"],
                "topCandidate": receipt["topCandidates"][0]["candidateId"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
