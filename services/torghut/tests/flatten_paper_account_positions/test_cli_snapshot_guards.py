from __future__ import annotations

from tests.flatten_paper_account_positions.support import (
    FakeFlattenClient,
    SimpleNamespace,
    StringIO,
    _TestFlattenPaperAccountPositionsBase,
    datetime,
    flatten_cli,
    flatten_core_module,
    flatten_script,
    json,
    patch,
    redirect_stdout,
    sys,
    timezone,
)


class TestFlattenPaperAccountCliSnapshotGuards(_TestFlattenPaperAccountPositionsBase):
    def test_pending_baseline_allowance_predicate_fails_closed_edges(self) -> None:
        self.assertFalse(
            flatten_script._target_plan_readback_pending_clean_window_baseline_only(
                {
                    "state": "clean",
                    "matching_target_count": 1,
                    "targets": [
                        {
                            "state": "pending_until_clean_window_baseline",
                            "blockers": [
                                "paper_route_clean_window_baseline_snapshot_pending"
                            ],
                        }
                    ],
                    "blockers": [
                        "paper_route_clean_window_baseline_snapshot_pending",
                        "paper_route_target_plan_clean_window_baseline_not_clean",
                    ],
                }
            )
        )
        self.assertFalse(
            flatten_script._target_plan_readback_pending_clean_window_baseline_only(
                {
                    "state": "blocked",
                    "matching_target_count": 0,
                    "targets": [
                        {
                            "state": "pending_until_clean_window_baseline",
                            "blockers": [
                                "paper_route_clean_window_baseline_snapshot_pending"
                            ],
                        }
                    ],
                    "blockers": [
                        "paper_route_clean_window_baseline_snapshot_pending",
                        "paper_route_target_plan_clean_window_baseline_not_clean",
                    ],
                }
            )
        )
        self.assertFalse(
            flatten_script._target_plan_readback_pending_clean_window_baseline_only(
                {
                    "state": "blocked",
                    "matching_target_count": 1,
                    "targets": [],
                    "blockers": [
                        "paper_route_clean_window_baseline_snapshot_pending",
                        "paper_route_target_plan_clean_window_baseline_not_clean",
                    ],
                }
            )
        )
        self.assertFalse(
            flatten_script._target_plan_readback_pending_clean_window_baseline_only(
                {
                    "state": "blocked",
                    "matching_target_count": 1,
                    "targets": [
                        {
                            "state": "blocked",
                            "blockers": [
                                "paper_route_clean_window_baseline_snapshot_pending"
                            ],
                        }
                    ],
                    "blockers": [
                        "paper_route_clean_window_baseline_snapshot_pending",
                        "paper_route_target_plan_clean_window_baseline_not_clean",
                    ],
                }
            )
        )
        self.assertFalse(
            flatten_script._target_plan_readback_pending_clean_window_baseline_only(
                {
                    "state": "blocked",
                    "matching_target_count": 1,
                    "targets": [
                        {
                            "state": "pending_until_clean_window_baseline",
                            "blockers": ["paper_route_account_pre_session_not_flat"],
                        }
                    ],
                    "blockers": [
                        "paper_route_clean_window_baseline_snapshot_pending",
                        "paper_route_target_plan_clean_window_baseline_not_clean",
                    ],
                }
            )
        )

    def test_main_uses_database_dsn_env_for_snapshot_persistence(self) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="sim-snapshot-1",
            as_of=datetime(2026, 6, 5, 1, 30, tzinfo=timezone.utc),
        )
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--database-dsn-env",
            "SIM_DB_DSN",
            "--persist-snapshot",
            "--json",
        ]

        with (
            patch.dict("os.environ", {"SIM_DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(sys, "argv", argv),
            patch.object(flatten_cli, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_cli, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_cli, "snapshot_account_and_positions", return_value=snapshot
            ) as snapshot_account,
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["database_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(payload["position_snapshot_id"], "sim-snapshot-1")
        snapshot_session = snapshot_account.call_args.args[0]
        self.assertEqual(
            str(snapshot_session.get_bind().url),
            "sqlite+pysqlite:///:memory:",
        )

    def test_main_skips_snapshot_persistence_when_guard_fails(self) -> None:
        client = FakeFlattenClient()
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "WRONG",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_cli, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_cli, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(flatten_core_module, "SessionLocal") as session_local,
            patch.object(
                flatten_cli, "snapshot_account_and_positions"
            ) as snapshot_account,
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertEqual(
            payload["position_snapshot_skipped"],
            "paper_account_label_or_mode_guard_failed",
        )
        session_local.assert_not_called()
        snapshot_account.assert_not_called()

    def test_main_outputs_text_and_returns_blocked_status(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AAPL", "qty": "1", "side": "long", "market_value": "100"}]
        )
        argv = [
            "flatten_paper_account_positions.py",
            "--trading-mode",
            "live",
            "--max-position-count",
            "-1",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_cli, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_cli, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("status=blocked", output.getvalue())
        self.assertFalse(client.cancelled)
