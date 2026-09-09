from __future__ import annotations


from tests.submission_council.support import (
    Base,
    Decimal,
    SQLAlchemyError,
    StaticPool,
    StrategyHypothesisMetricWindow,
    StrategyRuntimeLedgerBucket,
    SubmissionCouncilTestCase,
    _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT,
    _FailingRuntimeLedgerStatusSession,
    _NoRollbackRuntimeLedgerStatusSession,
    _RaisingBindRuntimeLedgerStatusSession,
    _RollbackFailingRuntimeLedgerStatusSession,
    _attach_lineage_refs,
    _load_latest_certificate_evidence,
    _load_latest_runtime_ledger_summary,
    _load_persisted_profit_rejection_summary,
    _load_runtime_ledger_repair_candidates,
    _maybe_set_runtime_ledger_status_statement_timeout,
    _rollback_runtime_ledger_status_session,
    _runtime_ledger_status_query_timeout_ms,
    create_engine,
    datetime,
    os,
    patch,
    sessionmaker,
    timedelta,
    timezone,
)


class TestSubmissionCouncilRuntimeLedgerReads(SubmissionCouncilTestCase):
    def test_load_latest_runtime_ledger_summary_uses_latest_bucket_per_hypothesis(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        older = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        newer = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        with session_local() as session:
            empty_summary = _load_latest_runtime_ledger_summary(
                session,
                hypothesis_ids=[],
            )
            self.assertEqual(empty_summary["by_hypothesis"], {})
            self.assertEqual(empty_summary["runtime_ledger_buckets"], [])
            self.assertEqual(empty_summary["query_status"], "skipped")
            self.assertEqual(
                empty_summary["query_reason_codes"],
                ["runtime_ledger_hypothesis_scope_missing"],
            )
            self.assertEqual(
                empty_summary["query_scope"],
                "per_hypothesis_latest_runtime_ledger",
            )
            session.add_all(
                [
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-paper-newer",
                        candidate_id="cand-new",
                        hypothesis_id="H-CONT-01",
                        observed_stage="paper",
                        bucket_started_at=datetime(
                            2026, 3, 6, 15, 45, tzinfo=timezone.utc
                        ),
                        bucket_ended_at=datetime(
                            2026, 3, 6, 15, 45, tzinfo=timezone.utc
                        ),
                        account_label="paper",
                        runtime_strategy_name="paper-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=55,
                        decision_count=55,
                        submitted_order_count=55,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=9,
                        open_position_count=0,
                        filled_notional=Decimal("2500"),
                        gross_strategy_pnl=Decimal("25"),
                        cost_amount=Decimal("4"),
                        net_strategy_pnl_after_costs=Decimal("21"),
                        post_cost_expectancy_bps=Decimal("9"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"paper-policy": 1},
                        cost_model_hash_counts={"paper-cost": 1},
                        lineage_hash_counts={"paper-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-old",
                        candidate_id="cand-old",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        bucket_started_at=older,
                        bucket_ended_at=older,
                        account_label="paper",
                        runtime_strategy_name="old-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=20,
                        decision_count=20,
                        submitted_order_count=20,
                        cancelled_order_count=1,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=4,
                        open_position_count=0,
                        filled_notional=Decimal("1000"),
                        gross_strategy_pnl=Decimal("12"),
                        cost_amount=Decimal("2"),
                        net_strategy_pnl_after_costs=Decimal("10"),
                        post_cost_expectancy_bps=Decimal("5"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"old-policy": 1},
                        cost_model_hash_counts={"old-cost": 1},
                        lineage_hash_counts={"old-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-new",
                        candidate_id="cand-new",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        bucket_started_at=newer,
                        bucket_ended_at=newer,
                        account_label="paper",
                        runtime_strategy_name="new-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=45,
                        decision_count=45,
                        submitted_order_count=45,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=8,
                        open_position_count=0,
                        filled_notional=Decimal("2000"),
                        gross_strategy_pnl=Decimal("24"),
                        cost_amount=Decimal("4"),
                        net_strategy_pnl_after_costs=Decimal("20"),
                        post_cost_expectancy_bps=Decimal("8"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"new-policy": 1},
                        cost_model_hash_counts={"new-cost": 1},
                        lineage_hash_counts={"new-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-rev",
                        candidate_id="cand-rev",
                        hypothesis_id="H-REV-01",
                        observed_stage="live",
                        bucket_started_at=newer,
                        bucket_ended_at=newer,
                        account_label="paper",
                        runtime_strategy_name="rev-runtime",
                        strategy_family="mean_reversion",
                        fill_count=40,
                        decision_count=40,
                        submitted_order_count=40,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=7,
                        open_position_count=0,
                        filled_notional=Decimal("1500"),
                        gross_strategy_pnl=Decimal("12"),
                        cost_amount=Decimal("3"),
                        net_strategy_pnl_after_costs=Decimal("9"),
                        post_cost_expectancy_bps=None,
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={},
                        cost_model_hash_counts={},
                        lineage_hash_counts={},
                        blockers_json=[],
                    ),
                ]
            )
            session.commit()

            summary = _load_latest_runtime_ledger_summary(
                session,
                hypothesis_ids=["", "H-CONT-01", "H-REV-01"],
            )

        by_hypothesis = summary["by_hypothesis"]
        self.assertIsInstance(by_hypothesis, dict)
        cont = by_hypothesis["H-CONT-01"]
        rev = by_hypothesis["H-REV-01"]
        self.assertEqual(cont["run_id"], "ledger-new")
        self.assertEqual(cont["candidate_id"], "cand-new")
        self.assertEqual(cont["submitted_order_count"], 45)
        self.assertEqual(cont["post_cost_expectancy_bps"], "8.00000000")
        self.assertEqual(cont["execution_policy_hash_counts"], {"new-policy": 1})
        self.assertIsNone(rev["post_cost_expectancy_bps"])
        self.assertGreaterEqual(len(summary["runtime_ledger_buckets"]), 4)

    def test_load_latest_runtime_ledger_summary_fails_closed_on_query_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        summary = _load_latest_runtime_ledger_summary(
            fake_session,
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertEqual(summary["query_status"], "timeout")
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["query_reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(fake_session.rollback_count, 1)

    def test_load_latest_certificate_evidence_fails_closed_on_window_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        evidence = _load_latest_certificate_evidence(
            fake_session,
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(evidence[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(evidence[0]["query_status"], "timeout")
        self.assertEqual(
            evidence[0]["query_reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )

    def test_load_latest_certificate_evidence_fails_closed_on_promotion_timeout(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now,
                    market_session_count=1,
                    decision_count=1,
                    trade_count=1,
                    order_count=1,
                    post_cost_expectancy_bps="1.0",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                    payload_json={},
                )
            )
            session.commit()

            execute = session.execute

            def fail_promotion_decision_query(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                if "strategy_promotion_decisions" in str(statement):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_promotion_decision_query,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-PAIRS-01"],
                    now=now,
                )

        self.assertEqual(rollback.call_count, 1)
        self.assertEqual(evidence[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(evidence[0]["query_status"], "timeout")
        self.assertEqual(
            evidence[0]["query_reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )

    def test_load_latest_certificate_evidence_uses_bounded_status_reads(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            execute = session.execute
            statements: list[str] = []

            def capture_execute(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statements.append(str(statement))
                return execute(statement, *args, **kwargs)

            with patch.object(session, "execute", side_effect=capture_execute):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-PAIRS-01", "H-REV-01"],
                )

        self.assertEqual(len(evidence), 2)
        bounded_limit = 2 * _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
        self.assertTrue(
            any(
                "FROM strategy_hypothesis_metric_windows" in statement
                and "LIMIT" in statement
                for statement in statements
            )
        )
        self.assertTrue(
            all(
                row["reason_codes"] == ["hypothesis_window_evidence_missing"]
                for row in evidence
            )
        )
        self.assertTrue(
            all(
                row["query_limit_per_hypothesis"]
                == _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
                for row in evidence
            )
        )
        self.assertGreaterEqual(bounded_limit, 1)

    def test_attach_lineage_refs_fails_closed_on_query_timeout(self) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        rows = _attach_lineage_refs(
            fake_session,
            evaluated_rows=[
                {
                    "candidate_id": "candidate-timeout",
                    "hypothesis_id": "H-TIMEOUT",
                    "reason_codes": [],
                }
            ],
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reason_codes"], ["lineage_ref_query_timeout"])
        self.assertEqual(rows[0]["lineage_ref"]["status"], "unavailable")
        self.assertEqual(rows[0]["lineage_ref"]["candidate_id"], "candidate-timeout")
        self.assertEqual(rows[0]["lineage_ref"]["hypothesis_id"], "H-TIMEOUT")

    def test_load_persisted_profit_rejection_summary_fails_closed_on_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        summary = _load_persisted_profit_rejection_summary(
            fake_session,
            account_label="PA3SX7FYNUTF",
            now=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(summary["total"], 0)
        self.assertIsNone(summary["rejection_drag_ratio"])
        self.assertEqual(summary["status_totals"], {})
        self.assertEqual(
            summary["reason_codes"],
            ["profit_rejection_summary_query_timeout"],
        )

    def test_runtime_ledger_status_timeout_helper_applies_timeout_when_bind_lookup_fails(
        self,
    ) -> None:
        fake_session = _RaisingBindRuntimeLedgerStatusSession()

        _maybe_set_runtime_ledger_status_statement_timeout(
            fake_session,
        )

        self.assertEqual(
            fake_session.calls,
            ["SET LOCAL statement_timeout = 2500"],
        )

    def test_runtime_ledger_status_timeout_helper_ignores_non_executable_object(
        self,
    ) -> None:
        _maybe_set_runtime_ledger_status_statement_timeout(object())

    def test_runtime_ledger_status_timeout_helper_uses_configured_timeout(
        self,
    ) -> None:
        fake_session = _RaisingBindRuntimeLedgerStatusSession()

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "3250"},
        ):
            _maybe_set_runtime_ledger_status_statement_timeout(
                fake_session,
            )

        self.assertEqual(
            fake_session.calls,
            ["SET LOCAL statement_timeout = 3250"],
        )

    def test_runtime_ledger_status_timeout_helper_bounds_configured_timeout(
        self,
    ) -> None:
        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "25"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 500)

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "25000"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 10000)

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "not-an-int"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 2500)

    def test_runtime_ledger_status_rollback_helper_ignores_missing_rollback(
        self,
    ) -> None:
        _rollback_runtime_ledger_status_session(
            _NoRollbackRuntimeLedgerStatusSession(),
        )

    def test_load_latest_runtime_ledger_summary_fails_closed_when_rollback_fails(
        self,
    ) -> None:
        fake_session = _RollbackFailingRuntimeLedgerStatusSession()

        summary = _load_latest_runtime_ledger_summary(
            fake_session,
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertEqual(summary["query_status"], "timeout")
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["query_reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(fake_session.rollback_count, 1)

    def test_load_runtime_ledger_repair_candidates_fails_closed_on_query_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        candidates = _load_runtime_ledger_repair_candidates(
            fake_session,
            registry_items=[
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "candidate",
                    "strategy_family": "microbar_cross_sectional_pairs",
                }
            ],
        )

        self.assertEqual(candidates, [])
        self.assertEqual(fake_session.rollback_count, 1)
