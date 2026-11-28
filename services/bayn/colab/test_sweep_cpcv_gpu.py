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
from types import SimpleNamespace
from unittest import mock

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
    drop_daily_keys: set[tuple[str, str]] | None = None,
    include_baselines: bool = True,
    baseline_cols: tuple[str, ...] = ("B0", "F4", "O1"),
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
            if drop_daily_keys is not None and (d, s) in drop_daily_keys:
                continue
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
    active_baseline_cols = list(baseline_cols) if include_baselines else []
    if include_baselines and active_baseline_cols:
        files.append(write_gz(f"baseline_returns.{fmt}", baseline_rows, ["date", *active_baseline_cols]))

    manifest = {
        "schemaVersion": engine.SCHEMA_VERSION_CUBE,
        "format": fmt,
        "devCutoff": dev_cutoff,
        "canonicalDevCutoff": engine.CANONICAL_DEV_CUTOFF,
        "excludedHoldoutStart": engine.CANONICAL_HOLDOUT_START,
        "sourceCommit": "b" * 40,
        "hasBaselines": bool(include_baselines and active_baseline_cols),
        "baselineSeries": active_baseline_cols,
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
                self.assertTrue(receipt["hasBaselines"])
                self.assertEqual(receipt["baselineSeries"], ["B0", "F4", "O1"])
                self.assertEqual(receipt["scoringMode"], engine.SCORING_MODE_MARGINAL)
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
                self.assertIn("pbo", receipt["cpcv"])
                self.assertIn("splitSelections", receipt["cpcv"])
                self.assertIn("cpcvSelection", top)

    def test_late_starting_asset_receives_zero_weight_before_valid_lookback_window(self) -> None:
        # 3 existing assets have steadily negative momentum; late-starting XLC has NaN early bars.
        # XLC must NEVER be ranked or assigned weight before its full lookback & vol windows exist.
        t_len = 80
        xlc_start = 40
        lookback = 10
        vol_window = 10
        closes = np.full((t_len, 4), np.nan, dtype=np.float64)
        for t in range(t_len):
            closes[t, 0] = 100.0 * (0.996**t)  # SPY falling
            closes[t, 1] = 100.0 * (0.994**t)  # QQQ falling faster
            closes[t, 2] = 100.0 * (0.998**t)  # TLT falling slower
            if t >= xlc_start:
                # Strong positive rally once XLC actually starts trading
                closes[t, 3] = 50.0 * (1.010 ** (t - xlc_start))

        returns = np.zeros((t_len, 4), dtype=np.float64)
        valid = np.isfinite(closes[:-1]) & np.isfinite(closes[1:]) & (closes[:-1] > 0.0)
        returns[1:] = np.where(valid, closes[1:] / closes[:-1] - 1.0, 0.0)

        features = engine._precompute_features(closes, returns, {lookback}, {vol_window})
        params = engine.CandidateParams(
            lookback_days=lookback,
            vol_window_days=vol_window,
            entry_z_score=0.0,
            rebalance_cadence_days=1,
            top_k=1,
            target_vol=0.12,
        )
        valid_mask = features.close_valid & features.mom_valid[lookback] & features.vol_valid[vol_window]
        target_w, reb_mask = engine._build_candidate_weights(
            params,
            features.mom[lookback],
            features.vol[vol_window],
            valid_mask=valid_mask,
        )

        # First valid day for XLC is xlc_start + max(lookback, vol_window) = 50.
        first_valid_xlc = xlc_start + max(lookback, vol_window)
        self.assertTrue(np.all(~valid_mask[:first_valid_xlc, 3]))
        self.assertTrue(np.all(valid_mask[first_valid_xlc:, 3]))
        self.assertTrue(np.all(target_w[:first_valid_xlc, 3] == 0.0))

        # After XLC has a full valid lookback and volatility window, its strong positive momentum wins.
        self.assertTrue(np.all(target_w[first_valid_xlc:, 3] > 0.0))

        # Verify simulated realized weights also remain strictly zero for XLC prior to first_valid_xlc.
        _, _, realized_w = engine._evaluate_weights_vectorized(
            target_w[None, :, :],
            reb_mask[None, :],
            returns,
            (5,),
            "numpy-cpu",
            None,
            return_realized_weights=True,
        )
        self.assertTrue(np.all(realized_w[0, :first_valid_xlc, 3] == 0.0))

    def test_weights_drift_between_rebalances_and_charge_drift_restoration_turnover(self) -> None:
        # 2-asset unequal-return path with partial cash (initial target [0.4, 0.4], cash 0.2).
        # Rebalance on day 0 and day 3 to the SAME target [0.4, 0.4].
        t_len = 4
        asset_returns = np.array(
            [
                [0.0, 0.0],
                [0.20, -0.10],
                [0.10, -0.05],
                [0.05, -0.05],
            ],
            dtype=np.float64,
        )
        targets = np.zeros((1, t_len, 2), dtype=np.float64)
        targets[0, 0] = [0.4, 0.4]
        targets[0, 3] = [0.4, 0.4]
        reb_masks = np.array([[True, False, False, True]], dtype=bool)

        cost_bp = 10
        net, turnover, realized = engine._evaluate_weights_vectorized(
            targets,
            reb_masks,
            asset_returns,
            (cost_bp,),
            "numpy-cpu",
            None,
            return_realized_weights=True,
        )

        # Hand-compute exact drifted trajectory day by day.
        w0 = np.array([0.4, 0.4])
        self.assertTrue(np.allclose(realized[0, 0], w0))
        self.assertAlmostEqual(float(turnover[0, 0]), 0.4, places=12)

        # Day 1 (non-rebalance): weights drift with returns and cash adjusts consistently.
        g1 = float(np.dot(w0, asset_returns[1]))
        w1 = w0 * (1.0 + asset_returns[1]) / (1.0 + g1)
        self.assertTrue(np.allclose(realized[0, 1], w1))
        self.assertAlmostEqual(1.0 - float(np.sum(realized[0, 1])), 0.2 / (1.0 + g1), places=12)
        self.assertEqual(float(turnover[0, 1]), 0.0)
        self.assertAlmostEqual(float(net[0, 0, 1]), g1, places=12)

        # Day 2 (non-rebalance): earns return on drifted w1 (not un-drifted w0!) and drifts to w2.
        g2 = float(np.dot(w1, asset_returns[2]))
        self.assertNotAlmostEqual(g2, float(np.dot(w0, asset_returns[2])), places=4)
        w2 = w1 * (1.0 + asset_returns[2]) / (1.0 + g2)
        self.assertTrue(np.allclose(realized[0, 2], w2))
        self.assertEqual(float(turnover[0, 2]), 0.0)
        self.assertAlmostEqual(float(net[0, 0, 2]), g2, places=12)

        # Day 3 (rebalance back to [0.4, 0.4]): drifts to w3_pre, then pays true drift restoration cost.
        g3 = float(np.dot(w2, asset_returns[3]))
        w3_drifted = w2 * (1.0 + asset_returns[3]) / (1.0 + g3)
        expected_turnover_3 = 0.5 * float(np.sum(np.abs(w0 - w3_drifted)))
        self.assertGreater(expected_turnover_3, 0.05)
        self.assertAlmostEqual(float(turnover[0, 3]), expected_turnover_3, places=12)
        self.assertTrue(np.allclose(realized[0, 3], w0))
        expected_net_3 = g3 - (cost_bp / 10_000.0) * expected_turnover_3
        self.assertAlmostEqual(float(net[0, 0, 3]), expected_net_3, places=12)

    def test_cpcv_purge_and_embargo_govern_train_selection_and_oos_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cube = engine.verify_and_load_dev_cube(_write_synthetic_cube(Path(tmp), n_sessions=240, seed=99))
            candidates = [
                engine.CandidateParams(10, 10, 0.0, 5, 2, 0.12),
                engine.CandidateParams(21, 20, 0.0, 5, 2, 0.12),
                engine.CandidateParams(42, 20, 0.5, 10, 2, 0.12),
                engine.CandidateParams(63, 40, 0.0, 21, 3, 0.10),
            ]

            unpurged = engine.run_cpcv_sweep(
                cube,
                candidates=candidates,
                n_groups=6,
                k_test_groups=2,
                purge_sessions=0,
                embargo_sessions=0,
                device_request="cpu",
                top_n=4,
            )
            purged = engine.run_cpcv_sweep(
                cube,
                candidates=candidates,
                n_groups=6,
                k_test_groups=2,
                purge_sessions=18,
                embargo_sessions=7,
                device_request="cpu",
                top_n=4,
            )

            # Purge and embargo must strictly shrink train_indices while keeping test_indices identical.
            self.assertEqual(unpurged["cpcv"]["meanPurgedSessions"], 0.0)
            self.assertEqual(unpurged["cpcv"]["meanEmbargoedSessions"], 0.0)
            self.assertGreater(purged["cpcv"]["meanPurgedSessions"], 0.0)
            self.assertGreater(purged["cpcv"]["meanEmbargoedSessions"], 0.0)
            self.assertGreater(unpurged["cpcv"]["meanTrainSessions"], purged["cpcv"]["meanTrainSessions"])
            self.assertEqual(unpurged["cpcv"]["meanTestSessions"], purged["cpcv"]["meanTestSessions"])

            # Split train/selection metrics must actually reflect purged train_indices rather than being ignored.
            self.assertNotAlmostEqual(
                unpurged["cpcv"]["selectedWinnerTrainMeanSharpe"],
                purged["cpcv"]["selectedWinnerTrainMeanSharpe"],
                places=6,
            )
            unpurged_by_id = {c["candidateId"]: c for c in unpurged["topCandidates"]}
            purged_by_id = {c["candidateId"]: c for c in purged["topCandidates"]}
            train_diffs = [
                abs(
                    unpurged_by_id[cid]["cpcvSelection"]["trainMedianSharpe5bp"]
                    - purged_by_id[cid]["cpcvSelection"]["trainMedianSharpe5bp"]
                )
                for cid in unpurged_by_id
            ]
            self.assertGreater(max(train_diffs), 1e-6)

            # PBO and OOS rank degradation must be populated and lie in [0, 1].
            self.assertIsNotNone(purged["cpcv"]["pbo"])
            self.assertGreaterEqual(purged["cpcv"]["pbo"], 0.0)
            self.assertLessEqual(purged["cpcv"]["pbo"], 1.0)
            self.assertIsNotNone(purged["cpcv"]["meanOosRankDegradation"])
            self.assertGreaterEqual(purged["cpcv"]["meanOosRankDegradation"], 0.0)
            self.assertLessEqual(purged["cpcv"]["meanOosRankDegradation"], 1.0)

            # Verify split 0's trainWinnerTrainSharpe and trainWinnerTestSharpe match direct evaluation
            # on split 0's purged train_indices and test_indices respectively.
            splits = engine.generate_cpcv_splits(
                n_sessions=len(cube.dates),
                n_groups=6,
                k_test_groups=2,
                purge_sessions=18,
                embargo_sessions=7,
            )
            features = engine._precompute_features(
                cube.closes,
                cube.returns,
                {c.lookback_days for c in candidates},
                {c.vol_window_days for c in candidates},
            )
            sel0 = purged["cpcv"]["splitSelections"][0]
            winner = next(c for c in candidates if c.candidate_id() == sel0["trainWinnerId"])
            vmask = (
                features.close_valid
                & features.mom_valid[winner.lookback_days]
                & features.vol_valid[winner.vol_window_days]
            )
            tw, rm = engine._build_candidate_weights(
                winner,
                features.mom[winner.lookback_days],
                features.vol[winner.vol_window_days],
                valid_mask=vmask,
            )
            net_5bp, _ = engine._evaluate_weights_vectorized(
                tw[None, :, :],
                rm[None, :],
                cube.returns,
                (5,),
                "numpy-cpu",
                None,
            )
            expected_train_sr = engine._annualized_sharpe(net_5bp[0, 0, splits[0].train_indices])
            expected_test_sr = engine._annualized_sharpe(net_5bp[0, 0, splits[0].test_indices])
            self.assertAlmostEqual(sel0["trainWinnerTrainSharpe"], expected_train_sr, places=10)
            self.assertAlmostEqual(sel0["trainWinnerTestSharpe"], expected_test_sr, places=10)

    def test_resolve_device_cuda_fails_closed_when_torch_or_cuda_unavailable(self) -> None:
        # Case 1: PyTorch is not installed (torch is None)
        with mock.patch.object(engine, "torch", None):
            with self.assertRaisesRegex(RuntimeError, "PyTorch is not installed"):
                engine.resolve_device("cuda")
            self.assertEqual(engine.resolve_device("auto"), ("numpy-cpu", None))
            self.assertEqual(engine.resolve_device("cpu"), ("numpy-cpu", None))

        # Case 2: PyTorch is installed, but CUDA is unavailable
        fake_torch_no_cuda = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            device=lambda name: f"device:{name}",
        )
        with mock.patch.object(engine, "torch", fake_torch_no_cuda):
            with self.assertRaisesRegex(RuntimeError, "torch.cuda.is_available\\(\\) is False"):
                engine.resolve_device("cuda")
            self.assertEqual(engine.resolve_device("cpu"), ("numpy-cpu", None))

        # Case 3: PyTorch and CUDA are available
        fake_torch_cuda = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            device=lambda name: f"device:{name}",
        )
        with mock.patch.object(engine, "torch", fake_torch_cuda):
            self.assertEqual(engine.resolve_device("cuda"), ("cuda", "device:cuda"))
            self.assertEqual(engine.resolve_device("auto"), ("cuda", "device:cuda"))

    def test_missing_close_mark_on_held_asset_fails_closed(self) -> None:
        # Asset 0 has closes [100, NaN, 50]; Asset 1 has valid closes [100, 101, 102].
        closes = np.array(
            [
                [100.0, 100.0],
                [np.nan, 101.0],
                [50.0, 102.0],
            ],
            dtype=np.float64,
        )
        valid_close_mask = np.isfinite(closes) & (closes > 0.0)
        nan_returns = np.array(
            [
                [0.0, 0.0],
                [np.nan, 0.01],
                [np.nan, 102.0 / 101.0 - 1.0],
            ],
            dtype=np.float64,
        )
        # Even if a caller passed zero-filled returns for missing bars, valid_close_mask must still fail closed.
        zero_filled_returns = np.where(np.isfinite(nan_returns), nan_returns, 0.0)

        targets = np.zeros((1, 3, 2), dtype=np.float64)
        targets[0, 0] = [0.5, 0.5]
        reb_masks = np.array([[True, False, False]], dtype=bool)

        for candidate_returns in (nan_returns, zero_filled_returns):
            with self.assertRaisesRegex(ValueError, "Missing close mark for held asset SPY on 2023-01-03"):
                engine._evaluate_weights_vectorized(
                    targets,
                    reb_masks,
                    candidate_returns,
                    (5,),
                    "numpy-cpu",
                    None,
                    valid_close_mask=valid_close_mask,
                    dates=("2023-01-02", "2023-01-03", "2023-01-04"),
                    symbols=("SPY", "QQQ"),
                )

        # Rebalancing into an asset on a day whose close mark is missing also fails closed.
        bad_target = np.zeros((1, 3, 2), dtype=np.float64)
        bad_target[0, 1] = [0.5, 0.5]
        reb_day1 = np.array([[False, True, False]], dtype=bool)
        with self.assertRaisesRegex(ValueError, "Missing close mark for targeted asset SPY on 2023-01-03"):
            engine._evaluate_weights_vectorized(
                bad_target,
                reb_day1,
                nan_returns,
                (5,),
                "numpy-cpu",
                None,
                valid_close_mask=valid_close_mask,
                dates=("2023-01-02", "2023-01-03", "2023-01-04"),
                symbols=("SPY", "QQQ"),
            )

        # Holding ONLY Asset 1 (weight 0 on the missing asset) succeeds with exact finite returns.
        unheld_targets = np.zeros((1, 3, 2), dtype=np.float64)
        unheld_targets[0, 0] = [0.0, 1.0]
        net, _ = engine._evaluate_weights_vectorized(
            unheld_targets,
            reb_masks,
            nan_returns,
            (0,),
            "numpy-cpu",
            None,
            valid_close_mask=valid_close_mask,
            dates=("2023-01-02", "2023-01-03", "2023-01-04"),
            symbols=("SPY", "QQQ"),
        )
        self.assertTrue(np.all(np.isfinite(net)))
        self.assertAlmostEqual(float(net[0, 0, 1]), 0.01, places=12)
        self.assertAlmostEqual(float(net[0, 0, 2]), 102.0 / 101.0 - 1.0, places=12)

        # End-to-end: dropping a single daily bar on an actively held asset fails closed in run_cpcv_sweep.
        with tempfile.TemporaryDirectory() as tmp:
            dates = _make_business_dates(90)
            # Rebalance happens at t=21 (cadence=21); drop QQQ close at t=25 while held.
            dropped_date = dates[25]
            cube_dir = _write_synthetic_cube(
                Path(tmp),
                n_sessions=90,
                drop_daily_keys={(dropped_date, "QQQ")},
                seed=7,
            )
            cube = engine.verify_and_load_dev_cube(cube_dir)
            qqq_idx = cube.symbols.index("QQQ")
            self.assertFalse(bool(cube.valid_close_mask[25, qqq_idx]))
            self.assertTrue(np.isnan(cube.returns[25, qqq_idx]))
            self.assertTrue(np.isnan(cube.returns[26, qqq_idx]))

            candidate = engine.CandidateParams(
                lookback_days=21,
                vol_window_days=20,
                entry_z_score=-5.0,
                rebalance_cadence_days=21,
                top_k=4,
                target_vol=0.12,
            )
            with self.assertRaisesRegex(ValueError, f"Missing close mark for held asset QQQ on {dropped_date}"):
                engine.run_cpcv_sweep(
                    cube,
                    candidates=[candidate],
                    n_groups=4,
                    k_test_groups=1,
                    purge_sessions=5,
                    embargo_sessions=2,
                    device_request="cpu",
                    top_n=1,
                )

    def test_long_only_false_is_rejected_explicitly(self) -> None:
        with self.assertRaisesRegex(ValueError, "long_only=False is not implemented"):
            engine.CandidateParams(
                lookback_days=21,
                vol_window_days=20,
                entry_z_score=0.0,
                rebalance_cadence_days=5,
                top_k=2,
                target_vol=0.12,
                long_only=False,
            )

        # Defensive check even if CandidateParams.__post_init__ is bypassed.
        spoofed = SimpleNamespace(
            lookback_days=21,
            vol_window_days=20,
            entry_z_score=0.0,
            rebalance_cadence_days=5,
            top_k=2,
            target_vol=0.12,
            long_only=False,
            candidate_id=lambda: "LS/spoofed",
        )
        with self.assertRaisesRegex(ValueError, "long_only=False is not implemented"):
            engine._build_candidate_weights(
                spoofed,  # type: ignore[arg-type]
                np.zeros((30, 2), dtype=np.float64),
                np.ones((30, 2), dtype=np.float64),
            )

        with tempfile.TemporaryDirectory() as tmp:
            cube = engine.verify_and_load_dev_cube(_write_synthetic_cube(Path(tmp), n_sessions=90))
            with self.assertRaisesRegex(ValueError, "long_only=False is not implemented"):
                engine.run_cpcv_sweep(
                    cube,
                    candidates=[spoofed],  # type: ignore[list-item]
                    n_groups=4,
                    k_test_groups=1,
                    purge_sessions=5,
                    embargo_sessions=2,
                    device_request="cpu",
                    top_n=1,
                )

    def test_baseline_free_scoring_mode_and_require_baselines_fail_closed(self) -> None:
        candidate = engine.CandidateParams(21, 20, 0.0, 5, 2, 0.12)

        # Case 1: Cube without baselines labels scoringMode="standalone-no-baselines" honestly
        # and fails closed when --require-baselines is requested.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cube_dir = _write_synthetic_cube(root, n_sessions=180, include_baselines=False)
            cube = engine.verify_and_load_dev_cube(cube_dir)
            self.assertEqual(cube.baselines, {})

            receipt = engine.run_cpcv_sweep(
                cube,
                candidates=[candidate],
                n_groups=5,
                k_test_groups=2,
                purge_sessions=10,
                embargo_sessions=3,
                device_request="cpu",
                top_n=1,
            )
            self.assertFalse(receipt["hasBaselines"])
            self.assertEqual(receipt["baselineSeries"], [])
            self.assertEqual(receipt["scoringMode"], engine.SCORING_MODE_STANDALONE)
            base_block = receipt["topCandidates"][0]["baselines"]
            self.assertFalse(base_block["hasBaselines"])
            self.assertEqual(base_block["baselineSeries"], [])
            self.assertEqual(base_block["scoringMode"], engine.SCORING_MODE_STANDALONE)
            self.assertIsNone(base_block["maxAbsCorrelation"])
            self.assertIsNone(base_block["correlationPenalty"])
            self.assertIsNone(base_block["marginalPortfolioSharpe"])

            with self.assertRaisesRegex(ValueError, "Baselines are required"):
                engine.run_cpcv_sweep(
                    cube,
                    candidates=[candidate],
                    n_groups=5,
                    k_test_groups=2,
                    purge_sessions=10,
                    embargo_sessions=3,
                    device_request="cpu",
                    top_n=1,
                    require_baselines=True,
                )

            with self.assertRaisesRegex(ValueError, "Baselines are required"):
                engine.main(
                    [
                        "--cube-dir",
                        str(cube_dir),
                        "--out",
                        str(root / "out.json"),
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
                        "--require-baselines",
                    ]
                )

        # Case 2: Cube with daily-only causal baselines (F4, O1 without B0) succeeds with --require-baselines
        # and accurately reports baselineSeries=["F4", "O1"] and scoringMode="marginal-portfolio".
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cube_dir = _write_synthetic_cube(root, n_sessions=180, include_baselines=True, baseline_cols=("F4", "O1"))
            out_receipt = root / "receipt.json"
            rc = engine.main(
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
                    "2",
                    "--require-baselines",
                ]
            )
            self.assertEqual(rc, 0)
            receipt = json.loads(out_receipt.read_text(encoding="utf-8"))
            self.assertTrue(receipt["hasBaselines"])
            self.assertEqual(receipt["baselineSeries"], ["F4", "O1"])
            self.assertEqual(receipt["scoringMode"], engine.SCORING_MODE_MARGINAL)
            corrs = receipt["topCandidates"][0]["baselines"]["correlations"]
            self.assertIsNone(corrs["B0"])
            self.assertIsNotNone(corrs["F4"])
            self.assertIsNotNone(corrs["O1"])


if __name__ == "__main__":
    unittest.main()
