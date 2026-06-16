from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.verify_trading_readiness.support import (
    Path,
    _TestVerifyTradingReadinessBase,
    _completion_status,
    _ready_status,
    json,
    main,
    tempfile,
)


class TestCliReturnsNonzeroForFailedStatusFile(_TestVerifyTradingReadinessBase):
    def test_cli_returns_nonzero_for_failed_status_file(self) -> None:
        status = _ready_status()
        status["running"] = False
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(json.dumps(status), encoding="utf-8")

            exit_code = main(["--status-file", str(status_path)])

        self.assertEqual(exit_code, 1)

    def test_cli_accepts_completion_file_for_runtime_ledger_profit_proof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            completion_path = Path(tmp_dir) / "completion.json"
            status_path.write_text(json.dumps(_ready_status()), encoding="utf-8")
            completion_path.write_text(
                json.dumps(_completion_status()), encoding="utf-8"
            )

            exit_code = main(
                [
                    "--status-file",
                    str(status_path),
                    "--completion-file",
                    str(completion_path),
                    "--require-runtime-ledger-profit-proof",
                    "--min-runtime-ledger-net-pnl",
                    "500",
                    "--min-runtime-ledger-trading-days",
                    "25",
                    "--min-runtime-ledger-daily-net-pnl",
                    "20",
                ]
            )

        self.assertEqual(exit_code, 0)

    def test_cli_rejects_non_decimal_runtime_ledger_profit_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(json.dumps(_ready_status()), encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "must be decimal"):
                main(
                    [
                        "--status-file",
                        str(status_path),
                        "--require-runtime-ledger-profit-proof",
                        "--min-runtime-ledger-net-pnl",
                        "not-a-number",
                    ]
                )

            with self.assertRaisesRegex(SystemExit, "daily-net-pnl must be decimal"):
                main(
                    [
                        "--status-file",
                        str(status_path),
                        "--require-runtime-ledger-profit-proof",
                        "--min-runtime-ledger-daily-net-pnl",
                        "not-a-number",
                    ]
                )
