from __future__ import annotations

from tests.assemble_runtime_ledger_proof_packet.support import (
    Any,
    Decimal,
    _TestRuntimeLedgerProofPacketBase,
    _completion,
    _hpairs_source_proof_census,
    _paper_route_evidence,
    _proofs_payload,
    _runtime_import,
    _status,
    _tigerbeetle_ledger_status,
    cast,
    json,
    os,
    packet,
    patch,
)


class TestScalarNormalizersHandleRuntimeJsonVariants(_TestRuntimeLedgerProofPacketBase):
    def test_scalar_normalizers_handle_runtime_json_variants(self) -> None:
        self.assertTrue(packet._bool(Decimal("1")))
        self.assertFalse(packet._bool(0))
        self.assertTrue(packet._bool("allowed"))
        self.assertFalse(packet._bool(object()))

        self.assertEqual(packet._int(True), 1)
        self.assertEqual(packet._int(4.9), 4)
        self.assertEqual(packet._int(Decimal("7")), 7)
        self.assertEqual(packet._int("8.0"), 8)
        self.assertEqual(packet._int("bad", default=-1), -1)

        self.assertEqual(packet._decimal(Decimal("12.5")), Decimal("12.5"))
        self.assertIsNone(packet._decimal("not-a-number"))

    def test_runtime_import_readback_blocks_missing_execution_tca_refs(self) -> None:
        blockers = packet._runtime_import_readback_blockers(
            target={
                "metric_window_count": 0,
                "promotion_decision_count": 0,
                "runtime_ledger_bucket_count": 0,
                "evidence_grade_runtime_ledger_bucket_count": 0,
            },
            readback={
                "schema_version": "torghut.runtime-window-import-readback.v1",
                "metric_window_count": 0,
                "promotion_decision_count": 0,
                "runtime_ledger_bucket_count": 0,
                "evidence_grade_runtime_ledger_bucket_count": 0,
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "runtime_ledger_source_window_ids": ["source-window-1"],
                "runtime_ledger_execution_order_event_ids": ["event-1"],
                "execution_ids": ["execution-1"],
                "trade_decision_ids": ["decision-1"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
                ],
                "source_materializations": ["execution_order_events"],
                "authority_classes": ["runtime_order_feed_execution_source"],
                "runtime_ledger_cost_amount": "0.01",
                "cost_basis_counts": {"broker_reported_commission_and_fees": 1},
            },
            profit_proof_count=1,
        )

        self.assertIn("runtime_ledger_execution_tca_refs_missing", blockers)
        self.assertIn("execution_tca_missing", blockers)

    def test_ceph_client_from_env_uses_direct_empirical_endpoint(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_ENDPOINT": "https://rgw.torghut.internal/",
                "TORGHUT_EMPIRICAL_CEPH_ACCESS_KEY": "direct-access",
                "TORGHUT_EMPIRICAL_CEPH_SECRET_KEY": "direct-secret",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET": "direct-bucket",
                "TORGHUT_EMPIRICAL_CEPH_REGION": "us-west-2",
                "TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS": "35",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertEqual(bucket, "direct-bucket")
        self.assertIsNotNone(client)
        assert client is not None
        concrete_client = cast(Any, client)
        self.assertEqual(concrete_client.endpoint, "https://rgw.torghut.internal")
        self.assertEqual(concrete_client.access_key, "direct-access")
        self.assertEqual(concrete_client.secret_key, "direct-secret")
        self.assertEqual(concrete_client.region, "us-west-2")
        self.assertEqual(concrete_client.timeout_seconds, 35)

    def test_ceph_client_from_env_uses_bucket_host_fallbacks(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST": "rook-ceph-rgw",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_PORT": "8080",
                "TORGHUT_EMPIRICAL_CEPH_USE_TLS": "true",
                "AWS_ACCESS_KEY_ID": "aws-access",
                "AWS_SECRET_ACCESS_KEY": "aws-secret",
                "BUCKET_NAME": "fallback-bucket",
                "TORGHUT_EMPIRICAL_CEPH_TIMEOUT_SECONDS": "0",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertEqual(bucket, "fallback-bucket")
        self.assertIsNotNone(client)
        assert client is not None
        concrete_client = cast(Any, client)
        self.assertEqual(concrete_client.endpoint, "https://rook-ceph-rgw:8080")
        self.assertEqual(concrete_client.access_key, "aws-access")
        self.assertEqual(concrete_client.secret_key, "aws-secret")
        self.assertEqual(concrete_client.region, "us-east-1")
        self.assertEqual(concrete_client.timeout_seconds, 1)

    def test_ceph_client_from_env_returns_bucket_without_credentials(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TORGHUT_EMPIRICAL_CEPH_BUCKET_HOST": "rook-ceph-rgw",
                "TORGHUT_EMPIRICAL_CEPH_BUCKET": "configured-bucket",
            },
            clear=True,
        ):
            client, bucket = packet._ceph_client_from_env()

        self.assertIsNone(client)
        self.assertEqual(bucket, "configured-bucket")

    def test_resolve_artifact_prefix_defaults_missing_runtime_run_id(self) -> None:
        self.assertEqual(
            packet._resolve_artifact_prefix(
                "runtime-ledger-proof-packets/{run_id}/{generated_at}",
                runtime_window_import=None,
                generated_at="2026-05-26T21:30:00+00:00",
            ),
            "runtime-ledger-proof-packets/unknown-run/2026-05-26T21-30-00-00-00",
        )

    def test_packet_allows_only_complete_post_cost_runtime_ledger_proof(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["schema_version"], packet.SCHEMA_VERSION)
        self.assertEqual(result["verdict"], "promotion_authority_allowed")
        self.assertEqual(result["promotion_authority"]["blocking_reasons"], [])
        self.assertEqual(result["blockers"], [])
        self.assertEqual(result["target"]["proof_mode"], "authority")
        self.assertEqual(result["target"]["min_runtime_ledger_trading_days"], 20)
        self.assertEqual(
            result["target"]["min_runtime_ledger_daily_net_pnl_after_costs"], "500"
        )
        self.assertEqual(
            result["target"]["min_runtime_ledger_net_pnl_after_costs"], "10000"
        )
        self.assertTrue(result["target"]["source_backed_runtime_ledger_proof_required"])
        self.assertTrue(
            result["target"]["non_empty_runtime_ledger_source_refs_required"]
        )
        self.assertEqual(result["candidate"]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            result["checks"]["runtime_ledger_post_cost_profit_target"]["observed"][
                "mean_daily_net_pnl_after_costs"
            ],
            "500",
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["observed"][
                "drawdown_pct_equity"
            ],
            "0.02",
        )

        self.assertEqual(
            result["checks"]["runtime_ledger_daily_distribution_authority"]["observed"][
                "median_daily_net_pnl_after_costs"
            ],
            "500",
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_target_implied_scale"]["observed"][
                "target_implied_avg_daily_filled_notional"
            ],
            "384615.3846153846153846153846",
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_drawdown_pct_equity"],
            "0.03",
        )
        self.assertEqual(
            result["target"]["min_runtime_ledger_median_daily_net_pnl_after_costs"],
            "250",
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_intraday_drawdown"], "1500"
        )
        self.assertEqual(
            result["target"]["target_implied_avg_daily_filled_notional"],
            "384615.3846153846153846153846",
        )
        self.assertEqual(result["proof_mode"], "authority")
        self.assertTrue(result["final_authority_ok"])
        self.assertTrue(result["promotion_allowed"])
        self.assertTrue(result["capital_promotion_allowed"])
        self.assertTrue(result["final_promotion_allowed"])
        self.assertEqual(result["authority_blockers"], [])
        self.assertFalse(result["evidence_collection_only"])
        self.assertEqual(
            result["target"]["min_runtime_ledger_net_pnl_after_costs"], "10000"
        )
        self.assertEqual(
            result["target"]["min_runtime_ledger_daily_net_pnl_after_costs"], "500"
        )
        self.assertEqual(result["target"]["min_runtime_ledger_trading_days"], 20)
        self.assertEqual(
            result["target"]["min_runtime_ledger_filled_notional"], "10000000"
        )
        tigerbeetle_refs = result["evidence"]["runtime_window_import"][
            "materialization"
        ]["materialized_targets"][0]["tigerbeetle"]
        self.assertEqual(
            tigerbeetle_refs["schema_version"],
            "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        )
        self.assertEqual(tigerbeetle_refs["transfer_count"], 1)
        self.assertEqual(
            tigerbeetle_refs["source_refs"],
            [
                "postgres:tigerbeetle_account_refs",
                "postgres:tigerbeetle_transfer_refs",
            ],
        )

    def test_packet_blocks_stale_assembly_image_against_live_status(self) -> None:
        status = _status()
        status["build"] = {
            "version": "v0.596.0-371-gcurrent",
            "commit": "abc123",
            "image_digest": "sha256:current",
            "active_revision": "torghut-01158",
        }

        with patch.dict(
            os.environ,
            {
                "TORGHUT_COMMIT": "abc123",
                "TORGHUT_IMAGE_DIGEST": "sha256:stale",
            },
            clear=True,
        ):
            result = packet.build_runtime_ledger_proof_packet(
                status,
                proof_mode="authority",
                paper_route_evidence=_paper_route_evidence(),
                runtime_window_import=_runtime_import(),
                completion_status=_completion(),
                min_runtime_ledger_net_pnl=Decimal("500"),
                min_runtime_ledger_daily_net_pnl=Decimal("500"),
                min_runtime_ledger_trading_days=1,
                generated_at="2026-05-26T21:05:00+00:00",
            )

        self.assertFalse(result["ok"], result)
        self.assertIn(
            "proof_packet_assembly_image_digest_mismatch",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "rerun_runtime_window_import_on_current_torghut_image",
            result["required_actions"],
        )
        parity = result["checks"]["runtime_code_parity"]
        self.assertFalse(parity["passed"])
        self.assertEqual(
            parity["observed"]["live_status_build"]["image_digest"], "sha256:current"
        )
        self.assertEqual(
            parity["observed"]["assembly_runtime"]["image_digest"], "sha256:stale"
        )
        self.assertEqual(result["lineage"]["code"]["commit"], "abc123")

    def test_packet_lineage_preserves_runtime_window_readback_refs(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(ledger_refs=[]),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        lineage = result["lineage"]
        self.assertEqual(
            lineage["strategy_runtime_ledger_bucket_refs"],
            ["strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"],
        )
        self.assertEqual(
            lineage["counts"]["strategy_runtime_ledger_bucket_ref_count"], 1
        )
        for source_row_id in (
            "source-window-1",
            "event-1",
            "execution-1",
            "tca-1",
            "decision-1",
        ):
            self.assertIn(source_row_id, lineage["source_row_ids"])
        self.assertEqual(lineage["counts"]["source_row_id_count"], 5)
        self.assertCountEqual(
            lineage["metric_window_ids"],
            ["metric-window-1", "strategy_hypothesis_metric_windows:metric-window-1"],
        )
        self.assertCountEqual(
            lineage["promotion_decision_ids"],
            [
                "promotion-decision-1",
                "strategy_promotion_decisions:promotion-decision-1",
            ],
        )
        for source_ref in (
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ):
            self.assertIn(source_ref, lineage["source_refs"])

    def test_packet_lineage_ignores_nested_empty_readback_collections(self) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        summary = first_import["summary"]
        assert isinstance(summary, dict)
        target = summary["runtime_materialization_target"]
        assert isinstance(target, dict)
        readback = target["readback"]
        assert isinstance(readback, dict)
        target["runtime_ledger_bucket_ids"] = [
            "runtime-ledger-bucket-1",
            [],
        ]
        target["evidence_grade_runtime_ledger_bucket_ids"] = [
            "runtime-ledger-bucket-1",
            [],
        ]
        readback["source_row_ids"] = [[]]
        readback["runtime_ledger_source_row_ids"] = [["source-window-nested"]]
        readback["trade_decision_ids"] = "decision-scalar"
        readback["source_refs"] = [
            "postgres:trade_decisions",
            [],
            {},
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(ledger_refs=[]),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        lineage = result["lineage"]
        self.assertNotIn("[]", lineage["source_row_ids"])
        self.assertNotIn("[]", lineage["runtime_ledger_bucket_ids"])
        self.assertIn("source-window-nested", lineage["source_row_ids"])
        self.assertIn("decision-scalar", lineage["source_row_ids"])
        self.assertEqual(
            lineage["runtime_ledger_bucket_ids"],
            ["runtime-ledger-bucket-1"],
        )

    def test_hpairs_source_proof_census_blockers_are_non_authority_packet_blockers(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            hpairs_source_proof_census=_hpairs_source_proof_census(
                blockers=["submitted_orders_missing"],
                final_authority_ok=False,
            ),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["final_authority_ok"])
        self.assertFalse(result["promotion_allowed"])
        self.assertIn("submitted_orders_missing", result["authority_blockers"])
        census_status = result["evidence"]["hpairs_source_proof_census"]
        self.assertTrue(census_status["present"])
        self.assertTrue(census_status["non_authority_status_only"])
        self.assertFalse(census_status["promotion_allowed"])
        self.assertEqual(
            census_status["next_blocker"]["step"], "submitted_orders_present"
        )

    def test_hpairs_source_proof_census_ready_status_does_not_grant_authority(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(blockers=["live_gate_blocked"]),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            hpairs_source_proof_census=_hpairs_source_proof_census(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        census_status = result["evidence"]["hpairs_source_proof_census"]
        self.assertTrue(census_status["present"])
        self.assertTrue(census_status["census_ready"])
        self.assertTrue(census_status["runtime_authority_final_ok"])
        self.assertFalse(census_status["promotion_allowed"])
        self.assertFalse(census_status["final_authority_ok"])
        self.assertFalse(result["final_authority_ok"])
        self.assertFalse(result["promotion_allowed"])
        self.assertIn("live_gate_blocked", result["authority_blockers"])

    def test_hpairs_source_proof_census_attachment_blockers_block_authority(
        self,
    ) -> None:
        census = _hpairs_source_proof_census()
        census["schema_version"] = "torghut.hpairs-source-proof-census.v0"
        census["source"] = {
            "kind": "fixture_json",
            "read_only": False,
            "writes_proof": True,
            "modifies_rows": True,
            "runtime_stage": "paper",
            "replay_outputs_count_as_runtime_proof": True,
            "synthetic_proof_created": True,
        }

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            hpairs_source_proof_census=census,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        blockers = [
            "hpairs_source_proof_census_schema_mismatch",
            "hpairs_source_proof_census_not_read_only",
            "hpairs_source_proof_census_writes_proof",
            "hpairs_source_proof_census_modifies_rows",
            "hpairs_source_proof_census_replay_outputs_claim_runtime_proof",
            "hpairs_source_proof_census_synthetic_proof_created",
        ]
        self.assertFalse(result["ok"])
        self.assertFalse(result["final_authority_ok"])
        self.assertFalse(result["promotion_allowed"])
        for blocker in blockers:
            self.assertIn(blocker, result["authority_blockers"])
        census_status = result["evidence"]["hpairs_source_proof_census"]
        self.assertEqual(census_status["attachment_blockers"], blockers)
        for blocker in blockers:
            self.assertIn(blocker, census_status["blockers"])

    def test_packet_prefers_importable_paper_route_plan_over_next_session_plan(
        self,
    ) -> None:
        evidence = _paper_route_evidence()
        import_plan = cast(
            dict[str, object],
            evidence["next_paper_route_runtime_window_targets"],
        )
        import_plan["purpose"] = (
            "latest_closed_session_paper_route_runtime_window_import"
        )
        evidence["runtime_window_import_plan"] = import_plan
        evidence["next_paper_route_runtime_window_targets"] = {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "target_count": 1,
            "purpose": "next_session_paper_route_runtime_window_evidence_collection",
            "session_readiness": {
                "import_ready": False,
                "import_blockers": ["paper_route_session_window_not_open"],
            },
            "runtime_window_import_handoff": {
                "import_ready": False,
                "import_blockers": ["paper_route_session_window_not_open"],
            },
            "targets": [
                {
                    "candidate_id": "future-candidate",
                    "hypothesis_id": "H-FUTURE",
                    "observed_stage": "paper",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "future-paper-route-candidate",
                    "account_label": "TORGHUT_SIM",
                    "source_manifest_ref": "config/trading/hypotheses/h-future.json",
                    "window_start": "2026-05-27T13:30:00+00:00",
                    "window_end": "2026-05-27T20:00:00+00:00",
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": "true",
                    "drift_ok": "true",
                    "runtime_window_import_health_gate": {
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "drift_ok": "true",
                        "blockers": [],
                    },
                }
            ],
        }

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["evidence"]["paper_route_target_plan"]["session_window"]["start"],
            "2026-05-26T13:30:00+00:00",
        )
        self.assertEqual(
            result["candidate"]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )

    def test_proofs_payload_builds_target_plan_and_import_audit(self) -> None:
        proofs = _proofs_payload()

        plan = packet._paper_route_target_plan(proofs)
        audit = packet._paper_route_runtime_window_import_audit(proofs)

        self.assertEqual(plan["source"], "trading_proofs_endpoint")
        self.assertEqual(plan["target_count"], 1)
        self.assertTrue(plan["session_readiness"]["import_ready"])
        self.assertEqual(
            plan["targets"][0]["paper_route_probe_symbol_actions"],
            {"AAPL": "buy", "AMZN": "sell"},
        )
        self.assertEqual(audit["state"], "import_due")
        self.assertTrue(audit["import_ready"])
        self.assertEqual(audit["next_action"], "run_runtime_ledger_materialization")
        self.assertEqual(audit["counts"]["targets_with_source_activity"], 1)
        self.assertEqual(
            audit["target_blockers"][0]["blockers"],
            ["runtime_ledger_materialization_missing"],
        )

    def test_packet_preserves_selected_import_plan_health_gate_readback(
        self,
    ) -> None:
        evidence = _paper_route_evidence()
        import_plan = json.loads(
            json.dumps(evidence["next_paper_route_runtime_window_targets"])
        )
        import_plan["source"] = "paper_route_observed_strategy_source_collection"
        import_plan["purpose"] = (
            "observed_strategy_runtime_ledger_source_collection_import"
        )
        import_plan["targets"][0]["source_kind"] = (
            "runtime_ledger_source_collection_candidate"
        )
        import_plan["targets"][0]["selected_by"] = (
            "paper_route_observed_strategy_source_collection"
        )
        evidence["runtime_window_import_plan"] = import_plan

        result = packet.build_runtime_ledger_proof_packet(
            _status(blockers=["runtime_ledger_source_collection_pending"]),
            proof_mode="authority",
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn("runtime_ledger_source_collection_pending", result["blockers"])
        for blocker in (
            "runtime_window_import_health_gate_missing",
            "dependency_quorum_not_allow",
            "continuity_not_ok",
        ):
            self.assertNotIn(blocker, result["blockers"])
        health_gate = result["evidence"]["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertTrue(health_gate["ready"])
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blockers"], [])

    def test_authority_packet_allows_reconciled_tigerbeetle_runtime_refs(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(tigerbeetle_ledger=_tigerbeetle_ledger_status()),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["promotion_authority"]["allowed"], result)
        check = result["checks"]["tigerbeetle_runtime_pnl_authority_refs"]
        self.assertTrue(check["passed"], check)
        self.assertTrue(check["observed"]["required_for_authority"])
        self.assertEqual(check["observed"]["runtime_ledger_signed_transfer_count"], 1)

    def test_authority_packet_blocks_claimed_tigerbeetle_without_signed_refs(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(
                tigerbeetle_ledger=_tigerbeetle_ledger_status(
                    runtime_ledger_ref_count=1,
                    signed_ref_count=0,
                )
            ),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertIn(
            "tigerbeetle_runtime_ledger_signed_refs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "tigerbeetle_runtime_pnl_authority_refs",
            result["promotion_authority"]["failed_checks"],
        )

    def test_authority_packet_requires_daily_distribution_and_scale(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                avg_daily_filled_notional="200000",
                median_daily_net_pnl="200",
                p10_daily_net_pnl="-300",
                worst_day_net_pnl="-800",
                max_intraday_drawdown="1600",
                drawdown_pct="0.031",
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["final_authority_ok"])
        daily_blockers = result["checks"][
            "runtime_ledger_daily_distribution_authority"
        ]["blockers"]
        self.assertIn(
            "runtime_ledger_median_daily_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_worst_day_net_pnl_after_costs_below_floor",
            daily_blockers,
        )
        self.assertIn(
            "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor",
            result["checks"]["runtime_ledger_target_implied_scale"]["blockers"],
        )
        self.assertIn(
            "runtime_ledger_max_intraday_drawdown_above_limit",
            result["checks"]["runtime_ledger_risk_quality"]["blockers"],
        )
        self.assertEqual(result["verdict"], "blocked")

    def test_authority_packet_requires_daily_distribution_fields(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                avg_daily_filled_notional=None,
                median_daily_net_pnl=None,
                p10_daily_net_pnl=None,
                worst_day_net_pnl=None,
                max_intraday_drawdown=None,
                drawdown_pct=None,
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_median_daily_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_p10_daily_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_worst_day_net_pnl_after_costs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_avg_daily_filled_notional_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_max_intraday_drawdown_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
