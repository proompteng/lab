from __future__ import annotations

# ruff: noqa: F403,F405
from tests.api.trading_api_support import *


class TestTradingApiPaperRouteExternal(TradingApiTestCaseBase):
    def test_shared_paper_route_target_plan_helpers_validate_response(self) -> None:
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

        self.assertEqual(
            shared_fetch_paper_route_target_plan_url(
                "file:///tmp/plan.json",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_scheme:file"},
        )
        self.assertEqual(
            shared_fetch_paper_route_target_plan_url(
                "http:///missing-host",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_host"},
        )

        http_error_connection = connection_class(503, b"{}")
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            http_error_connection,
        ):
            self.assertEqual(
                shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example/plan?mode=paper",
                    timeout_seconds=0,
                ),
                {"load_error": "paper_route_target_plan_http_status:503"},
            )
        self.assertEqual(http_error_connection.instances[0].hostname, "torghut.example")
        self.assertEqual(
            http_error_connection.instances[0].request_path, "/plan?mode=paper"
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

        retry_exhausted_connection = connection_class(503, b"{}")
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            retry_exhausted_connection,
        ):
            self.assertEqual(
                shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example/plan?mode=paper",
                    timeout_seconds=0,
                    attempts=2,
                    retry_backoff_seconds=0,
                ),
                {
                    "load_error": "paper_route_target_plan_http_status:503",
                    "fetch_attempts": 2,
                },
            )
        self.assertEqual(len(retry_exhausted_connection.instances), 2)
        self.assertTrue(
            all(item.closed for item in retry_exhausted_connection.instances)
        )

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
            with patch(
                "app.trading.paper_route_target_plan.HTTPConnection",
                fake_connection,
            ):
                result = shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example",
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
                                "paper_route_probe_symbols": " aapl, AMZN ",
                            },
                            {
                                "candidate_id": "other",
                                "paper_route_probe_symbols": [],
                            },
                            {
                                "candidate_id": "missing-symbols",
                            },
                        ]
                    }
                }
            ).encode("utf-8"),
        )
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            success_connection,
        ):
            plan = shared_fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=3,
            )
        self.assertEqual(plan["source"], "external_paper_route_target_plan")
        self.assertEqual(
            paper_route_target_plan_probe_symbols(plan),
            {"AAPL", "AMZN"},
        )

    def test_load_external_paper_route_target_plan_uses_configured_url(self) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_timeout = settings.trading_paper_route_target_plan_timeout_seconds
        try:
            settings.trading_paper_route_target_plan_url = "  "
            self.assertEqual(_load_external_paper_route_target_plan(), {})

            settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
            settings.trading_paper_route_target_plan_timeout_seconds = 7
            with patch(
                "app.main._fetch_paper_route_target_plan_url",
                return_value={"targets": [{"candidate_id": "candidate"}]},
            ) as fetch:
                plan = _load_external_paper_route_target_plan()
            self.assertEqual(plan["targets"][0]["candidate_id"], "candidate")
            fetch.assert_called_once_with(
                "http://torghut.example/plan",
                timeout_seconds=7,
                attempts=3,
                retry_backoff_seconds=0.25,
            )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            settings.trading_paper_route_target_plan_timeout_seconds = original_timeout

    def test_load_external_paper_route_target_plan_rejects_self_reference(self) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_cache = main_module._paper_route_target_plan_success_cache
        main_module._paper_route_target_plan_success_cache = None
        try:
            settings.trading_paper_route_target_plan_url = "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan"
            with (
                patch.dict(
                    os.environ,
                    {
                        "K_SERVICE": "torghut-sim",
                        "POD_NAMESPACE": "",
                        "NAMESPACE": "",
                    },
                ),
                patch("app.main.HTTPConnection") as connection,
            ):
                plan = _load_external_paper_route_target_plan()
            connection.assert_not_called()
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            main_module._paper_route_target_plan_success_cache = original_cache

        self.assertEqual(plan["load_error"], "paper_route_target_plan_self_reference")

    def test_paper_route_target_plan_self_reference_requires_host(self) -> None:
        parsed = urlsplit("/trading/paper-route-target-plan")

        self.assertFalse(
            main_module._paper_route_target_plan_url_points_to_self(parsed)
        )

    def test_paper_route_target_plan_self_reference_matches_current_service(
        self,
    ) -> None:
        parsed = urlsplit(
            "http://route-sim.proof-ns.svc.cluster.local/trading/paper-route-target-plan"
        )

        with patch.dict(
            os.environ,
            {
                "K_SERVICE": "route-sim",
                "POD_NAMESPACE": "proof-ns",
            },
        ):
            self.assertTrue(
                main_module._paper_route_target_plan_url_points_to_self(parsed)
            )

    def test_paper_route_target_plan_self_reference_allows_live_from_sim(
        self,
    ) -> None:
        parsed = urlsplit(
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )

        with patch.dict(
            os.environ,
            {
                "K_SERVICE": "torghut-sim",
                "POD_NAMESPACE": "",
                "NAMESPACE": "",
            },
        ):
            self.assertFalse(
                main_module._paper_route_target_plan_url_points_to_self(parsed)
            )

    def test_paper_route_target_plan_self_reference_defaults_torghut_namespace(
        self,
    ) -> None:
        parsed = urlsplit(
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )

        with patch.dict(
            os.environ,
            {
                "K_SERVICE": "torghut",
                "POD_NAMESPACE": "",
                "NAMESPACE": "",
            },
        ):
            self.assertTrue(
                main_module._paper_route_target_plan_url_points_to_self(parsed)
            )

    def test_load_external_paper_route_target_plan_uses_recent_success_after_timeout(
        self,
    ) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_timeout = settings.trading_paper_route_target_plan_timeout_seconds
        original_cache = main_module._paper_route_target_plan_success_cache
        settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
        settings.trading_paper_route_target_plan_timeout_seconds = 7
        main_module._paper_route_target_plan_success_cache = None
        success_plan = {
            "source": "external_paper_route_target_plan",
            "targets": [
                {
                    "candidate_id": "candidate-stale-safe",
                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                }
            ],
        }
        try:
            with (
                patch(
                    "app.main._fetch_paper_route_target_plan_url",
                    side_effect=[
                        success_plan,
                        {
                            "load_error": (
                                "paper_route_target_plan_fetch_failed:timed out"
                            )
                        },
                    ],
                ),
                patch(
                    "app.main.time.time",
                    side_effect=[1000.0, 1005.0, 1005.0, 1005.0],
                ),
            ):
                first_plan = _load_external_paper_route_target_plan()
                second_plan = _load_external_paper_route_target_plan()
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            settings.trading_paper_route_target_plan_timeout_seconds = original_timeout
            main_module._paper_route_target_plan_success_cache = original_cache

        self.assertEqual(
            first_plan["targets"][0]["candidate_id"],
            "candidate-stale-safe",
        )
        self.assertEqual(
            second_plan["paper_route_target_plan_cache_status"], "stale_success"
        )
        self.assertEqual(
            second_plan["paper_route_target_plan_last_load_error"],
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(
            second_plan["targets"][0]["candidate_id"],
            "candidate-stale-safe",
        )

    def test_external_paper_route_target_plan_cache_fails_closed_when_unusable(
        self,
    ) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_cache = main_module._paper_route_target_plan_success_cache
        settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
        main_module._paper_route_target_plan_success_cache = None
        try:
            with patch(
                "app.main._fetch_paper_route_target_plan_url",
                return_value={
                    "load_error": "paper_route_target_plan_fetch_failed:timed out"
                },
            ):
                plan = _load_external_paper_route_target_plan()
            self.assertEqual(
                plan["load_error"],
                "paper_route_target_plan_fetch_failed:timed out",
            )

            main_module._paper_route_target_plan_success_cache = ("sentinel", 1000.0)
            main_module._remember_external_paper_route_target_plan_success(
                {"targets": []}
            )
            self.assertEqual(
                main_module._paper_route_target_plan_success_cache,
                ("sentinel", 1000.0),
            )

            main_module._paper_route_target_plan_success_cache = None
            self.assertEqual(
                main_module._cached_external_paper_route_target_plan_success(
                    "paper_route_target_plan_fetch_failed:missing"
                ),
                {},
            )

            main_module._paper_route_target_plan_success_cache = (
                {"targets": [{"candidate_id": "expired"}]},
                1000.0,
            )
            with patch("app.main.time.time", return_value=2000.0):
                self.assertEqual(
                    main_module._cached_external_paper_route_target_plan_success(
                        "paper_route_target_plan_fetch_failed:expired"
                    ),
                    {},
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            main_module._paper_route_target_plan_success_cache = original_cache

    def test_merge_external_paper_route_target_plan_fails_closed(self) -> None:
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [{"candidate_id": "local"}],
            }
        }
        with patch(
            "app.main._load_external_paper_route_target_plan"
        ) as external_loader:
            self.assertEqual(
                _merge_external_paper_route_target_plan(local_gate), local_gate
            )
        external_loader.assert_not_called()

        with patch("app.main._load_external_paper_route_target_plan", return_value={}):
            self.assertEqual(_merge_external_paper_route_target_plan({}), {})

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={},
            ):
                self.assertEqual(
                    _merge_external_paper_route_target_plan(local_gate),
                    local_gate,
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"targets": []},
            ):
                self.assertEqual(
                    _merge_external_paper_route_target_plan(local_gate),
                    local_gate,
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        with patch(
            "app.main._load_external_paper_route_target_plan",
            return_value={"load_error": "paper_route_target_plan_missing"},
        ):
            gate = _merge_external_paper_route_target_plan({})
        self.assertEqual(
            gate["paper_route_target_plan_error"],
            "paper_route_target_plan_missing",
        )

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"load_error": "paper_route_target_plan_missing"},
            ):
                gate = _merge_external_paper_route_target_plan(local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_source"], "external_target_plan_url"
            )
            self.assertEqual(
                gate["paper_route_target_plan_error"],
                "paper_route_target_plan_missing",
            )
            self.assertEqual(plan["target_count"], 0)
            self.assertEqual(plan["skipped_target_count"], 1)
            self.assertEqual(plan["targets"], [])
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        safe_local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
                "targets": [
                    {
                        "candidate_id": "safe-local",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "final_promotion_authorized": False,
                    }
                ],
            }
        }
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"load_error": "paper_route_target_plan_timeout"},
            ):
                gate = _merge_external_paper_route_target_plan(safe_local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_error"],
                "paper_route_target_plan_timeout",
            )
            self.assertEqual(
                gate["paper_route_target_plan_source"],
                "local_runtime_ledger_paper_probation_import_plan",
            )
            self.assertEqual(
                gate["paper_route_target_plan_external_source"],
                "external_target_plan_url",
            )
            self.assertEqual(plan["target_count"], 1)
            self.assertEqual(plan["targets"][0]["candidate_id"], "safe-local")
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={
                    "promotion_allowed": True,
                    "final_promotion_allowed": True,
                    "final_promotion_authorized": True,
                    "targets": [
                        {
                            "candidate_id": "external",
                            "paper_route_probe_symbols": ["AAPL"],
                        }
                    ],
                },
            ):
                gate = _merge_external_paper_route_target_plan(local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_source"], "external_target_plan_url"
            )
            self.assertEqual(plan["target_count"], 1)
            self.assertEqual(plan["targets"][0]["candidate_id"], "external")
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        with patch(
            "app.main._load_external_paper_route_target_plan",
            return_value={
                "paper_route_target_plan_cache_status": "stale_success",
                "paper_route_target_plan_last_load_error": "paper_route_timeout",
                "promotion_allowed": True,
                "final_promotion_allowed": True,
                "final_promotion_authorized": True,
                "targets": [
                    {
                        "candidate_id": "external",
                        "paper_route_probe_symbols": ["AAPL"],
                    }
                ],
            },
        ):
            gate = _merge_external_paper_route_target_plan({})
        plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(
            gate["paper_route_target_plan_source"], "external_target_plan_url"
        )
        self.assertEqual(gate["paper_route_target_plan_cache_status"], "stale_success")
        self.assertEqual(gate["paper_route_target_plan_error"], "paper_route_timeout")
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])
        self.assertFalse(plan["final_promotion_authorized"])
        self.assertEqual(
            plan["targets"][0]["paper_route_target_plan_source"],
            "external_target_plan_url",
        )
        self.assertEqual(
            plan["targets"][0]["paper_route_probe_scope_authority"],
            "external_target_plan",
        )

    def test_trading_llm_evaluation_endpoint(self) -> None:
        response = self.client.get("/trading/llm-evaluation")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        metrics = payload["metrics"]
        self.assertEqual(metrics["tokens"]["prompt"], 120)
        self.assertEqual(metrics["tokens"]["completion"], 45)
