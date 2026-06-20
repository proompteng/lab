from __future__ import annotations

from app.api import proofs as proofs_api

from tests.api.trading_api_support import (
    Any,
    TradingApiTestCaseBase,
    _fetch_paper_route_target_plan_url,
    _paper_route_target_plan_from_payload,
    json,
    paper_route_target_plan_probe_symbols,
    patch,
    settings,
    shared_fetch_paper_route_target_plan_url,
)


class TestTradingApiPaperRoutePayloads(TradingApiTestCaseBase):
    def test_live_target_account_audit_stays_disabled_for_unscoped_live_target(
        self,
    ) -> None:
        original_mode = settings.trading_mode
        try:
            settings.trading_mode = "disabled"
            self.assertFalse(proofs_api._paper_route_target_account_audit_available({}))

            settings.trading_mode = "live"
            self.assertFalse(proofs_api._paper_route_target_account_audit_available({}))

            self.assertFalse(
                proofs_api._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "target_dsn_env": "LIVE_DB_DSN",
                                    "source_dsn_env": "LIVE_DB_DSN",
                                    "observed_stage": "live",
                                }
                            ]
                        }
                    }
                )
            )

            self.assertFalse(
                proofs_api._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "target_dsn_env": "LIVE_DB_DSN",
                                    "source_dsn_env": "LIVE_DB_DSN",
                                    "observed_stage": "paper",
                                }
                            ]
                        }
                    }
                )
            )

            self.assertTrue(
                proofs_api._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "account_label": "TORGHUT_SIM",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_dsn_env": "SIM_DB_DSN",
                            "observed_stage": "paper",
                            "targets": [],
                        }
                    }
                )
            )

            self.assertTrue(
                proofs_api._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "source": "configured_simple_lane_paper_data_collection",
                            "account_label": "PA3SX7FYNUTF",
                            "source_account_label": "PA3SX7FYNUTF",
                            "observed_stage": "paper",
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "source_account_label": "PA3SX7FYNUTF",
                                    "source_kind": (
                                        "configured_simple_lane_paper_data_collection"
                                    ),
                                    "source_plan_ref": (
                                        "configured-simple-lane-paper-data-collection"
                                    ),
                                }
                            ],
                        }
                    }
                )
            )

            self.assertTrue(
                proofs_api._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "account_label": "PA3SX7FYNUTF",
                            "source_account_label": "PA3SX7FYNUTF",
                            "observed_stage": "paper",
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "source_account_label": "PA3SX7FYNUTF",
                                    "source_kind": (
                                        "configured_simple_lane_paper_data_collection"
                                    ),
                                }
                            ],
                        }
                    }
                )
            )
        finally:
            settings.trading_mode = original_mode

    def test_paper_route_target_plan_from_payload_prefers_next_window_targets(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "live_submission_gate": {
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-OLD",
                                "candidate_id": "stale-probation-target",
                            }
                        ],
                    }
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0")

    def test_paper_route_target_plan_payload_prefers_selected_top_level_targets(
        self,
    ) -> None:
        selected_tsmom_target = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "strategy_name": "intraday-tsmom-profit-v3",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "source_kind": "runtime_ledger_source_collection_candidate",
            "selected_by": "paper_route_observed_strategy_source_collection",
        }
        raw_contaminated_hpairs_target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "selected_by": "paper_route_evidence_audit",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_account_contamination_state": {
                "foreign_strategy_counts": {"intraday-tsmom-profit-v3": 26}
            },
        }

        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "source": "paper_route_target_plan_endpoint",
                "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                "target_count": 1,
                "targets": [selected_tsmom_target],
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "source": "paper_route_observed_strategy_source_collection",
                    "target_count": 1,
                    "targets": [selected_tsmom_target],
                },
                "source_runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "source": "paper_route_observed_strategy_source_collection",
                    "target_count": 1,
                    "targets": [selected_tsmom_target],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": (
                        "torghut.next-paper-route-runtime-window-targets.v1"
                    ),
                    "source": "paper_route_evidence_audit",
                    "target_count": 1,
                    "targets": [raw_contaminated_hpairs_target],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(
            plan["targets"][0]["selected_by"],
            "paper_route_evidence_audit",
        )
        self.assertEqual(
            plan["targets"][0]["paper_route_probe_symbols"], ["AAPL", "AMZN"]
        )

    def test_paper_route_target_plan_payload_prefers_next_window_over_closed_import(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "closed-window-target",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "next_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "next-window-target",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "next-window-target")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-06-01T13:30:00+00:00"
        )

    def test_paper_route_target_plan_from_payload_prefers_clean_after_discard(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "next_clean_paper_route_runtime_window_targets_after_discard": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "next_clean_session_paper_route_runtime_window_collection_after_discard",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "clean-followup-target",
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "contaminated-closed-target",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "clean-followup-target")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-06-02T13:30:00+00:00"
        )

    def test_paper_route_target_plan_from_payload_falls_back_to_source_plan(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
                "source_runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-source-scope",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "candidate-source-scope")

    def test_paper_route_target_plan_from_payload_requires_targets(self) -> None:
        self.assertEqual(
            _paper_route_target_plan_from_payload(
                {
                    "runtime_window_import_plan": {
                        "target_count": 1,
                    },
                    "runtime_ledger_paper_probation_import_plan": {
                        "targets": "not-a-target-list",
                    },
                }
            ),
            {},
        )

    def test_status_probe_symbols_accept_clean_window_baseline_state(self) -> None:
        plan = {
            "schema_version": "torghut.paper-route-target-plan.v1",
            "target_count": 1,
            "targets": [
                {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "paper_route_clean_window_baseline_state": {
                        "symbols": [" aapl "],
                        "source_audit": {
                            "symbols": ["AMZN"],
                        },
                    },
                }
            ],
        }

        self.assertEqual(
            proofs_api._paper_route_target_plan_probe_symbols(plan),
            ["AAPL", "AMZN"],
        )

    def test_fetch_paper_route_target_plan_url_rejects_invalid_url(self) -> None:
        self.assertEqual(
            _fetch_paper_route_target_plan_url(
                "file:///tmp/plan.json",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_scheme:file"},
        )
        self.assertEqual(
            _fetch_paper_route_target_plan_url(
                "http:///missing-host",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_host"},
        )

    def test_fetch_paper_route_target_plan_url_validates_response(self) -> None:
        class FakeResponse:
            def __init__(self, status: int, raw: bytes) -> None:
                self.status = status
                self._raw = raw

            def read(self, size: int) -> bytes:
                self.read_size = size
                return self._raw

        def connection_class(status: int, raw: bytes) -> type[Any]:
            class FakeConnection:
                instances: list["FakeConnection"] = []

                def __init__(
                    self,
                    hostname: str,
                    port: int | None,
                    *,
                    timeout: float,
                ) -> None:
                    self.hostname = hostname
                    self.port = port
                    self.timeout = timeout
                    self.request_path: str | None = None
                    self.closed = False
                    self.instances.append(self)

                def request(
                    self,
                    method: str,
                    path: str,
                    *,
                    headers: dict[str, str],
                ) -> None:
                    self.request_method = method
                    self.request_path = path
                    self.request_headers = headers

                def getresponse(self) -> FakeResponse:
                    return FakeResponse(status, raw)

                def close(self) -> None:
                    self.closed = True

            return FakeConnection

        http_error_connection = connection_class(503, b"{}")
        with patch("app.api.proofs.HTTPConnection", http_error_connection):
            self.assertEqual(
                _fetch_paper_route_target_plan_url(
                    "http://torghut.example/trading/proofs?kind=runtime_window",
                    timeout_seconds=0,
                ),
                {"load_error": "paper_route_target_plan_http_status:503"},
            )
        self.assertEqual(http_error_connection.instances[0].hostname, "torghut.example")
        self.assertEqual(
            http_error_connection.instances[0].request_path,
            "/trading/proofs?kind=runtime_window",
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Host"],
            "torghut.example",
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Connection"], "close"
        )
        self.assertEqual(http_error_connection.instances[0].timeout, 0.1)
        self.assertTrue(http_error_connection.instances[0].closed)

        retried_error_connection = connection_class(503, b"{}")
        with (
            patch("app.api.proofs.HTTPConnection", retried_error_connection),
            patch("app.api.proofs.time.sleep") as sleep,
        ):
            failed_retry = _fetch_paper_route_target_plan_url(
                "http://torghut.example/trading/proofs?kind=runtime_window",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(
            failed_retry,
            {
                "load_error": "paper_route_target_plan_http_status:503",
                "fetch_attempts": 2,
            },
        )
        sleep.assert_called_once_with(0.0)
        self.assertEqual(len(retried_error_connection.instances), 2)

        class FlakyConnection:
            instances: list["FlakyConnection"] = []
            responses = [
                FakeResponse(503, b"{}"),
                FakeResponse(
                    200,
                    json.dumps(
                        {
                            "runtime_window_import_plan": {
                                "targets": [
                                    {
                                        "candidate_id": "retry-candidate",
                                        "paper_route_probe_symbols": ["AAPL"],
                                    }
                                ]
                            }
                        }
                    ).encode("utf-8"),
                ),
            ]

            def __init__(
                self,
                hostname: str,
                port: int | None,
                *,
                timeout: float,
            ) -> None:
                self.hostname = hostname
                self.port = port
                self.timeout = timeout
                self.closed = False
                self.instances.append(self)

            def request(
                self,
                method: str,
                path: str,
                *,
                headers: dict[str, str],
            ) -> None:
                self.request_method = method
                self.request_path = path
                self.request_headers = headers

            def getresponse(self) -> FakeResponse:
                return self.responses[len(self.instances) - 1]

            def close(self) -> None:
                self.closed = True

        FlakyConnection.instances = []
        with patch("app.api.proofs.HTTPConnection", FlakyConnection):
            app_retried_plan = _fetch_paper_route_target_plan_url(
                "http://torghut.example/trading/proofs?kind=runtime_window",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(app_retried_plan["fetch_attempts"], 2)
        self.assertEqual(
            app_retried_plan["targets"][0]["candidate_id"], "retry-candidate"
        )
        self.assertEqual(len(FlakyConnection.instances), 2)

        FlakyConnection.instances = []
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            FlakyConnection,
        ):
            retried_plan = shared_fetch_paper_route_target_plan_url(
                "http://torghut.example/trading/proofs?kind=runtime_window",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(retried_plan["fetch_attempts"], 2)
        self.assertEqual(
            paper_route_target_plan_probe_symbols(retried_plan),
            {"AAPL"},
        )
        self.assertEqual(len(FlakyConnection.instances), 2)
        self.assertTrue(all(item.closed for item in FlakyConnection.instances))

        for raw, expected in (
            (b"{", "paper_route_target_plan_invalid_json:"),
            (b"[]", "paper_route_target_plan_invalid_payload"),
            (
                json.dumps({"runtime_window_import_plan": {"targets": []}}).encode(
                    "utf-8"
                ),
                "paper_route_target_plan_missing",
            ),
            (b"x" * 5_000_001, "paper_route_target_plan_response_too_large"),
        ):
            fake_connection = connection_class(200, raw)
            with patch("app.api.proofs.HTTPConnection", fake_connection):
                result = _fetch_paper_route_target_plan_url(
                    "http://torghut.example/trading/proofs?kind=runtime_window",
                    timeout_seconds=1,
                )
            self.assertTrue(str(result["load_error"]).startswith(expected))

        success_connection = connection_class(
            200,
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                            }
                        ]
                    }
                }
            ).encode("utf-8"),
        )
        with patch("app.api.proofs.HTTPConnection", success_connection):
            plan = _fetch_paper_route_target_plan_url(
                "http://torghut.example/trading/proofs?kind=runtime_window",
                timeout_seconds=3,
            )
        self.assertEqual(plan["source"], "external_paper_route_target_plan")
        self.assertEqual(plan["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0")
