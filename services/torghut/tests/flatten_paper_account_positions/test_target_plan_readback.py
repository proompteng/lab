from __future__ import annotations

from tests.flatten_paper_account_positions.support import (
    FakeBytesResponse,
    FakeFlattenClient,
    FakeHttpResponse,
    FakeSessionContext,
    SimpleNamespace,
    StringIO,
    _TestFlattenPaperAccountPositionsBase,
    datetime,
    flatten_script,
    json,
    patch,
    redirect_stdout,
    sys,
    timezone,
)


class TestFlattenPaperAccountTargetPlanReadback(_TestFlattenPaperAccountPositionsBase):
    def test_parse_args_accepts_explicit_guardrails(self) -> None:
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--paper-base-url",
            "https://paper-api.alpaca.markets",
            "--database-dsn-env",
            "SIM_DB_DSN",
            "--max-gross-market-value",
            "1234.56",
            "--max-position-count",
            "3",
            "--extended-hours-limit",
            "--limit-away-bps",
            "150",
            "--wait-flat-seconds",
            "45",
            "--poll-seconds",
            "3",
            "--persist-snapshot",
            "--target-plan-readback-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--target-plan-readback-timeout-seconds",
            "2",
            "--require-target-plan-readback-clean",
            "--persist-lineage",
            "--apply",
            "--json",
        ]

        with patch.object(sys, "argv", argv):
            args = flatten_script._parse_args()

        self.assertEqual(args.account_label, "TORGHUT_SIM")
        self.assertEqual(args.expected_account_label, "TORGHUT_SIM")
        self.assertEqual(args.trading_mode, "paper")
        self.assertEqual(args.paper_base_url, "https://paper-api.alpaca.markets")
        self.assertEqual(args.database_dsn_env, "SIM_DB_DSN")
        self.assertEqual(args.max_gross_market_value, "1234.56")
        self.assertEqual(args.max_position_count, 3)
        self.assertTrue(args.extended_hours_limit)
        self.assertEqual(args.limit_away_bps, "150")
        self.assertEqual(args.wait_flat_seconds, 45)
        self.assertEqual(args.poll_seconds, 3)
        self.assertTrue(args.persist_snapshot)
        self.assertEqual(
            args.target_plan_readback_url,
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
        )
        self.assertEqual(args.target_plan_readback_timeout_seconds, 2)
        self.assertTrue(args.require_target_plan_readback_clean)
        self.assertTrue(args.persist_lineage)
        self.assertTrue(args.apply)
        self.assertTrue(args.json)

    def test_database_dsn_normalization_and_missing_env_guard(self) -> None:
        self.assertEqual(
            flatten_script._sqlalchemy_dsn("postgresql+psycopg://u:p@host/db"),
            "postgresql+psycopg://u:p@host/db",
        )
        self.assertEqual(
            flatten_script._sqlalchemy_dsn("postgres://u:p@host/db"),
            "postgresql+psycopg://u:p@host/db",
        )
        self.assertEqual(
            flatten_script._sqlalchemy_dsn("postgresql://u:p@host/db"),
            "postgresql+psycopg://u:p@host/db",
        )
        self.assertEqual(
            flatten_script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )

        with (
            patch.dict("os.environ", {}, clear=True),
            self.assertRaisesRegex(
                RuntimeError,
                "paper_account_flatten_database_dsn_env_missing:SIM_DB_DSN",
            ),
        ):
            flatten_script._session_factory_from_env("SIM_DB_DSN")

    def test_main_outputs_json_and_returns_clean_status(self) -> None:
        client = FakeFlattenClient()
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "clean")
        self.assertEqual(payload["position_count"], 0)

    def test_main_persists_snapshot_for_guarded_paper_account(self) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="snapshot-1",
            as_of=datetime(2026, 5, 31, 6, 35, tzinfo=timezone.utc),
        )
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_script, "SessionLocal", return_value=FakeSessionContext()
            ),
            patch.object(
                flatten_script, "snapshot_account_and_positions", return_value=snapshot
            ) as snapshot_account,
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["position_snapshot_id"], "snapshot-1")
        self.assertEqual(
            payload["position_snapshot_as_of"],
            "2026-05-31T06:35:00+00:00",
        )
        snapshot_account.assert_called_once()

    def test_target_plan_readback_derives_targets_from_proofs_payload(self) -> None:
        proofs_payload = {
            "schema_version": "torghut.proofs.v1",
            "proofs": [
                {
                    "identity": {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "runtime_window",
                        "source_plan_ref": "proof-plan:c88421d619759b2cfaa6f4d0",
                        "source_decision_mode": "bounded_paper_collection",
                        "target_notional": "25",
                        "target_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
                        "target_symbol_quantities": {"AAPL": "1", "AMZN": "1"},
                    },
                    "window": {
                        "start": "2026-06-05T13:30:00+00:00",
                        "end": "2026-06-05T20:00:00+00:00",
                    },
                    "symbols": ["AAPL", "AMZN"],
                    "account_state": {
                        "clean_baseline": False,
                        "blockers": ["account_dirty_before_window"],
                    },
                }
            ],
        }

        plans = flatten_script._target_plan_readback_plans(proofs_payload)
        plan_name, _plan, targets = flatten_script._target_plan_readback_targets(
            proofs_payload
        )

        self.assertEqual(plans[1][0], "proofs")
        self.assertEqual(plan_name, "proofs")
        self.assertEqual(targets[0]["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(targets[0]["paper_route_clean_window_state"], "blocked")
        self.assertEqual(
            targets[0]["paper_route_clean_window_baseline_blockers"],
            ["account_dirty_before_window"],
        )
        self.assertEqual(targets[0]["paper_route_probe_symbols"], ["AAPL", "AMZN"])

    def test_target_plan_readback_proves_clean_matching_snapshot(self) -> None:
        target_plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "next_paper_route_runtime_window_targets": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "clean_window_baseline_readiness": {
                    "state": "clean",
                    "blockers": [],
                },
                "targets": [
                    {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "window_start": "2026-06-05T13:30:00+00:00",
                        "window_end": "2026-06-05T20:00:00+00:00",
                        "paper_route_clean_window_baseline_state": {
                            "state": "clean",
                            "snapshot_id": "snapshot-1",
                            "snapshot_as_of": "2026-06-05T13:16:00+00:00",
                            "source_auditable": True,
                            "blockers": [],
                        },
                        "paper_route_clean_window_baseline_blockers": [],
                    }
                ],
            },
        }

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(target_plan),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
                account_label="TORGHUT_SIM",
                snapshot_id="snapshot-1",
                timeout_seconds=2,
            )

        self.assertEqual(readback["state"], "clean")
        self.assertEqual(
            readback["plan_source"], "next_paper_route_runtime_window_targets"
        )
        self.assertEqual(readback["matching_target_count"], 1)
        self.assertEqual(readback["clean_matching_target_count"], 1)
        self.assertTrue(readback["persisted_snapshot_seen"])
        self.assertFalse(readback["persisted_snapshot_after_target_window"])
        self.assertEqual(readback["blockers"], [])

    def test_target_plan_readback_accepts_post_window_flat_snapshot(self) -> None:
        target_plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "next_paper_route_runtime_window_targets": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "clean_window_baseline_readiness": {
                    "state": "clean",
                    "blockers": [],
                },
                "targets": [
                    {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "window_start": "2026-06-05T13:30:00+00:00",
                        "window_end": "2026-06-05T20:00:00+00:00",
                        "paper_route_clean_window_baseline_state": {
                            "state": "clean",
                            "snapshot_id": "pre-session-snapshot",
                            "snapshot_as_of": "2026-06-05T13:29:54+00:00",
                            "source_auditable": True,
                            "blockers": [],
                        },
                        "paper_route_clean_window_baseline_blockers": [],
                    }
                ],
            },
        }

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(target_plan),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
                account_label="TORGHUT_SIM",
                snapshot_id="post-close-snapshot",
                snapshot_as_of="2026-06-05T20:09:35+00:00",
                timeout_seconds=2,
            )

        self.assertEqual(readback["state"], "clean")
        self.assertEqual(readback["matching_target_count"], 1)
        self.assertEqual(readback["clean_matching_target_count"], 1)
        self.assertFalse(readback["persisted_snapshot_seen"])
        self.assertTrue(readback["persisted_snapshot_after_target_window"])
        self.assertEqual(readback["blockers"], [])

    def test_target_plan_readback_fail_closed_edge_cases(self) -> None:
        self.assertIsNone(flatten_script._readback_datetime("not-a-timestamp"))
        self.assertEqual(
            flatten_script._readback_datetime("2026-06-05T20:00:00"),
            datetime(2026, 6, 5, 20, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            flatten_script._readback_datetime("2026-06-05T20:00:00Z"),
            datetime(2026, 6, 5, 20, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(flatten_script._as_sequence("not-a-list"), [])
        self.assertEqual(
            flatten_script._target_plan_readback_targets({"targets": []}),
            ("top_level", {"targets": []}, []),
        )
        self.assertEqual(flatten_script._target_plan_target_account_label({}), "")
        self.assertTrue(flatten_script._target_plan_target_matches_account({}, ""))

        not_requested = flatten_script.read_target_plan_clean_window_readback(
            url="",
            account_label="TORGHUT_SIM",
            snapshot_id=None,
            timeout_seconds=1,
        )
        self.assertEqual(not_requested["state"], "not_requested")

        http_error = flatten_script.urllib.error.HTTPError(
            "http://torghut-sim",
            503,
            "service unavailable",
            hdrs=None,
            fp=None,
        )
        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            side_effect=http_error,
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertEqual(readback["http_status"], 503)
        self.assertEqual(
            readback["blockers"], ["paper_route_target_plan_readback_http_error"]
        )

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            side_effect=OSError("connection refused"),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertEqual(
            readback["blockers"], ["paper_route_target_plan_readback_failed"]
        )

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeBytesResponse(b"{"),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertEqual(
            readback["blockers"], ["paper_route_target_plan_readback_json_invalid"]
        )

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(["not", "a", "mapping"]),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertEqual(
            readback["blockers"], ["paper_route_target_plan_readback_payload_invalid"]
        )

        target_only_blocker_plan = {
            "targets": [
                {
                    "candidate_id": "candidate-1",
                    "account_label": "TORGHUT_SIM",
                    "paper_route_clean_window_baseline_state": {
                        "state": "blocked",
                        "blockers": ["target_only_clean_window_blocker"],
                    },
                }
            ],
            "clean_window_baseline_readiness": {"state": "unknown", "blockers": []},
        }
        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(target_only_blocker_plan),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertIn("target_only_clean_window_blocker", readback["blockers"])
        self.assertIn(
            "paper_route_target_plan_clean_window_baseline_not_clean",
            readback["blockers"],
        )

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(
                {"targets": [{"candidate_id": "other", "account_label": "OTHER"}]}
            ),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id=None,
                timeout_seconds=1,
            )
        self.assertEqual(
            readback["blockers"], ["paper_route_target_plan_readback_target_missing"]
        )

        with patch.object(
            flatten_script.urllib.request,
            "urlopen",
            return_value=FakeHttpResponse(
                {
                    "targets": [
                        {
                            "candidate_id": "candidate-1",
                            "account_label": "TORGHUT_SIM",
                            "window_start": "2026-06-05T13:30:00+00:00",
                            "window_end": "2026-06-05T20:00:00+00:00",
                            "paper_route_clean_window_baseline_state": {
                                "state": "clean",
                                "snapshot_id": "other-snapshot",
                                "source_auditable": True,
                                "blockers": [],
                            },
                        }
                    ]
                }
            ),
        ):
            readback = flatten_script.read_target_plan_clean_window_readback(
                url="http://torghut-sim",
                account_label="TORGHUT_SIM",
                snapshot_id="snapshot-1",
                snapshot_as_of="2026-06-05T13:16:00+00:00",
                timeout_seconds=1,
            )
        self.assertIn(
            "paper_route_target_plan_readback_snapshot_id_mismatch",
            readback["blockers"],
        )

    def test_required_target_plan_readback_blocks_when_baseline_still_pending(
        self,
    ) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="snapshot-1",
            as_of=datetime(2026, 6, 5, 13, 16, tzinfo=timezone.utc),
        )
        target_plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "next_paper_route_runtime_window_targets": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "clean_window_baseline_readiness": {
                    "state": "clean_window_required",
                    "blockers": ["paper_route_clean_window_baseline_snapshot_pending"],
                },
                "targets": [
                    {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_clean_window_baseline_state": {
                            "state": "pending_until_clean_window_baseline",
                            "blockers": [
                                "paper_route_clean_window_baseline_snapshot_pending"
                            ],
                        },
                    }
                ],
            },
        }
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--target-plan-readback-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--require-target-plan-readback-clean",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_script, "SessionLocal", return_value=FakeSessionContext()
            ),
            patch.object(
                flatten_script, "snapshot_account_and_positions", return_value=snapshot
            ),
            patch.object(
                flatten_script.urllib.request,
                "urlopen",
                return_value=FakeHttpResponse(target_plan),
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 3)
        self.assertTrue(payload["target_plan_readback_required_clean"])
        self.assertFalse(payload["target_plan_readback_clean"])
        readback = payload["target_plan_readback"]
        self.assertEqual(readback["state"], "blocked")
        self.assertIn(
            "paper_route_clean_window_baseline_snapshot_pending",
            readback["blockers"],
        )
        self.assertIn(
            "paper_route_target_plan_clean_window_baseline_not_clean",
            readback["blockers"],
        )

    def test_required_target_plan_readback_allows_pre_session_pending_baseline(
        self,
    ) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="snapshot-1",
            as_of=datetime(2026, 6, 5, 13, 6, tzinfo=timezone.utc),
        )
        target_plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "next_paper_route_runtime_window_targets": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "clean_window_baseline_readiness": {
                    "state": "clean_window_required",
                    "blockers": ["paper_route_clean_window_baseline_snapshot_pending"],
                },
                "targets": [
                    {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "window_start": "2026-06-05T13:30:00+00:00",
                        "window_end": "2026-06-05T20:00:00+00:00",
                        "paper_route_clean_window_baseline_state": {
                            "state": "pending_until_clean_window_baseline",
                            "blockers": [
                                "paper_route_clean_window_baseline_snapshot_pending"
                            ],
                        },
                    }
                ],
            },
        }
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--target-plan-readback-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--require-target-plan-readback-clean",
            "--allow-pending-clean-window-baseline-readback",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_script, "SessionLocal", return_value=FakeSessionContext()
            ),
            patch.object(
                flatten_script, "snapshot_account_and_positions", return_value=snapshot
            ),
            patch.object(
                flatten_script.urllib.request,
                "urlopen",
                return_value=FakeHttpResponse(target_plan),
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["target_plan_readback_required_clean"])
        self.assertFalse(payload["target_plan_readback_clean"])
        self.assertTrue(
            payload["target_plan_readback_pending_clean_window_baseline_allowed"]
        )
        self.assertIn(
            "paper_route_clean_window_baseline_snapshot_pending",
            payload["target_plan_readback"]["blockers"],
        )

    def test_pending_baseline_allowance_still_fails_dirty_readback(self) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="snapshot-1",
            as_of=datetime(2026, 6, 5, 13, 16, tzinfo=timezone.utc),
        )
        target_plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "next_paper_route_runtime_window_targets": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "clean_window_baseline_readiness": {
                    "state": "clean_window_required",
                    "blockers": ["paper_route_account_pre_session_snapshot_stale"],
                },
                "targets": [
                    {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "window_start": "2026-06-05T13:30:00+00:00",
                        "window_end": "2026-06-05T20:00:00+00:00",
                        "paper_route_clean_window_baseline_state": {
                            "state": "blocked",
                            "blockers": [
                                "paper_route_account_pre_session_snapshot_stale"
                            ],
                        },
                    }
                ],
            },
        }
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--target-plan-readback-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--require-target-plan-readback-clean",
            "--allow-pending-clean-window-baseline-readback",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_script, "SessionLocal", return_value=FakeSessionContext()
            ),
            patch.object(
                flatten_script, "snapshot_account_and_positions", return_value=snapshot
            ),
            patch.object(
                flatten_script.urllib.request,
                "urlopen",
                return_value=FakeHttpResponse(target_plan),
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 3)
        self.assertTrue(payload["target_plan_readback_required_clean"])
        self.assertFalse(payload["target_plan_readback_clean"])
        self.assertFalse(
            payload["target_plan_readback_pending_clean_window_baseline_allowed"]
        )
        self.assertIn(
            "paper_route_account_pre_session_snapshot_stale",
            payload["target_plan_readback"]["blockers"],
        )
