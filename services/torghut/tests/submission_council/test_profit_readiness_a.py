from __future__ import annotations

# ruff: noqa: F401,F403,F405

from tests.submission_council.support import *


class TestSubmissionCouncilProfitReadinessA(SubmissionCouncilTestCase):
    def test_coerce_aware_datetime_normalizes_runtime_status_values(self) -> None:
        self.assertEqual(
            _coerce_aware_datetime(datetime(2026, 5, 13, 20, 56, 16)),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _coerce_aware_datetime("2026-05-13T20:56:16Z"),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertIsNone(_coerce_aware_datetime("not-a-timestamp"))
        self.assertIsNone(_coerce_aware_datetime(None))

    def test_load_profit_promotion_counts_includes_autoresearch_ledgers(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="H-CONT-01",
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
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={"oracle_passed": False},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-1"},
                    status="blocked",
                )
            )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["research_candidates"], 0)
        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["autoresearch_candidate_specs"], 1)
        self.assertEqual(counts["autoresearch_proposal_scores"], 1)
        self.assertEqual(counts["autoresearch_portfolio_candidates"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 1)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 0)
        self.assertEqual(counts["count_errors"], [])
        self.assertEqual(counts["count_basis"], "bounded_latest_rows")
        self.assertEqual(counts["count_limit"], _PROMOTION_TABLE_COUNT_SCAN_LIMIT)

    def test_load_profit_promotion_counts_use_bounded_row_reads(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="complete",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.commit()
            execute = session.execute
            statements: list[str] = []

            def capture_execute(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statements.append(str(statement))
                return execute(statement, *args, **kwargs)

            with patch.object(session, "execute", side_effect=capture_execute):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["truncated_counts"], [])
        self.assertEqual(counts["read_model_scope"], "bounded_promotion_scalar_counts")
        self.assertFalse(counts["promotion_scalar_counts_exact"])
        self.assertTrue(any("count(" in statement.lower() for statement in statements))
        self.assertTrue(
            any(
                "FROM autoresearch_epochs" in statement and "LIMIT" in statement
                for statement in statements
            )
        )
        portfolio_statements = [
            statement
            for statement in statements
            if "FROM autoresearch_portfolio_candidates" in statement
        ]
        self.assertTrue(portfolio_statements)
        self.assertTrue(
            any(
                "autoresearch_portfolio_candidates.status" in statement
                for statement in portfolio_statements
            )
        )
        self.assertFalse(
            any("payload_json" in statement for statement in portfolio_statements)
        )
        self.assertFalse(
            any(
                "optimizer_report_json" in statement
                for statement in portfolio_statements
            )
        )

    def test_load_profit_promotion_counts_fail_closed_when_portfolio_scan_truncated(
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
            for idx in range(_PROMOTION_PORTFOLIO_READY_SCAN_LIMIT + 1):
                session.add(
                    AutoresearchPortfolioCandidate(
                        portfolio_candidate_id=f"portfolio-{idx}",
                        epoch_id="epoch-1",
                        source_candidate_ids_json=[f"spec-{idx}"],
                        target_net_pnl_per_day=Decimal("500"),
                        objective_scorecard_json={},
                        optimizer_report_json={"selected_count": 1},
                        payload_json={"portfolio_candidate_id": f"portfolio-{idx}"},
                        status="blocked",
                    )
                )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(
            counts["autoresearch_portfolio_scan_limit"],
            _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
        )
        self.assertIn(
            "autoresearch_portfolio_candidates_bounded_scan_truncated",
            counts["count_errors"],
        )

    def test_load_profit_promotion_counts_fail_closed_for_timed_out_count(
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
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="H-CONT-01",
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
                    payload_json={},
                )
            )
            session.commit()

            execute = session.execute

            def fail_proposal_score_count(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statement_text = str(statement)
                if (
                    "FROM autoresearch_proposal_scores" in statement_text
                    and "LIMIT" in statement_text
                ):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_proposal_score_count,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["autoresearch_candidate_specs"], 1)
        self.assertEqual(counts["autoresearch_proposal_scores"], 0)
        self.assertEqual(counts["read_model_scope"], "bounded_promotion_scalar_counts")
        self.assertFalse(counts["promotion_scalar_counts_exact"])
        self.assertEqual(counts["count_errors"], ["autoresearch_proposal_scores"])
        self.assertEqual(rollback.call_count, 1)

    def test_latest_runtime_ledger_summary_timeout_is_explicit(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                summary = _load_latest_runtime_ledger_summary(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(rollback.call_count, 1)

    def test_certificate_evidence_timeout_is_explicit_and_fail_closed(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                    now=datetime.now(timezone.utc),
                    max_age_seconds=900,
                )

        self.assertEqual(len(evidence), 1)
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(rollback.call_count, 1)

    def test_load_profit_promotion_counts_fail_closed_for_portfolio_timeout(
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
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["research_candidates"], 0)
        self.assertEqual(counts["autoresearch_portfolio_candidates"], 0)
        self.assertEqual(counts["autoresearch_portfolio_ready_refs"], [])
        self.assertEqual(counts["count_errors"], ["autoresearch_portfolio_candidates"])
        self.assertEqual(rollback.call_count, 1)

    def test_load_profit_promotion_counts_keeps_ready_refs_when_spec_ref_times_out(
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
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-1"},
                    status="target_met",
                )
            )
            session.commit()

            execute = session.execute

            def fail_ready_spec_ref(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statement_text = str(statement)
                if (
                    "FROM autoresearch_candidate_specs" in statement_text
                    and "WHERE autoresearch_candidate_specs.candidate_spec_id IN"
                    in statement_text
                ):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch(
                    "app.trading.submission_council._autoresearch_portfolio_current_oracle_passed",
                    return_value=True,
                ),
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_ready_spec_ref,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_portfolio_candidates"], 1)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 0)
        self.assertEqual(
            counts["autoresearch_portfolio_ready_refs"],
            [
                "candidate_spec_id:spec-1",
                "portfolio_candidate_id:portfolio-1",
                "source_candidate_id:spec-1",
            ],
        )
        self.assertEqual(counts["count_errors"], ["autoresearch_candidate_specs"])
        self.assertEqual(rollback.call_count, 1)
