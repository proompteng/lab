from __future__ import annotations

from tests.strategy_autoresearch.support import (
    Path,
    StrategyAutoresearchTestCase,
    TemporaryDirectory,
    json,
    patch,
    runner,
    sys,
)


class TestStrategyAutoresearchMain(StrategyAutoresearchTestCase):
    def test_main_writes_json_output_and_returns_nonzero_for_error_payload(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path = root / "program.yaml"
            program_path.write_text(
                "schema_version: torghut.strategy-autoresearch.v1\nfamilies: []\n",
                encoding="utf-8",
            )
            output_dir = root / "out"
            json_output = root / "summary.json"

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_strategy_autoresearch_loop.py",
                        "--program",
                        str(program_path),
                        "--output-dir",
                        str(output_dir),
                        "--json-output",
                        str(json_output),
                    ],
                ),
                patch.object(
                    runner,
                    "run_strategy_autoresearch_loop",
                    return_value={"status": "error", "run_root": str(output_dir)},
                ),
            ):
                exit_code = runner.main()

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                json.loads(json_output.read_text(encoding="utf-8"))["status"], "error"
            )
