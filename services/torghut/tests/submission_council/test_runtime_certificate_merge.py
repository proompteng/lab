from __future__ import annotations


from tests.submission_council.support import (
    Base,
    SimpleNamespace,
    StaticPool,
    SubmissionCouncilTestCase,
    _merge_runtime_certificate_evidence,
    _metric_window_activity_reason_codes,
    _refresh_runtime_summary_totals,
    build_live_submission_gate_payload,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    timedelta,
    timezone,
)


class TestSubmissionCouncilRuntimeCertificateMerge(SubmissionCouncilTestCase):
    def test_live_gate_seeds_hpairs_bounded_collection_target_without_source_rows(
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

        class _RegistryItem:
            hypothesis_id = "H-PAIRS-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "lane_id": "microbar_cross_sectional_pairs",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )

        with session_local() as session:
            with patch(
                "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[],
                    session=session,
                )

        self.assertFalse(gate["allowed"])
        self.assertFalse(gate["runtime_ledger_paper_probation_candidates"])
        self.assertFalse(gate["runtime_ledger_source_collection_candidates"])
        self.assertIn(
            "runtime_ledger_source_collection_pending", gate["blocked_reasons"]
        )
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(import_plan["target_count"], 1)
        self.assertEqual(import_plan["manifest_bounded_collection_target_count"], 1)
        self.assertTrue(import_plan["bounded_live_paper_collection_authorized"])
        self.assertFalse(
            import_plan["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(import_plan["promotion_allowed"])
        self.assertFalse(import_plan["final_promotion_allowed"])
        target = import_plan["targets"][0]
        self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(target["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(target["source_kind"], "paper_route_probe_runtime_observed")
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertTrue(target["bounded_live_paper_collection_authorized"])
        self.assertEqual(
            target["bounded_evidence_collection_scope"],
            "paper_route_probe_next_session_only",
        )
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["paper_route_probe_next_session_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertFalse(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertIn(
            "runtime_ledger_source_decisions_missing",
            target["candidate_blockers"],
        )
        self.assertIn(
            "source_backed_paper_probation_required",
            target["candidate_blockers"],
        )

    def test_metric_window_activity_rejects_tca_proxy_expectancy(self) -> None:
        metric_window = SimpleNamespace(
            market_session_count=3,
            decision_count=3,
            trade_count=3,
            order_count=3,
            post_cost_expectancy_bps="8.5",
            avg_abs_slippage_bps="4.2",
            slippage_budget_bps="12",
            payload_json={
                "post_cost_promotion_sample_count": 0,
                "post_cost_basis_counts": {"broker_tca_shortfall_estimate": 3},
            },
        )

        reasons = _metric_window_activity_reason_codes(metric_window)

        self.assertEqual(
            reasons,
            ["hypothesis_window_post_cost_pnl_basis_missing"],
        )

    def test_metric_window_activity_rejects_live_window_without_runtime_ledger_weighted_pnl(
        self,
    ) -> None:
        metric_window = SimpleNamespace(
            observed_stage="live",
            market_session_count=3,
            decision_count=3,
            trade_count=3,
            order_count=3,
            post_cost_expectancy_bps="8.5",
            avg_abs_slippage_bps="4.2",
            slippage_budget_bps="12",
            payload_json={
                "post_cost_promotion_sample_count": 3,
                "post_cost_basis_counts": {
                    "realized_strategy_pnl_after_explicit_costs": 3
                },
                "post_cost_expectancy_aggregation": "promotion_bps_average",
                "runtime_ledger_notional_weighted_sample_count": 2,
            },
        )

        reasons = _metric_window_activity_reason_codes(metric_window)

        self.assertEqual(reasons, ["runtime_ledger_pnl_basis_missing"])

    def test_merge_runtime_certificate_evidence_surfaces_blocked_import_reason(
        self,
    ) -> None:
        merged = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "promotion_eligible": False,
                    "capital_stage": "shadow",
                    "reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(observed_stage="live"),
                    "promotion_decision": self._promotion_decision(
                        allowed=False,
                        reason_summary="runtime_ledger_pnl_basis_missing",
                        payload_json={
                            "promotion_blocking_reasons": [
                                "runtime_ledger_pnl_basis_missing"
                            ]
                        },
                    ),
                }
            ],
            now=datetime.now(timezone.utc),
            max_age_seconds=3600,
        )

        self.assertEqual(len(merged), 1)
        self.assertFalse(merged[0]["promotion_eligible"])
        self.assertEqual(
            merged[0]["reasons"],
            [
                "runtime_ledger_pnl_basis_missing",
                "promotion_decision_not_allowed",
            ],
        )
        self.assertEqual(
            merged[0]["observed"]["runtime_window_rejection_reasons"],
            [
                "runtime_ledger_pnl_basis_missing",
                "promotion_decision_not_allowed",
            ],
        )

    def test_refresh_runtime_summary_totals_counts_reasons_and_rollback(self) -> None:
        refreshed = _refresh_runtime_summary_totals(
            {
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                }
            },
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "state": "shadow",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": True,
                    "reasons": ["drift_checks_missing", ""],
                    "informational_reasons": ["runtime_window_certificate_rejected"],
                },
                {
                    "hypothesis_id": "H-TSMOM-01",
                    "state": "shadow",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": True,
                    "paper_probation_eligible": True,
                    "rollback_required": False,
                    "reasons": [],
                    "informational_reasons": [],
                },
            ],
        )

        self.assertEqual(refreshed["hypotheses_total"], 2)
        self.assertEqual(refreshed["promotion_eligible_total"], 1)
        self.assertEqual(refreshed["paper_probation_eligible_total"], 1)
        self.assertEqual(refreshed["rollback_required_total"], 1)
        self.assertEqual(refreshed["reason_totals"], {"drift_checks_missing": 1})
        self.assertEqual(
            refreshed["informational_reason_totals"],
            {"runtime_window_certificate_rejected": 1},
        )

    def test_runtime_certificate_merge_keeps_invalid_evidence_shadow(self) -> None:
        now = datetime.now(timezone.utc)
        base_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }

        def metric_window(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "window-invalid",
                "candidate_id": "cand-runtime",
                "capital_stage": "0.10x canary",
                "window_ended_at": now,
                "created_at": now,
                "continuity_ok": True,
                "drift_ok": True,
                "dependency_quorum_decision": "allow",
                "market_session_count": 3,
                "decision_count": 42,
                "trade_count": 42,
                "order_count": 42,
                "avg_abs_slippage_bps": "4.2",
                "slippage_budget_bps": "12",
                "post_cost_expectancy_bps": "8.5",
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        def promotion(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "promo-invalid",
                "candidate_id": "cand-runtime",
                "state": "0.10x canary",
                "allowed": True,
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        scenarios = [
            [],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=None,
                        created_at=None,
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(),
                    "promotion_decision": promotion(allowed=False),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=now.replace(year=2020),
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        dependency_quorum_decision="block",
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(capital_stage="observe"),
                    "promotion_decision": promotion(state="observe"),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(capital_stage="shadow"),
                    "promotion_decision": promotion(state="shadow"),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        capital_stage="shadow",
                        observed_stage="live",
                        payload_json={
                            "post_cost_promotion_sample_count": 42,
                            "post_cost_basis_counts": {
                                "realized_strategy_pnl_after_explicit_costs": 42
                            },
                            "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                            "runtime_ledger_notional_weighted_sample_count": 42,
                        },
                    ),
                    "promotion_decision": promotion(state="shadow"),
                }
            ],
        ]

        for evidence in scenarios:
            with self.subTest(evidence=evidence):
                result = _merge_runtime_certificate_evidence(
                    [base_item],
                    evidence=evidence,
                    now=now,
                    max_age_seconds=3600,
                )

                self.assertFalse(result[0]["promotion_eligible"])
                self.assertEqual(result[0]["capital_stage"], "shadow")
                expected_reasons = ["drift_checks_missing"]
                if (
                    evidence
                    and getattr(evidence[0]["promotion_decision"], "allowed", True)
                    is False
                ):
                    expected_reasons.append("promotion_decision_not_allowed")
                self.assertEqual(result[0]["reasons"], expected_reasons)

    def test_runtime_certificate_merge_blocks_live_certificate_without_runtime_ledger(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": None,
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        run_id="runtime-proof-missing-ledger",
                        candidate_id="cand-runtime",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="runtime-proof-missing-ledger",
                        candidate_id="cand-runtime",
                    ),
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertEqual(
            result[0]["reasons"],
            ["drift_checks_missing", "runtime_ledger_proof_missing"],
        )
        self.assertEqual(
            result[0]["observed"]["runtime_window_rejection_reasons"],
            ["runtime_ledger_proof_missing"],
        )

    def test_runtime_certificate_merge_accepts_runtime_item_ledger_observed_fallback(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-1",
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": self._runtime_ledger_observed(),
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertTrue(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "0.10x canary")
        self.assertEqual(result[0]["reasons"], [])
        self.assertTrue(result[0]["observed"]["runtime_window_certificate_applied"])
        self.assertEqual(
            result[0]["informational_reasons"],
            ["runtime_window_certificate_applied"],
        )

    def test_runtime_certificate_merge_rejects_explicit_missing_runtime_ledger_bucket(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-1",
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": self._runtime_ledger_observed(),
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                    "runtime_ledger_bucket": None,
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertEqual(
            result[0]["observed"]["runtime_window_rejection_reasons"],
            ["runtime_ledger_proof_missing"],
        )

    def test_runtime_certificate_merge_rejects_invalid_runtime_ledger_payloads(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        base_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "strategy_family": "intraday_continuation",
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }
        drop = object()
        scenarios: list[tuple[str, dict[str, object], tuple[str, ...]]] = [
            (
                "hypothesis mismatch",
                {"hypothesis_id": "H-OTHER"},
                ("runtime_ledger_hypothesis_mismatch",),
            ),
            (
                "run mismatch",
                {"run_id": "runtime-proof-other"},
                ("runtime_ledger_run_id_mismatch",),
            ),
            (
                "candidate missing",
                {"candidate_id": drop},
                ("runtime_ledger_candidate_missing",),
            ),
            (
                "candidate mismatch",
                {"candidate_id": "cand-other"},
                ("runtime_ledger_candidate_mismatch",),
            ),
            (
                "stage not live",
                {"observed_stage": "paper"},
                ("runtime_ledger_stage_not_live",),
            ),
            (
                "family mismatch",
                {"strategy_family": "mean_reversion"},
                ("runtime_ledger_strategy_family_mismatch",),
            ),
            (
                "pnl basis missing",
                {"pnl_basis": drop},
                ("runtime_ledger_pnl_basis_missing",),
            ),
            (
                "filled notional missing",
                {"filled_notional": "0"},
                ("runtime_ledger_filled_notional_missing",),
            ),
            (
                "expectancy missing",
                {"post_cost_expectancy_bps": drop},
                ("runtime_ledger_expectancy_missing",),
            ),
            (
                "expectancy nonpositive",
                {"post_cost_expectancy_bps": "0"},
                ("post_cost_expectancy_non_positive",),
            ),
            (
                "closed trades missing",
                {"closed_trade_count": 0},
                ("runtime_ledger_closed_trades_missing",),
            ),
            ("open position", {"open_position_count": 1}, ("unclosed_position",)),
            (
                "orders missing",
                {"submitted_order_count": 0},
                ("runtime_order_lifecycle_missing",),
            ),
            (
                "orders below metric",
                {"submitted_order_count": 1},
                ("runtime_ledger_submitted_order_count_mismatch",),
            ),
            (
                "hash counts missing",
                {
                    "execution_policy_hash_counts": drop,
                    "cost_model_hash_counts": drop,
                    "lineage_hash_counts": drop,
                },
                (
                    "runtime_ledger_execution_policy_hash_missing",
                    "runtime_ledger_cost_model_hash_missing",
                    "runtime_ledger_lineage_hash_missing",
                ),
            ),
        ]

        for label, updates, expected_reasons in scenarios:
            with self.subTest(label=label):
                payload = self._runtime_ledger_bucket_payload()
                for key, value in updates.items():
                    if value is drop:
                        payload.pop(key, None)
                    else:
                        payload[key] = value
                result = _merge_runtime_certificate_evidence(
                    [dict(base_item)],
                    evidence=[
                        {
                            "hypothesis_id": "H-CONT-01",
                            "metric_window": self._metric_window(),
                            "promotion_decision": self._promotion_decision(),
                            "runtime_ledger_bucket": payload,
                        }
                    ],
                    now=now,
                    max_age_seconds=3600,
                )

                self.assertFalse(result[0]["promotion_eligible"])
                self.assertEqual(result[0]["capital_stage"], "shadow")
                rejection_reasons = result[0]["observed"][
                    "runtime_window_rejection_reasons"
                ]
                for reason in expected_reasons:
                    self.assertIn(reason, rejection_reasons)

    def test_runtime_certificate_merge_rejects_runtime_ledger_bucket_outside_metric_window(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        metric_window = self._metric_window()
        metric_window.window_started_at = now - timedelta(minutes=10)
        metric_window.window_ended_at = now
        payload = self._runtime_ledger_bucket_payload()
        payload["bucket_started_at"] = (now + timedelta(minutes=1)).isoformat()
        payload["bucket_ended_at"] = (now + timedelta(minutes=2)).isoformat()

        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": None,
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window,
                    "promotion_decision": self._promotion_decision(),
                    "runtime_ledger_bucket": payload,
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertIn(
            "runtime_ledger_window_bounds_mismatch",
            result[0]["observed"]["runtime_window_rejection_reasons"],
        )
