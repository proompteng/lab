"""Behavioral checks for private universe evidence reproduction (no network or credentials)."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "universe_study", Path(__file__).with_name("sp100-universe-study.py")
)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class UniverseEvidenceTests(unittest.TestCase):
    def test_pages_require_the_original_continuation_and_a_terminal_page(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "0001-daily-sip-0.json").write_text(
                json.dumps({"bars": {"AAPL": [{"v": 1}]}, "next_page_token": "next"})
            )
            (root / "0002-daily-sip-1.json").write_text(
                json.dumps({"bars": {"AAPL": [{"v": 2}]}, "next_page_token": None})
            )
            url = "https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL"
            manifest = [
                {"file": "0001-daily-sip-0.json", "url": url},
                {"file": "0002-daily-sip-1.json", "url": url + "&page_token=next"},
            ]
            self.assertEqual(
                study.source_rows(root, manifest, "daily-sip"),
                {"AAPL": [{"v": 1}, {"v": 2}]},
            )
            for broken in (
                manifest[:1],
                manifest[1:],
                [manifest[0], {**manifest[1], "url": url + "&page_token=wrong"}],
                [manifest[0], manifest[0]],
            ):
                with self.assertRaises(ValueError):
                    study.source_rows(root, broken, "daily-sip")
            (root / manifest[1]["file"]).write_text(
                json.dumps({"bars": {"MSFT": []}, "next_page_token": None})
            )
            with self.assertRaisesRegex(ValueError, "unrequested"):
                study.source_rows(root, manifest, "daily-sip")

    def test_decisions_do_not_see_future_quotes_or_fill_a_missing_window(self):
        sessions = [{"date": "2026-11-02"}]
        quote = {
            "t": "2026-11-02T15:00:01Z",
            "bp": 100,
            "ap": 100.02,
            "bs": 100,
            "as": 100,
        }
        report = study.sampled_seconds([quote], sessions)
        self.assertEqual(report["sampledSeconds"], 60)
        self.assertEqual(report["freshTwoSidedQuoteSeconds"], 11)
        self.assertEqual(report["within5BpsSeconds"], 11)
        self.assertEqual(
            study.sampled_seconds([], sessions)["executableOpportunityFraction"], 0
        )

    def test_eastern_sampling_crosses_daylight_saving_without_a_one_hour_shift(self):
        rows = [
            {"t": time, "bp": 100, "ap": 100.02, "bs": 100, "as": 100}
            for time in ("2026-10-30T14:00:00Z", "2026-11-02T15:00:00Z")
        ]
        report = study.sampled_seconds(
            rows, [{"date": "2026-10-30"}, {"date": "2026-11-02"}]
        )
        self.assertEqual(report["within5BpsSeconds"], 22)
        self.assertEqual(report["sampledSeconds"], 120)

    def test_withdrawn_sides_supersede_previous_liquidity_until_a_new_quote(self):
        rows = [
            {
                "t": "2026-11-02T15:00:00Z",
                "bp": 100,
                "ap": 100.02,
                "bs": 100,
                "as": 100,
            },
            {"t": "2026-11-02T15:00:02Z", "bp": 100, "ap": 100.02, "bs": 0, "as": 100},
            {
                "t": "2026-11-02T15:00:04Z",
                "bp": 100.03,
                "ap": 100.02,
                "bs": 100,
                "as": 100,
            },
            {
                "t": "2026-11-02T15:00:06Z",
                "bp": 100,
                "ap": 100.02,
                "bs": 100,
                "as": 100,
            },
        ]
        report = study.sampled_seconds(rows, [{"date": "2026-11-02"}])
        self.assertEqual(report["within5BpsSeconds"], 13)


if __name__ == "__main__":
    unittest.main()
