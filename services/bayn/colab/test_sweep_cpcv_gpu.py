"""Deterministic unit tests for Bayn's GPU/CPU Purged CPCV & Cost-Surface Sweep Engine."""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sweep_cpcv_gpu as engine  # noqa: E402


def _make_business_dates(count: int, start: dt.date = dt.date(2022, 1, 3)) -> list[str]:
    dates: list[str] = []
    cur = start
    while len(dates) < count:
        if cur.weekday() < 5:
            dates.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return dates


def _write_synthetic_cube(
    cube_dir: Path,
    *,
    n_sessions: int = 240,
    fmt: str = "jsonl.gz",
    dev_cutoff: str = "2023-12-29",
    extra_daily_rows: list[dict[str, object]] | None = None,
    include_baselines: bool = True,
    seed: int = 42,
) -> Path:
    rng = np.random.default_rng(seed)
    dates = _make_business_dates(n_sessions)
    symbols = ("SPY", "QQQ", "TLT", "GLD")
    drifts = {"SPY": 0.0004, "QQQ": 0.0007, "TLT": -0.0001, "GLD": 0.0003}
    vols = {"SPY": 0.010, "QQQ": 0.014, "TLT": 0.009, "GLD": 0.008}

    prices = {s: 100.0 for s in symbols}
    daily_rows: list[dict[str, object]] = []
    baseline_rows: list[dict[str, object]] = []
    for i, d in enumerate(dates):
        # Induce realistic autocorrelated regime drift so momentum candidates show positive signal.
        regime = 1.0 if (i // 45) % 2 == 0 else -0.4
        for s in symbols:
            ret = drifts[s] * (1.5 if s in ("QQQ", "GLD") else 1.0) * regime + vols[s] * float(rng.standard_normal())
            prices[s] = max(1.0, prices[s] * (1.0 + ret))
            p = round(prices[s], 4)
            daily_rows.append(
                {
                    "date": d,
                    "symbol": s,
                    "open": round(p * 0.999, 4),
                    "high": round(p * 1.005, 4),
                    "low": round(p * 0.995, 4),
                    "close": p,
                    "volume": 1_000_000,
                    "vwap": p,
                }
            )
        baseline_rows.append(
            {
                "date": d,
                "B0": float(0.0002 + 0.006 * rng.standard_normal()),
                "F4": float(0.0003 + 0.005 * rng.standard_normal()),
                "O1": float(0.00025 + 0.0055 * rng.standard_normal()),
            }
        )

    if extra_daily_rows:
        daily_rows.extend(extra_daily_rows)

    def write_gz(name: str, rows: list[dict[str, object]], cols: list[str]) -> dict[str, object]:
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
            if fmt == "jsonl.gz":
                text = "\n".join(json.dumps({c: r[c] for c in cols}) for r in rows) + "\n"
                gz.write(text.encode("utf-8"))
            else:
                sio = io.StringIO()
                writer = csv.DictWriter(sio, fieldnames=cols)
                writer.writeheader()
                for r in rows:
                    writer.writerow({c: r[c] for c in cols})
                gz.write(sio.getvalue().encode("utf-8"))
        raw = buf.getvalue()
        path = cube_dir / name
        path.write_bytes(raw)
        return {
            "kind": name.split(".")[0],
            "path": name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "rowCount": len(rows),
        }

    files = [
        write_gz(
            f"daily_bars.{fmt}",
            daily_rows,
            ["date", "symbol", "open", "high", "low", "close", "volume", "vwap"],
        )
    ]
    if include_baselines:
        files.append(write_gz(f"baseline_returns.{fmt}", baseline_rows, ["date", "B0", "F4", "O1"]))

    manifest = {
        "schemaVersion": engine.SCHEMA_VERSION_CUBE,
        "format": fmt,
        "devCutoff": dev_cutoff,
        "canonicalDevCutoff": engine.CANONICAL_DEV_CUTOFF,
        "excludedHoldoutStart": engine.CANONICAL_HOLDOUT_START,
        "sourceCommit": "b" * 40,
        "splits": {
            "train": {"first": "2016-01-04", "last": "2021-12-31", "count": 1511},
            "validation": {"first": "2022-01-03", "last": "2023-12-29", "count": 501},
        },
        "dateRange": {"first": dates[0], "last": dates[-1]},
        "symbols": list(symbols),
        "rowCount": sum(int(f["rowCount"]) for f in files),
        "files": files,
    }
    (cube_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return cube_dir


class SweepCpcvGpuTests(unittest.TestCase):
    def test_manifest_sha256_mismatch_is_rejected_before_reading(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cube_dir = _write_synthetic_cube(Path(tmp))
            bars_path = cube_dir / "daily_bars.jsonl.gz"
            original = bars_path.read_bytes()
            # Flip a byte in the compressed payload so SHA-256 fails.
            tampered = bytearray(original)
            tampered[-1] ^= 0xFF
            bars_path.write_bytes(bytes(tampered))

            with self.assertRaises(engine.CubeIntegrityError):
                engine.verify_and_load_dev_cube(cube_dir)

    def test_manifest_wrong_schema_version_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cube_dir = _write_synthetic_cube(Path(tmp))
            manifest_path = cube_dir / "MANIFEST.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["schemaVersion"] = "bayn.wrong.v0"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaises(engine.CubeIntegrityError):
                engine.verify_and_load_dev_cube(cube_dir)

    def test_holdout_date_in_manifest_or_data_rows_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cube_dir = _write_synthetic_cube(Path(tmp), dev_cutoff="2024-01-02")
            with self.assertRaises(engine.HoldoutLeakageError):
                engine.verify_and_load_dev_cube(cube_dir)

        with tempfile.TemporaryDirectory() as tmp:
            leaked_row = {
                "date": "2024-01-02",
                "symbol": "SPY",
                "open": 470.0,
                "high": 472.0,
                "low": 469.0,
                "close": 471.0,
                "volume": 1_000_000,
                "vwap": 470.5,
            }
            cube_dir = _write_synthetic_cube(Path(tmp), extra_daily_rows=[leaked_row])
            with self.assertRaises(engine.HoldoutLeakageError):
                engine.verify_and_load_dev_cube(cube_dir)

    def test_cpcv_purge_and_embargo_prevent_train_test_leakage(self) -> None:
        n_sessions = 300
        purge = 20
        embargo = 7
        splits = engine.generate_cpcv_splits(
            n_sessions=n_sessions,
            n_groups=6,
            k_test_groups=2,
            purge_sessions=purge,
            embargo_sessions=embargo,
        )
        # C(6, 2) = 15 combinatorial splits
        self.assertEqual(len(splits), 15)

        for sp in splits:
            train_set = set(sp.train_indices.tolist())
            test_set = set(sp.test_indices.tolist())
            purged_set = set(sp.purged_indices.tolist())
            embargo_set = set(sp.embargoed_indices.tolist())

            self.assertTrue(train_set.isdisjoint(test_set))
            self.assertTrue(train_set.isdisjoint(purged_set))
            self.assertTrue(train_set.isdisjoint(embargo_set))
            self.assertTrue(test_set.isdisjoint(purged_set))
            self.assertTrue(test_set.isdisjoint(embargo_set))

            # For every test index t, no train index may fall within [t - purge, t + embargo].
            for t in test_set:
                for tr in train_set:
                    if tr < t:
                        self.assertGreater(t - tr, purge)
                    else:
                        self.assertGreater(tr - t, embargo)

    def test_dsr_monotonically_decays_with_trial_count(self) -> None:
        rng = np.random.default_rng(7)
        returns = 0.0012 + 0.01 * rng.standard_normal(500)
        trial_std = 0.035

        dsr_values = []
        for n_trials in (2, 10, 50, 250, 2_000, 20_000):
            dsr, _ = engine.deflated_sharpe_ratio(returns, trials_tested=n_trials, trial_daily_sharpe_std=trial_std)
            self.assertIsNotNone(dsr)
            assert dsr is not None
            self.assertGreaterEqual(dsr, 0.0)
            self.assertLessEqual(dsr, 1.0)
            dsr_values.append(dsr)

        for earlier, later in zip(dsr_values, dsr_values[1:], strict=False):
            self.assertGreater(earlier, later)

    def test_cost_surface_monotonicity_on_nonzero_turnover(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cube = engine.verify_and_load_dev_cube(_write_synthetic_cube(Path(tmp), n_sessions=220))
            candidates = [
                engine.CandidateParams(
                    lookback_days=21,
                    vol_window_days=20,
                    entry_z_score=0.0,
                    rebalance_cadence_days=5,
                    top_k=2,
                    target_vol=0.12,
                )
            ]
            receipt = engine.run_cpcv_sweep(
                cube,
                candidates=candidates,
                n_groups=5,
                k_test_groups=2,
                purge_sessions=10,
                embargo_sessions=3,
                device_request="cpu",
                top_n=1,
            )
            surface = receipt["topCandidates"][0]["costSurface"]
            turnover = surface["2"]["dailyTurnover"]
            self.assertIsNotNone(turnover)
            self.assertGreater(turnover, 0.0)

            cagr_2 = surface["2"]["cagr"]
            cagr_5 = surface["5"]["cagr"]
            cagr_10 = surface["10"]["cagr"]
            cagr_15 = surface["15"]["cagr"]
            self.assertLessEqual(cagr_15, cagr_10)
            self.assertLessEqual(cagr_10, cagr_5)
            self.assertLessEqual(cagr_5, cagr_2)
            # Strictly lower on strictly positive turnover
            self.assertLess(cagr_10, cagr_5)
            self.assertLess(cagr_5, cagr_2)

    def test_plateau_scoring_prefers_stable_region_over_isolated_spike(self) -> None:
        # 5 grid points along lookback axis: isolated spike at index 0, broad plateau at indices 2,3,4
        grid = [
            engine.CandidateParams(lb, 20, 0.0, 5, 2, 0.10)
            for lb in (10, 20, 40, 60, 80)
        ]
        # Index 0 has spike 2.0 surrounded by 0.1 -> median(2.0, 0.1) = 1.05
        # Index 3 has 1.4 surrounded by 1.35 and 1.45 -> median(1.35, 1.4, 1.45) = 1.40
        sharpes = [2.0, 0.1, 1.35, 1.40, 1.45]
        plateaus = engine.compute_plateau_scores(grid, sharpes)
        self.assertGreater(plateaus[3]["medianNeighborSharpe"], plateaus[0]["medianNeighborSharpe"])

    def test_marginal_sharpe_and_correlation_penalty_prefer_decorrelated_sleeve(self) -> None:
        rng = np.random.default_rng(123)
        n = 400
        b0 = 0.0003 + 0.008 * rng.standard_normal(n)
        f4 = 0.0003 + 0.007 * rng.standard_normal(n)
        o1 = 0.00025 + 0.0075 * rng.standard_normal(n)
        baselines = {"B0": b0, "F4": f4, "O1": o1}

        correlated_clone = b0.copy()
        orthogonal = 0.0004 + 0.008 * rng.standard_normal(n)

        m_clone = engine.marginal_portfolio_metrics(correlated_clone, baselines)
        m_ortho = engine.marginal_portfolio_metrics(orthogonal, baselines)

        self.assertGreater(m_clone["correlationPenalty"], m_ortho["correlationPenalty"])
        self.assertGreater(m_ortho["marginalPortfolioSharpe"], m_clone["marginalPortfolioSharpe"])

    def test_end_to_end_receipt_generation_for_jsonl_and_csv_cubes(self) -> None:
        for fmt in ("jsonl.gz", "csv.gz"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cube_dir = _write_synthetic_cube(root, n_sessions=220, fmt=fmt)
                out_receipt = root / "experiment_receipt.json"
                exit_code = engine.main(
                    [
                        "--cube-dir",
                        str(cube_dir),
                        "--out",
                        str(out_receipt),
                        "--device",
                        "cpu",
                        "--groups",
                        "5",
                        "--test-groups",
                        "2",
                        "--purge",
                        "10",
                        "--embargo",
                        "3",
                        "--top-n",
                        "3",
                    ]
                )
                self.assertEqual(exit_code, 0)
                raw = out_receipt.read_bytes()
                self.assertLess(len(raw), engine.MAX_RECEIPT_BYTES)

                receipt = json.loads(raw.decode("utf-8"))
                self.assertEqual(receipt["schemaVersion"], engine.SCHEMA_VERSION_RECEIPT)
                self.assertEqual(receipt["devCutoff"], engine.CANONICAL_DEV_CUTOFF)
                self.assertEqual(receipt["excludedHoldoutStart"], engine.CANONICAL_HOLDOUT_START)
                self.assertEqual(receipt["computeBackend"], "numpy-cpu")
                self.assertEqual(receipt["costSurfaceBps"], [2, 5, 10, 15])
                self.assertEqual(receipt["gitSha"], "b" * 40)
                self.assertEqual(len(receipt["devCubeSha256"]), 64)
                self.assertEqual(len(receipt["topCandidates"]), 3)
                top = receipt["topCandidates"][0]
                for bp in ("2", "5", "10", "15"):
                    self.assertIn(bp, top["costSurface"])
                self.assertIn("lookbackDays", top["parameters"])
                self.assertIn("B0", top["baselines"]["correlations"])
                self.assertIn("F4", top["baselines"]["correlations"])
                self.assertIn("O1", top["baselines"]["correlations"])


if __name__ == "__main__":
    unittest.main()
