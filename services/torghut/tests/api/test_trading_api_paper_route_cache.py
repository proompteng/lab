from __future__ import annotations

from app.api import proofs as proofs_api

from tests.api.trading_api_support import (
    SimpleNamespace,
    Strategy,
    TradingApiTestCaseBase,
    _build_live_submission_gate_payload,
    datetime,
    patch,
    timezone,
)


class TestTradingApiPaperRouteCache(TradingApiTestCaseBase):
    def test_paper_route_target_plan_cache_safety(self) -> None:
        self.assertFalse(proofs_api._paper_route_target_plan_truthy(0))
        self.assertTrue(proofs_api._paper_route_target_plan_truthy(1))
        self.assertFalse(proofs_api._paper_route_target_plan_cache_safe_for_live({}))
        unsafe_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": True,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            }
        }
        self.assertFalse(
            proofs_api._paper_route_target_plan_cache_safe_for_live(
                unsafe_gate["runtime_ledger_paper_probation_import_plan"]
            )
        )
        unsafe_target_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "final_promotion_authorized": "yes",
                    }
                ],
            }
        }
        self.assertFalse(
            proofs_api._paper_route_target_plan_cache_safe_for_live(
                unsafe_target_gate["runtime_ledger_paper_probation_import_plan"]
            )
        )
        self.assertFalse(
            proofs_api._paper_route_source_collection_target_cache_safe(
                {
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "window_start": "2026-05-13T17:00:00+00:00",
                }
            )
        )
        self.assertTrue(
            proofs_api._paper_route_source_collection_target_cache_safe(
                {
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "window_start": "2026-05-13T17:00:00+00:00",
                    "window_end": "2026-05-13T17:30:00+00:00",
                    "source_window_ids": ["runtime-ledger-window-20260513T1700Z"],
                }
            )
        )
        unsafe_source_collection_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "source_account_label": "TORGHUT_SIM",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                        "source_collection_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            }
        }
        self.assertFalse(
            proofs_api._paper_route_target_plan_cache_safe_for_live(
                unsafe_source_collection_gate[
                    "runtime_ledger_paper_probation_import_plan"
                ]
            )
        )
        source_collection_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "source_account_label": "TORGHUT_SIM",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                        "source_collection_authorized": True,
                        "window_start": "2026-05-13T17:00:00+00:00",
                        "window_end": "2026-05-13T17:30:00+00:00",
                        "runtime_ledger_bucket_ref": (
                            "strategy_runtime_ledger_buckets:run:2026-05-13T17:00:00+00:00:"
                            "2026-05-13T17:30:00+00:00"
                        ),
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            }
        }
        self.assertTrue(
            proofs_api._paper_route_target_plan_cache_safe_for_live(
                source_collection_gate["runtime_ledger_paper_probation_import_plan"]
            )
        )

    def test_paper_route_target_strategy_lookup_names_skip_missing_values(
        self,
    ) -> None:
        names = proofs_api._paper_route_target_strategy_lookup_names(
            {
                "strategy_lookup_names": [
                    " source-strategy ",
                    "source-strategy",
                    12,
                ],
                "runtime_strategy_name": "runtime-strategy",
                "strategy_name": "source-strategy",
            }
        )

        self.assertEqual(
            names,
            ["source-strategy", "12", "runtime-strategy"],
        )
        self.assertEqual(
            proofs_api._paper_route_target_strategy_lookup_names({}),
            [],
        )

    def test_paper_route_probe_symbols_resolve_target_strategy_universe(
        self,
    ) -> None:
        with self.session_local() as session:
            session.add_all(
                [
                    Strategy(
                        name="route-target-source",
                        description="route target source",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=[" msft ", "", "AAPL", "MSFT"],
                    ),
                    Strategy(
                        name="route-target-string-universe",
                        description="route target string universe",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols="TSLA",
                    ),
                ]
            )
            session.commit()

            self.assertEqual(
                proofs_api._paper_route_probe_symbols_from_target_plan_strategies(
                    session,
                    [{}],
                ),
                [],
            )
            symbols = proofs_api._paper_route_probe_symbols_from_target_plan_strategies(
                session,
                [
                    {
                        "strategy_lookup_names": [
                            "route-target-source",
                            "route-target-string-universe",
                            "route-target-source",
                        ],
                        "runtime_strategy_name": "route-target-source",
                        "strategy_name": "route-target-string-universe",
                    }
                ],
            )

        self.assertEqual(symbols, ["MSFT", "AAPL"])

    def test_paper_route_probe_book_uses_strategy_universe_when_symbols_missing(
        self,
    ) -> None:
        with self.session_local() as session:
            session.add(
                Strategy(
                    name="route-book-source",
                    description="route book source",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["aapl", "MSFT"],
                )
            )
            session.commit()

            book = proofs_api._paper_route_probe_book_from_target_plan(
                {
                    "paper_route_target_plan_source": "cached_live_submission_gate",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "candidate-strategy-universe",
                                "strategy_lookup_names": ["route-book-source"],
                                "paper_route_probe_next_session_max_notional": "25000",
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                            }
                        ],
                    },
                },
                simple_lane_status={"paper_route_probe_enabled": True},
                state=SimpleNamespace(market_session_open=True),
                session=session,
            )

        self.assertIsNotNone(book)
        assert book is not None
        self.assertEqual(
            book["summary"]["paper_route_probe_eligible_symbols"], ["AAPL", "MSFT"]
        )
        self.assertEqual(book["paper_route_probe"]["active_symbols"], ["AAPL", "MSFT"])
        self.assertEqual(book["paper_route_probe"]["effective_max_notional"], "25000")
        self.assertEqual(book["source_refs"]["target_plan_target_count"], 1)
        self.assertEqual(
            book["source_refs"]["target_plan_source"], "cached_live_submission_gate"
        )

    def test_configured_paper_collection_plan_targets_enabled_strategy_universe(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        original_account_label = proofs_api.settings.trading_account_label
        original_static_symbols_raw = proofs_api.settings.trading_static_symbols_raw
        try:
            proofs_api.settings.trading_mode = "live"
            proofs_api.settings.trading_account_label = "PA3SX7FYNUTF"
            proofs_api.settings.trading_static_symbols_raw = "AAPL,NVDA"
            with self.session_local() as session:
                session.add_all(
                    [
                        Strategy(
                            name="enabled-paper-collector",
                            description="configured paper collection",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["AAPL", "MSFT", "NVDA"],
                        ),
                        Strategy(
                            name="disabled-paper-collector",
                            description="disabled paper collection",
                            enabled=False,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["AAPL"],
                        ),
                    ]
                )
                session.commit()

                plan = proofs_api._configured_paper_collection_target_plan(
                    session,
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                )
        finally:
            proofs_api.settings.trading_mode = original_mode
            proofs_api.settings.trading_account_label = original_account_label
            proofs_api.settings.trading_static_symbols_raw = original_static_symbols_raw

        self.assertGreaterEqual(plan["target_count"], 1)
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])
        targets_by_name = {
            target["strategy_name"]: target for target in plan["targets"]
        }
        self.assertIn("enabled-paper-collector", targets_by_name)
        self.assertNotIn("disabled-paper-collector", targets_by_name)
        target = targets_by_name["enabled-paper-collector"]
        self.assertEqual(target["account_label"], "PA3SX7FYNUTF")
        self.assertEqual(target["source_account_label"], "PA3SX7FYNUTF")
        self.assertEqual(target["execution_account_label"], "PA3SX7FYNUTF")
        self.assertEqual(target["bounded_collection_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["hypothesis_id"],
            "configured-paper-collection:enabled-paper-collector",
        )
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL", "NVDA"])
        self.assertEqual(
            target["paper_route_probe_symbol_actions"],
            {"AAPL": "buy", "NVDA": "buy"},
        )
        self.assertEqual(target["paper_route_probe_next_session_max_notional"], "100")
        self.assertTrue(target["paper_data_collection_authorized"])
        self.assertFalse(target["final_promotion_authorized"])

    def test_configured_paper_collection_helpers_cover_empty_and_limit_branches(
        self,
    ) -> None:
        original_static_symbols_raw = proofs_api.settings.trading_static_symbols_raw
        try:
            proofs_api.settings.trading_static_symbols_raw = ""
            self.assertEqual(
                proofs_api._strategy_universe_symbol_values(" aapl,,MSFT,AAPL "),
                ["AAPL", "MSFT"],
            )
            self.assertEqual(proofs_api._strategy_universe_symbol_values(42), [])
            self.assertEqual(
                proofs_api._configured_strategy_paper_collection_symbols(
                    Strategy(
                        name="strategy-only-symbols",
                        description="strategy-only-symbols",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["TSLA"],
                    )
                ),
                ["TSLA"],
            )

            proofs_api.settings.trading_static_symbols_raw = "AAPL"
            self.assertEqual(
                proofs_api._configured_strategy_paper_collection_symbols(
                    Strategy(
                        name="static-fallback-symbols",
                        description="static-fallback-symbols",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=[],
                    )
                ),
                ["AAPL"],
            )

            proofs_api.settings.trading_static_symbols_raw = ""
            with self.session_local() as session:
                session.add_all(
                    [
                        Strategy(
                            name="empty-symbols",
                            description="empty symbols",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=[],
                        ),
                        Strategy(
                            name=" ",
                            description="blank name",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["AAPL"],
                        ),
                        Strategy(
                            name="limited-0",
                            description="limited 0",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["AAPL"],
                        ),
                        Strategy(
                            name="limited-1",
                            description="limited 1",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["MSFT"],
                        ),
                        Strategy(
                            name="limited-2",
                            description="limited 2",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["NVDA"],
                        ),
                    ]
                )
                session.commit()

                with patch(
                    "app.api.proofs_configured_collection.DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
                    2,
                ):
                    targets = proofs_api._configured_strategy_paper_collection_targets(
                        session,
                        max_notional="100",
                    )
        finally:
            proofs_api.settings.trading_static_symbols_raw = original_static_symbols_raw

        target_names = [target["strategy_name"] for target in targets]
        self.assertEqual(len(target_names), 2)
        self.assertNotIn(" ", target_names)
        self.assertNotIn("empty-symbols", target_names)
        self.assertNotIn("limited-2", target_names)

    def test_configured_paper_collection_plan_blocks_invalid_configs(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        original_static_symbols_raw = proofs_api.settings.trading_static_symbols_raw
        try:
            proofs_api.settings.trading_mode = "paper"
            with self.session_local() as session:
                self.assertEqual(
                    proofs_api._configured_paper_collection_target_plan(
                        session,
                        simple_lane_status={
                            "paper_route_probe_enabled": True,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "100",
                        },
                    ),
                    {},
                )

            proofs_api.settings.trading_mode = "live"
            proofs_api.settings.trading_static_symbols_raw = ""
            with self.session_local() as session:
                self.assertEqual(
                    proofs_api._configured_paper_collection_target_plan(
                        session,
                        simple_lane_status={
                            "paper_route_probe_enabled": True,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "0",
                        },
                    ),
                    {},
                )
                with patch(
                    "app.api.proofs_configured_collection._decimal_to_string",
                    return_value=None,
                ):
                    self.assertEqual(
                        proofs_api._configured_paper_collection_target_plan(
                            session,
                            simple_lane_status={
                                "paper_route_probe_enabled": True,
                                "paper_route_probe_allow_live_mode": True,
                                "paper_route_probe_max_notional": "100",
                            },
                        ),
                        {},
                    )
                for strategy in session.execute(proofs_api.select(Strategy)).scalars():
                    strategy.enabled = False
                session.commit()
                self.assertEqual(
                    proofs_api._configured_paper_collection_target_plan(
                        session,
                        simple_lane_status={
                            "paper_route_probe_enabled": True,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "100",
                        },
                    ),
                    {},
                )
        finally:
            proofs_api.settings.trading_mode = original_mode
            proofs_api.settings.trading_static_symbols_raw = original_static_symbols_raw

    def test_configured_paper_collection_fallback_upserts_only_when_plan_missing(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        original_static_symbols_raw = proofs_api.settings.trading_static_symbols_raw
        try:
            proofs_api.settings.trading_mode = "live"
            proofs_api.settings.trading_static_symbols_raw = "AAPL"
            existing_payload = {
                "runtime_ledger_paper_probation_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "existing",
                            "account_label": "TORGHUT_SIM",
                            "paper_route_probe_symbols": ["MSFT"],
                        }
                    ],
                }
            }
            with self.session_local() as session:
                self.assertEqual(
                    proofs_api._with_configured_paper_collection_targets(
                        existing_payload,
                        simple_lane_status={
                            "paper_route_probe_enabled": True,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "100",
                        },
                        session=session,
                    ),
                    existing_payload,
                )
                self.assertEqual(
                    proofs_api._with_configured_paper_collection_targets(
                        {},
                        simple_lane_status={
                            "paper_route_probe_enabled": False,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "100",
                        },
                        session=session,
                    ),
                    {},
                )
                session.add(
                    Strategy(
                        name="fallback-collector",
                        description="fallback collector",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                    )
                )
                session.commit()
                payload = proofs_api._with_configured_paper_collection_targets(
                    {},
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                    session=session,
                )
        finally:
            proofs_api.settings.trading_mode = original_mode
            proofs_api.settings.trading_static_symbols_raw = original_static_symbols_raw

        self.assertEqual(
            payload["paper_route_target_plan_source"],
            "configured_simple_lane_paper_data_collection",
        )
        self.assertTrue(payload["paper_route_target_plan_fallback"])
        self.assertEqual(
            payload["paper_route_target_plan_fallback_reason"],
            "configured_strategy_catalog_paper_collection",
        )
        target_names = {
            target["strategy_name"]
            for target in payload["runtime_ledger_paper_probation_import_plan"][
                "targets"
            ]
        }
        self.assertIn("fallback-collector", target_names)

    def test_paper_route_probe_book_allows_live_mode_collection_when_activated(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        try:
            proofs_api.settings.trading_mode = "live"
            with patch(
                "app.api.proofs._live_submit_activation_status",
                return_value={
                    "configured": True,
                    "valid": True,
                    "expired": False,
                    "expires_at": "2026-06-17T20:05:00+00:00",
                    "reason": None,
                },
            ):
                book = proofs_api._paper_route_probe_book_from_target_plan(
                    {
                        "paper_route_target_plan_source": "configured_strategy_catalog",
                        "runtime_ledger_paper_probation_import_plan": {
                            "schema_version": (
                                "torghut.runtime-ledger-paper-probation-import-plan.v1"
                            ),
                            "target_count": 1,
                            "targets": [
                                {
                                    "candidate_id": "configured:collector",
                                    "strategy_lookup_names": ["collector"],
                                    "account_label": "TORGHUT_SIM",
                                    "paper_route_probe_symbols": ["AAPL"],
                                    "paper_route_probe_next_session_max_notional": "100",
                                    "paper_data_collection_authorized": True,
                                    "promotion_allowed": False,
                                    "final_promotion_allowed": False,
                                }
                            ],
                        },
                    },
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                    state=SimpleNamespace(market_session_open=True),
                )
        finally:
            proofs_api.settings.trading_mode = original_mode

        self.assertIsNotNone(book)
        assert book is not None
        self.assertTrue(book["paper_route_probe"]["active"])
        self.assertEqual(book["paper_route_probe"]["effective_max_notional"], "100")
        self.assertEqual(book["paper_route_probe"]["active_symbols"], ["AAPL"])
        self.assertEqual(book["paper_route_probe"]["capital_authority"], "none")
        self.assertTrue(book["paper_route_probe"]["live_mode_collection_allowed"])

    def test_paper_route_probe_book_blocks_live_mode_after_activation_expiry(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        try:
            proofs_api.settings.trading_mode = "live"
            with patch(
                "app.api.proofs._live_submit_activation_status",
                return_value={
                    "configured": True,
                    "valid": True,
                    "expired": True,
                    "reason": "live_submit_activation_expired",
                },
            ):
                book = proofs_api._paper_route_probe_book_from_target_plan(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "schema_version": (
                                "torghut.runtime-ledger-paper-probation-import-plan.v1"
                            ),
                            "target_count": 1,
                            "targets": [
                                {
                                    "candidate_id": "configured:collector",
                                    "account_label": "TORGHUT_SIM",
                                    "paper_route_probe_symbols": ["AAPL"],
                                    "paper_route_probe_next_session_max_notional": "100",
                                    "promotion_allowed": False,
                                    "final_promotion_allowed": False,
                                }
                            ],
                        },
                    },
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                    state=SimpleNamespace(market_session_open=True),
                )
        finally:
            proofs_api.settings.trading_mode = original_mode

        self.assertIsNotNone(book)
        assert book is not None
        self.assertFalse(book["paper_route_probe"]["active"])
        self.assertEqual(book["paper_route_probe"]["effective_max_notional"], "0")
        self.assertIn(
            "live_submit_activation_expired",
            book["paper_route_probe"]["blocking_reasons"],
        )

    def test_paper_route_probe_book_blocks_live_mode_without_activation_contract(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        try:
            proofs_api.settings.trading_mode = "live"
            with patch(
                "app.api.proofs._live_submit_activation_status",
                return_value={"configured": False},
            ):
                book = proofs_api._paper_route_probe_book_from_target_plan(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "schema_version": (
                                "torghut.runtime-ledger-paper-probation-import-plan.v1"
                            ),
                            "target_count": 1,
                            "targets": [
                                {
                                    "candidate_id": "configured:collector",
                                    "account_label": "TORGHUT_SIM",
                                    "paper_route_probe_symbols": ["AAPL"],
                                    "paper_route_probe_next_session_max_notional": "100",
                                    "promotion_allowed": False,
                                    "final_promotion_allowed": False,
                                }
                            ],
                        },
                    },
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                    state=SimpleNamespace(market_session_open=True),
                )
        finally:
            proofs_api.settings.trading_mode = original_mode

        self.assertIsNotNone(book)
        assert book is not None
        self.assertIn(
            "live_submit_activation_missing",
            book["paper_route_probe"]["blocking_reasons"],
        )

    def test_paper_route_probe_book_blocks_live_mode_when_activation_invalid(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        try:
            proofs_api.settings.trading_mode = "live"
            with patch(
                "app.api.proofs._live_submit_activation_status",
                return_value={"configured": True, "valid": False},
            ):
                book = proofs_api._paper_route_probe_book_from_target_plan(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "schema_version": (
                                "torghut.runtime-ledger-paper-probation-import-plan.v1"
                            ),
                            "target_count": 1,
                            "targets": [
                                {
                                    "candidate_id": "configured:collector",
                                    "account_label": "TORGHUT_SIM",
                                    "paper_route_probe_symbols": ["AAPL"],
                                    "paper_route_probe_next_session_max_notional": "100",
                                    "promotion_allowed": False,
                                    "final_promotion_allowed": False,
                                }
                            ],
                        },
                    },
                    simple_lane_status={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_allow_live_mode": True,
                        "paper_route_probe_max_notional": "100",
                    },
                    state=SimpleNamespace(market_session_open=True),
                )
        finally:
            proofs_api.settings.trading_mode = original_mode

        self.assertIsNotNone(book)
        assert book is not None
        self.assertIn(
            "live_submit_activation_invalid",
            book["paper_route_probe"]["blocking_reasons"],
        )

    def test_paper_route_probe_book_blocks_live_mode_when_live_collection_disabled(
        self,
    ) -> None:
        original_mode = proofs_api.settings.trading_mode
        try:
            proofs_api.settings.trading_mode = "live"
            book = proofs_api._paper_route_probe_book_from_target_plan(
                {
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "configured:collector",
                                "account_label": "TORGHUT_SIM",
                                "paper_route_probe_symbols": ["AAPL"],
                                "paper_route_probe_next_session_max_notional": "100",
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                            }
                        ],
                    },
                },
                simple_lane_status={
                    "paper_route_probe_enabled": True,
                    "paper_route_probe_allow_live_mode": False,
                    "paper_route_probe_max_notional": "100",
                },
                state=SimpleNamespace(market_session_open=True),
            )
        finally:
            proofs_api.settings.trading_mode = original_mode

        self.assertIsNotNone(book)
        assert book is not None
        self.assertIn(
            "live_paper_route_probe_collection_disabled",
            book["paper_route_probe"]["blocking_reasons"],
        )

    def test_deferred_live_gate_payload_preserves_dependency_quorum_for_target_plan(
        self,
    ) -> None:
        dependency_quorum = {
            "schema_version": "torghut.jangar-dependency-quorum.v1",
            "decision": "allow",
            "reason": "cached_quorum_allow",
        }

        with patch(
            "app.api.status_helpers._budget_unavailable_hypothesis_runtime_payload",
            return_value=(
                {
                    "registry_loaded": True,
                    "dependency_quorum": dependency_quorum,
                    "summary": {
                        "read_model_unavailable": True,
                        "reason_codes": [
                            "hypothesis_runtime_deferred_until_after_live_submission_gate"
                        ],
                    },
                    "items": [],
                },
                {},
                SimpleNamespace(as_payload=lambda: dependency_quorum),
            ),
        ):
            payload = proofs_api._deferred_hypothesis_payload_for_live_submission_gate()

        summary = payload["summary"]
        self.assertIsInstance(summary, dict)
        self.assertEqual(summary["dependency_quorum"], dependency_quorum)

        gate = _build_live_submission_gate_payload(
            SimpleNamespace(
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signals_present",
                last_signal_continuity_actionable=False,
            ),
            hypothesis_summary=payload,
            empirical_jobs_status={"ready": True},
            quant_health_status={
                "required": False,
                "ok": True,
                "status": "not_required",
                "blocking_reasons": [],
            },
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": datetime.now(timezone.utc).isoformat(),
            },
        )

        self.assertEqual(gate["dependency_quorum_decision"], "allow")
        self.assertEqual(gate["runtime_window_import_health_gate"]["blockers"], [])
        self.assertTrue(gate["runtime_window_import_health_gate"]["ready"])

    def test_deferred_live_gate_payload_leaves_missing_dependency_quorum_fail_closed(
        self,
    ) -> None:
        with patch(
            "app.api.status_helpers._budget_unavailable_hypothesis_runtime_payload",
            return_value=(
                {
                    "registry_loaded": True,
                    "summary": {
                        "read_model_unavailable": True,
                        "reason_codes": [
                            "hypothesis_runtime_deferred_until_after_live_submission_gate"
                        ],
                    },
                    "items": [],
                },
                {},
                SimpleNamespace(as_payload=lambda: {}),
            ),
        ):
            payload = proofs_api._deferred_hypothesis_payload_for_live_submission_gate()

        summary = payload["summary"]
        self.assertIsInstance(summary, dict)
        self.assertNotIn("dependency_quorum", summary)

    def test_deferred_live_gate_payload_ignores_malformed_dependency_quorum(
        self,
    ) -> None:
        with patch(
            "app.api.status_helpers._budget_unavailable_hypothesis_runtime_payload",
            return_value=(
                {
                    "registry_loaded": True,
                    "dependency_quorum": "cached_quorum_allow",
                    "summary": {
                        "read_model_unavailable": True,
                        "reason_codes": [
                            "hypothesis_runtime_deferred_until_after_live_submission_gate"
                        ],
                    },
                    "items": [],
                },
                {},
                SimpleNamespace(as_payload=lambda: {}),
            ),
        ):
            payload = proofs_api._deferred_hypothesis_payload_for_live_submission_gate()

        summary = payload["summary"]
        self.assertIsInstance(summary, dict)
        self.assertEqual(payload["dependency_quorum"], "cached_quorum_allow")
        self.assertNotIn("dependency_quorum", summary)
