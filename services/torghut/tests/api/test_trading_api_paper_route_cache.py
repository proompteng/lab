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
