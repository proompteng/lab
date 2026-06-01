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

            self.assertFalse(json.loads(output.read_text(encoding="utf-8"))["promotion_proof"])
            self.assertEqual(len(rows.read_text(encoding="utf-8").splitlines()), 1)
