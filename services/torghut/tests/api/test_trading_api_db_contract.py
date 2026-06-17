from __future__ import annotations

from tests.api.trading_api_support import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Decimal,
    SQLAlchemyError,
    TradingApiTestCaseBase,
    _assert_dspy_cutover_migration_guard,
    _build_route_image_proof_summary,
    _decimal_or_none,
    datetime,
    healthz,
    inspect,
    main_module,
    patch,
    settings,
    timezone,
)


class TestTradingApiDbContract(TradingApiTestCaseBase):
    def test_decimal_or_none_handles_missing_and_unparseable_values(self) -> None:
        self.assertIsNone(_decimal_or_none(None))
        self.assertIsNone(_decimal_or_none(object()))
        self.assertEqual(_decimal_or_none("1.25"), Decimal("1.25"))

    def test_route_image_proof_summary_preserves_route_workload_status(self) -> None:
        payload = _build_route_image_proof_summary(
            build={"image_digest": "sha256:fallback", "active_revision": "build-rev"},
            dependency_quorum={
                "rollout_image_book": {
                    "image_digest": "sha256:ready",
                    "active_revision": "runtime-rev",
                    "state": "current",
                    "route_workloads_ok": False,
                    "reason_codes": ["route_adjacent_workloads_degraded"],
                }
            },
        )

        self.assertEqual(payload["image_digest"], "sha256:ready")
        self.assertEqual(payload["route_workloads_ok"], False)

    def test_healthz_handler_stays_async_for_liveness_probe(self) -> None:
        self.assertTrue(inspect.iscoroutinefunction(healthz))

        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "torghut"})

    def test_trading_decisions_endpoint(self) -> None:
        response = self.client.get("/trading/decisions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")

    def test_autoresearch_epoch_endpoints(self) -> None:
        with self.session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="ok",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=["paper-1"],
                    snapshot_manifest_json={"source_count": 1},
                    runner_config_json={"replay_mode": "synthetic"},
                    summary_json={
                        "best": "portfolio-1",
                        "claim_count": 2,
                        "hypothesis_count": 1,
                        "candidate_spec_count": 1,
                        "evidence_bundle_count": 1,
                        "portfolio_candidate_count": 1,
                        "mlx_rank_bucket_lift": {"lift_net_pnl_per_day": "10"},
                        "false_positive_table": [{"candidate_spec_id": "spec-fp"}],
                        "best_false_negative_table": [{"candidate_spec_id": "spec-fn"}],
                        "promotion_readiness": {
                            "blockers": ["scheduler_v3_parity_missing"]
                        },
                    },
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="hyp-1",
                    candidate_kind="sleeve",
                    family_template_id="microbar_cross_sectional_pairs_v1",
                    payload_json={"candidate_spec_id": "spec-1"},
                    payload_hash="hash",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-1",
                    candidate_spec_id="spec-1",
                    model_id="model-1",
                    backend="numpy-fallback",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={"rank": 1},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["cand-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "target_met": True,
                        "net_pnl_per_day": "535",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                    optimizer_report_json={"selected_count": 1},
                    payload_json={
                        "portfolio_candidate_id": "portfolio-1",
                        "sleeves": [{"candidate_id": "cand-1"}],
                    },
                    status="target_met",
                )
            )
            session.commit()

        list_response = self.client.get("/trading/autoresearch/epochs")
        self.assertEqual(list_response.status_code, 200)
        list_payload = list_response.json()
        self.assertEqual(list_payload["count"], 1)
        self.assertEqual(list_payload["epochs"][0]["epoch_id"], "epoch-1")
        self.assertEqual(
            list_payload["epochs"][0]["best_portfolio_net_pnl_per_day"], "535"
        )
        self.assertEqual(list_payload["epochs"][0]["claim_count"], 2)
        self.assertEqual(
            list_payload["epochs"][0]["false_positive_table"][0]["candidate_spec_id"],
            "spec-fp",
        )
        self.assertEqual(
            list_payload["epochs"][0]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )

        detail_response = self.client.get("/trading/autoresearch/epochs/epoch-1")
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.json()
        self.assertEqual(detail_payload["epoch"]["epoch_id"], "epoch-1")
        self.assertEqual(
            detail_payload["candidate_specs"][0]["candidate_spec_id"], "spec-1"
        )
        self.assertEqual(detail_payload["proposal_scores"][0]["rank"], 1)
        self.assertEqual(
            detail_payload["portfolio_candidates"][0]["portfolio_candidate_id"],
            "portfolio-1",
        )
        self.assertEqual(
            detail_payload["dashboard"]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )
        self.assertEqual(
            detail_payload["dashboard"]["best_false_negative_table"][0][
                "candidate_spec_id"
            ],
            "spec-fn",
        )

        missing_response = self.client.get("/trading/autoresearch/epochs/missing")
        self.assertEqual(missing_response.status_code, 404)

    def test_dspy_cutover_migration_guard_assertion_raises_for_legacy_toggles(
        self,
    ) -> None:
        original_runtime_mode = settings.llm_dspy_runtime_mode
        original_fail_mode_enforcement = settings.llm_fail_mode_enforcement
        original_fail_mode = settings.llm_fail_mode
        original_abstain_fail_mode = settings.llm_abstain_fail_mode
        original_escalate_fail_mode = settings.llm_escalate_fail_mode
        original_quality_fail_mode = settings.llm_quality_fail_mode
        original_shadow_mode = settings.llm_shadow_mode
        settings.llm_dspy_runtime_mode = "active"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_mode = "veto"
        settings.llm_abstain_fail_mode = "pass_through"
        settings.llm_escalate_fail_mode = "veto"
        settings.llm_quality_fail_mode = "veto"
        settings.llm_shadow_mode = False
        try:
            with self.assertRaisesRegex(
                RuntimeError,
                "dspy_cutover_migration_guard_failed",
            ):
                _assert_dspy_cutover_migration_guard()
        finally:
            settings.llm_dspy_runtime_mode = original_runtime_mode
            settings.llm_fail_mode_enforcement = original_fail_mode_enforcement
            settings.llm_fail_mode = original_fail_mode
            settings.llm_abstain_fail_mode = original_abstain_fail_mode
            settings.llm_escalate_fail_mode = original_escalate_fail_mode
            settings.llm_quality_fail_mode = original_quality_fail_mode
            settings.llm_shadow_mode = original_shadow_mode

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_graph_signature": "graph-signature-demo",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 1,
            "schema_graph_parent_forks": {},
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_reports_schema_heads(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_current"])
        self.assertEqual(payload["current_heads"], payload["expected_heads"])
        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertEqual(payload["schema_missing_heads"], [])
        self.assertEqual(payload["schema_unexpected_heads"], [])
        self.assertEqual(payload["schema_head_count_expected"], 1)
        self.assertEqual(payload["schema_head_count_current"], 1)
        self.assertEqual(payload["schema_head_delta_count"], 0)
        self.assertEqual(payload["schema_graph_signature"], "graph-signature-demo")
        self.assertEqual(payload["schema_graph_roots"], ["0001_initial_torghut_schema"])
        self.assertEqual(payload["schema_graph_branch_count"], 1)
        self.assertEqual(payload["schema_graph_parent_forks"], {})
        self.assertEqual(payload["schema_graph_lineage_errors"], [])
        self.assertIn("checked_at", payload)

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-divergent",
            "schema_graph_signature": "graph-divergent",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 3,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0016_whitepaper_engineering_triggers_and_rollout",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_divergence_returns_503_when_override_disabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = False
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database schema lineage divergence"
        )
        self.assertFalse(payload["detail"]["schema_graph_lineage_ready"])
        self.assertIn("schema_graph_lineage_errors", payload["detail"])
        self.assertIn("schema_graph_branch_count", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-override",
            "schema_graph_signature": "graph-override",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 2,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0017_whitepaper_semantic_indexing",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_warning_returns_200_when_override_enabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = True
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_graph_lineage_ready"])
        self.assertEqual(payload["schema_graph_branch_count"], 2)
        self.assertEqual(
            payload["schema_graph_lineage_errors"],
            [],
        )
        self.assertEqual(
            payload["schema_graph_lineage_warnings"],
            [
                "migration parent forks detected: 0015_whitepaper_workflow_tables -> "
                "[0016_llm_dspy_workflow_artifacts, 0017_whitepaper_semantic_indexing]",
                "migration graph branch count 2 exceeds tolerance 1; allowed by "
                "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true",
            ],
        )

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": False,
            "current_heads": ["0010_execution_provenance_and_governance_trace"],
            "expected_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_unexpected_heads": [
                "0010_execution_provenance_and_governance_trace"
            ],
            "schema_head_count_expected": 2,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 3,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_mismatch_returns_503(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"]["error"], "database schema mismatch")
        self.assertFalse(payload["detail"]["schema_current"])
        self.assertEqual(
            payload["detail"]["schema_missing_heads"],
            [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
        )
        self.assertEqual(
            payload["detail"]["schema_unexpected_heads"],
            ["0010_execution_provenance_and_governance_trace"],
        )
        self.assertEqual(payload["detail"]["schema_head_count_expected"], 2)
        self.assertEqual(payload["detail"]["schema_head_count_current"], 1)
        self.assertEqual(payload["detail"]["schema_head_delta_count"], 3)
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    def test_bounded_account_scope_invariants_uses_catalog_queries(self) -> None:
        class FakeResult:
            def __init__(self, rows: list[dict[str, object]]) -> None:
                self._rows = rows

            def mappings(self) -> "FakeResult":
                return self

            def all(self) -> list[dict[str, object]]:
                return self._rows

        class FakeSession:
            def __init__(self) -> None:
                self.statements: list[str] = []

            def execute(
                self,
                statement: object,
                _params: dict[str, object] | None = None,
            ) -> FakeResult:
                sql = str(statement)
                self.statements.append(sql)
                if "SET LOCAL statement_timeout" in sql:
                    return FakeResult([])
                if "FROM pg_catalog.pg_class" in sql and "pg_attribute" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_decisions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_cursor",
                                "column_name": "account_label",
                            },
                            {
                                "table_name": "execution_order_events",
                                "column_name": "alpaca_account_label",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql and "array_agg" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_order_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "alpaca_order_id",
                                ],
                            },
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_client_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "client_order_id",
                                ],
                            },
                            {
                                "table_name": "trade_decisions",
                                "index_name": "trade_decisions_account_hash_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "decision_hash",
                                ],
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_account_uidx",
                                "column_names": ["source", "account_label"],
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_order_uidx",
                            },
                            {
                                "table_name": "trade_decisions",
                                "index_name": "trade_decisions_account_hash_uidx",
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_account_uidx",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_constraint" in sql:
                    return FakeResult([])
                raise AssertionError(f"unexpected SQL: {sql}")

        fake_session = FakeSession()
        payload = main_module._check_account_scope_invariants_bounded(fake_session)  # type: ignore[arg-type]

        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertEqual(payload["account_scope_check_mode"], "bounded_catalog")
        joined_sql = "\n".join(fake_session.statements)
        self.assertIn("SET LOCAL statement_timeout", joined_sql)
        self.assertNotIn("pg_type", joined_sql)
        self.assertNotIn("information_schema.columns", joined_sql)
        self.assertNotIn("pg_catalog.pg_indexes", joined_sql)

    def test_bounded_account_scope_invariants_reports_legacy_indexes(self) -> None:
        class FakeResult:
            def __init__(self, rows: list[dict[str, object]]) -> None:
                self._rows = rows

            def mappings(self) -> "FakeResult":
                return self

            def all(self) -> list[dict[str, object]]:
                return self._rows

        class FakeSession:
            def execute(
                self,
                statement: object,
                _params: dict[str, object] | None = None,
            ) -> FakeResult:
                sql = str(statement)
                if "SET LOCAL statement_timeout" in sql:
                    return FakeResult([])
                if "FROM pg_catalog.pg_class" in sql and "pg_attribute" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_decisions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_cursor",
                                "column_name": "account_label",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql and "array_agg" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_alpaca_order_id_key",
                                "column_names": ["alpaca_order_id"],
                            },
                            {
                                "table_name": "executions",
                                "index_name": "executions_client_order_id_key",
                                "column_names": ["client_order_id"],
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_key",
                                "column_names": ["source"],
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_alpaca_order_id_key",
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_key",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_constraint" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "constraint_name": "executions_alpaca_order_id_key",
                            },
                            {
                                "table_name": "trade_cursor",
                                "constraint_name": "trade_cursor_source_key",
                            },
                        ]
                    )
                raise AssertionError(f"unexpected SQL: {sql}")

        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            payload = main_module._check_account_scope_invariants_bounded(FakeSession())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertTrue(
            payload["legacy_executions_single_account_order_id_index_detected"]
        )
        self.assertTrue(
            payload["legacy_executions_single_account_client_order_id_index_detected"]
        )
        self.assertTrue(
            payload["legacy_trade_cursor_source_only_source_index_detected"]
        )
        self.assertFalse(payload["execution_has_account_scoped_unique_order_id"])
        self.assertFalse(payload["execution_has_account_scoped_unique_client_order_id"])
        self.assertFalse(
            payload["trade_decision_has_account_scoped_unique_decision_hash"]
        )
        self.assertFalse(payload["trade_cursor_has_account_scoped_source_index"])
        self.assertFalse(payload["execution_order_events_have_account_label"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_database_contract_fails_closed_on_account_scope_timeout(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                side_effect=SQLAlchemyError(
                    "canceling statement due to statement timeout"
                ),
            ):
                payload = main_module._evaluate_database_contract(object())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["account_scope_ready"])
        self.assertIn("statement timeout", payload["account_scope_errors"][0])
        self.assertEqual(payload["schema_current"], True)

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_database_contract_bypasses_account_scope_timeout_when_disabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                side_effect=SQLAlchemyError(
                    "canceling statement due to statement timeout"
                ),
            ):
                payload = main_module._evaluate_database_contract(object())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertIn(
            "account scope catalog check failed but is non-blocking",
            " ".join(payload["account_scope_warnings"]),
        )

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_enforces_account_scope_when_multi_account_enabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": [
                        "legacy unique constraint/index detected for executions.alpaca_order_id",
                    ],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database account scope schema mismatch"
        )
        self.assertIn("account_scope_errors", payload["detail"])
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_allows_account_scope_issues_when_multi_account_disabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": ["legacy unique constraint/index detected"],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["account_scope_ready"], True)
        self.assertIn(
            "account_scope_warnings",
            payload["account_scope_checks"],
        )
        self.assertEqual(
            payload["account_scope_checks"]["account_scope_warnings"],
            [
                "account scope checks are bypassed when trading_multi_account_enabled is false"
            ],
        )
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload)
