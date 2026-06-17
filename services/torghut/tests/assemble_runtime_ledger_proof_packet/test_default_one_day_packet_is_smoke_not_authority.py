from __future__ import annotations

from tests.assemble_runtime_ledger_proof_packet.support import (
    Decimal,
    Path,
    _FakeObjectStoreClient,
    _IncompleteReceiptObjectStoreClient,
    _TestRuntimeLedgerProofPacketBase,
    _completion,
    _paper_route_evidence,
    _runtime_import,
    _status,
    cast,
    json,
    packet,
    patch,
    tempfile,
)


class TestDefaultOneDayPacketIsSmokeNotAuthority(_TestRuntimeLedgerProofPacketBase):
    def test_default_one_day_packet_is_smoke_not_authority(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(trading_days=1, net_pnl="600"),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertEqual(result["proof_mode"], "smoke")
        self.assertEqual(
            result["proof_mode_contract"],
            {
                "proof_mode": "smoke",
                "default_proof_mode": "smoke",
                "authority_scope": "plumbing_only",
                "mode_can_grant_final_authority": False,
                "mode_can_grant_promotion_authority": False,
                "requires_explicit_authority_mode_for_final_promotion": True,
                "implicit_default_final_authority": False,
            },
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["final_authority_ok"])
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["capital_promotion_allowed"])
        self.assertFalse(result["final_promotion_allowed"])
        self.assertEqual(
            result["authority_blockers"],
            ["runtime_ledger_proof_mode_not_authority"],
        )
        self.assertFalse(result["target"]["promotion_allowed"])
        self.assertFalse(
            result["target"]["source_backed_runtime_ledger_proof_required"]
        )
        self.assertFalse(
            result["target"]["non_empty_runtime_ledger_source_refs_required"]
        )
        self.assertEqual(result["target"]["min_runtime_ledger_trading_days"], 1)
        self.assertEqual(
            result["post_cost_proof_authority"]["blocking_reasons"],
            ["runtime_ledger_proof_mode_not_authority"],
        )
        self.assertEqual(result["next_action"], "rerun_proof_packet_in_authority_mode")

    def test_authority_packet_rejects_aggregate_only_runtime_import_materialization(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_observation = cast(
            dict[str, object],
            cast(dict[str, object], runtime_import["imports"][0])["summary"],
        )["runtime_observation"]
        assert isinstance(runtime_observation, dict)
        runtime_observation.update(
            {
                "runtime_ledger_source_execution_materialized_bucket_count": 0,
                "runtime_ledger_source_materializations": [],
                "runtime_ledger_materialization_pnl_derivations": [
                    "aggregate_only_runtime_ledger"
                ],
                "runtime_ledger_materialization_authority_reasons": ["aggregate_only"],
            }
        )

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["final_authority_ok"], result)
        self.assertIn(
            "runtime_window_import_source_execution_materialization_missing",
            result["authority_blockers"],
        )
        self.assertIn(
            "runtime_window_import_source_materialization_missing",
            result["authority_blockers"],
        )
        self.assertIn(
            "runtime_window_import_replay_or_artifact_derivation_not_authority",
            result["authority_blockers"],
        )

    def test_authority_packet_rejects_non_authoritative_target_notional_sizing(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_observation = cast(
            dict[str, object],
            cast(dict[str, object], runtime_import["imports"][0])["summary"],
        )["runtime_observation"]
        assert isinstance(runtime_observation, dict)
        runtime_observation.update(
            {
                "paper_route_target_notional_sizing_required_count": 1,
                "paper_route_target_notional_sizing_authoritative_count": 0,
                "paper_route_target_notional_sizing_missing_count": 1,
                "paper_route_target_notional_sizing_non_authoritative_count": 1,
            }
        )

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["final_authority_ok"], result)
        self.assertIn(
            "paper_route_target_notional_sizing_missing",
            result["authority_blockers"],
        )
        self.assertIn(
            "paper_route_target_notional_sizing_not_authoritative",
            result["authority_blockers"],
        )
        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertEqual(
            materialization["paper_route_target_notional_sizing_required_count"],
            1,
        )
        self.assertEqual(
            materialization["paper_route_target_notional_sizing_missing_count"],
            1,
        )

    def test_source_offsets_accept_mapping_and_skip_invalid_or_duplicate_values(
        self,
    ) -> None:
        self.assertEqual(
            packet._source_offsets(
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}
            ),
            [{"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}],
        )
        self.assertEqual(
            packet._source_offsets(
                [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                    {"topic": "alpaca.trade_updates", "offset": 43},
                    "alpaca.trade_updates:0:44",
                ]
            ),
            [{"topic": "alpaca.trade_updates", "partition": 0, "offset": 42}],
        )

    def test_authority_packet_fails_each_mechanical_authority_floor(self) -> None:
        cases = [
            (
                {"trading_days": 19, "net_pnl": "9500"},
                "runtime_ledger_trading_days_below_target",
            ),
            (
                {
                    "summary_overrides": {
                        "runtime_ledger_closed_round_trip_count": 299,
                        "runtime_ledger_closed_trade_count": 299,
                    }
                },
                "runtime_ledger_closed_round_trips_below_authority_floor",
            ),
            (
                {"filled_notional": "9999999"},
                "runtime_ledger_filled_notional_below_authority_floor",
            ),
            (
                {"summary_overrides": {"runtime_ledger_open_position_count": 1}},
                "runtime_ledger_open_position_count_nonzero",
            ),
            (
                {
                    "summary_overrides": {
                        "runtime_ledger_cost_amount": None,
                        "runtime_ledger_cost_basis_counts": {},
                        "runtime_ledger_cost_model_hash_count": 0,
                    }
                },
                "runtime_ledger_explicit_costs_missing",
            ),
            (
                {
                    "summary_overrides": {
                        "runtime_ledger_source_authority_bucket_count": 0,
                    }
                },
                "runtime_ledger_source_authority_missing",
            ),
            (
                {
                    "summary_overrides": {
                        "runtime_ledger_authority_blockers": [
                            "runtime_ledger_cost_basis_modeled"
                        ],
                    }
                },
                "runtime_ledger_authority_blockers_present",
            ),
            (
                {
                    "summary_overrides": {
                        "runtime_ledger_schema_versions": [
                            "torghut.exact_replay_ledger.v1"
                        ],
                    }
                },
                "runtime_ledger_exact_replay_schema_not_authority",
            ),
            (
                {"best_day_share": "0.251"},
                "runtime_ledger_best_day_share_above_limit",
            ),
            (
                {"symbol_concentration_share": "0.351"},
                "runtime_ledger_symbol_concentration_share_above_limit",
            ),
            (
                {"max_intraday_drawdown": "1501", "drawdown_pct": "0.031"},
                "runtime_ledger_max_intraday_drawdown_above_limit",
            ),
        ]
        for completion_kwargs, blocker in cases:
            with self.subTest(blocker=blocker):
                result = packet.build_runtime_ledger_proof_packet(
                    _status(),
                    proof_mode="authority",
                    paper_route_evidence=_paper_route_evidence(),
                    runtime_window_import=_runtime_import(),
                    completion_status=_completion(**completion_kwargs),
                    generated_at="2026-05-26T21:05:00+00:00",
                )
                self.assertFalse(result["final_authority_ok"], result)
                self.assertIn(
                    blocker, result["promotion_authority"]["blocking_reasons"]
                )

    def test_source_backed_fixture_preserves_missing_live_data_blockers(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=None,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["final_authority_ok"])
        self.assertIn("runtime_window_import_missing", result["blockers"])
        self.assertEqual(
            result["next_action"],
            "run_runtime_window_import_from_paper_route_target_plan",
        )

    def test_smoke_packet_cannot_grant_promotion_authority(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="smoke",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertFalse(result["final_authority_ok"])
        self.assertEqual(result["proof_mode"], "smoke")
        self.assertEqual(
            result["verdict"],
            "smoke_proof_satisfied_evidence_collection_only",
        )
        self.assertTrue(result["evidence_collection_ok"])
        self.assertFalse(result["canary_collection_authorized"])
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["capital_promotion_allowed"])
        self.assertFalse(result["final_promotion_allowed"])
        self.assertEqual(
            result["authority_blockers"],
            ["runtime_ledger_proof_mode_not_authority"],
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["target"]["max_runtime_ledger_drawdown_pct_equity"], "0.08"
        )
        self.assertEqual(
            result["target"]["max_runtime_ledger_symbol_concentration_share"],
            "0.5",
        )
        self.assertIn(
            "runtime_ledger_proof_mode_not_authority",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "rerun_proof_packet_in_authority_mode",
            result["required_actions"],
        )

    def test_probation_packet_authorizes_canary_evidence_without_final_promotion(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="probation",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["proof_mode"], "probation")
        self.assertEqual(
            result["proof_mode_contract"]["authority_scope"],
            "bounded_evidence_collection_only",
        )
        self.assertFalse(
            result["proof_mode_contract"]["mode_can_grant_final_authority"]
        )
        self.assertEqual(
            result["verdict"],
            "probation_proof_satisfied_evidence_collection_only",
        )
        self.assertTrue(result["evidence_collection_ok"])
        self.assertTrue(result["canary_collection_authorized"])
        self.assertFalse(result["final_authority_ok"])
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["capital_promotion_allowed"])
        self.assertFalse(result["final_promotion_allowed"])
        self.assertEqual(
            result["authority_blockers"],
            ["runtime_ledger_proof_mode_not_authority"],
        )
        self.assertFalse(result["capital_promotion_authority"]["allowed"])
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertIn(
            "runtime_ledger_proof_mode_not_authority",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_splits_post_cost_proof_from_capital_promotion_gate(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(
                blockers=[
                    "simple_submit_disabled",
                    "order_feed_lifecycle_disabled",
                    "promotion_decision_not_allowed",
                    "promotion_certificate_shadow_only",
                ]
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

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["verdict"],
            "post_cost_proof_authority_allowed_capital_promotion_blocked",
        )
        self.assertTrue(result["post_cost_proof_authority"]["allowed"])
        self.assertEqual(result["post_cost_proof_authority"]["blocking_reasons"], [])
        self.assertFalse(result["capital_promotion_authority"]["allowed"])
        self.assertEqual(
            result["capital_promotion_authority"]["blocking_reasons"],
            [
                "simple_submit_disabled",
                "order_feed_lifecycle_disabled",
                "promotion_decision_not_allowed",
                "promotion_certificate_shadow_only",
            ],
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["promotion_authority"]["failed_checks"],
            ["capital_promotion_gate"],
        )
        self.assertEqual(
            result["checks"]["live_status_gate"]["observed"]["proof_blockers"],
            [],
        )
        self.assertEqual(
            result["checks"]["live_status_gate"]["observed"][
                "capital_promotion_blockers"
            ],
            [
                "simple_submit_disabled",
                "order_feed_lifecycle_disabled",
                "promotion_decision_not_allowed",
                "promotion_certificate_shadow_only",
            ],
        )
        self.assertIn(
            "keep_promotion_blocked_until_live_gate_and_proof_floor_pass",
            result["required_actions"],
        )

    def test_packet_splits_post_cost_proof_from_paper_route_promotion_gate(
        self,
    ) -> None:
        evidence = _paper_route_evidence()
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": ["drift_checks_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = []

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

        self.assertTrue(result["post_cost_proof_authority"]["allowed"], result)
        self.assertEqual(result["post_cost_proof_authority"]["blocking_reasons"], [])
        self.assertEqual(
            result["verdict"],
            "post_cost_proof_authority_allowed_capital_promotion_blocked",
        )
        self.assertFalse(result["capital_promotion_authority"]["allowed"])
        self.assertEqual(
            result["capital_promotion_authority"]["blocking_reasons"],
            ["drift_checks_not_ok"],
        )
        self.assertFalse(result["promotion_authority"]["allowed"])
        self.assertEqual(
            result["promotion_authority"]["failed_checks"],
            ["paper_route_promotion_health_gate"],
        )
        self.assertIn(
            "drift_checks_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_cli_uploads_durable_proof_packet_artifact_with_runtime_run_id(
        self,
    ) -> None:
        fake_client = _FakeObjectStoreClient()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            runtime_path = root / "runtime.json"
            completion_path = root / "completion.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            runtime_path.write_text(
                json.dumps(
                    {
                        "run_id": "sim-2026-05-05-chip-renew-20260526T212300Z",
                        "manifest_path": (
                            "/tmp/torghut-empirical-renewal/"
                            "sim-2026-05-05-chip-renew-20260526T212300Z/"
                            "empirical-promotion-manifest.yaml"
                        ),
                        "output_dir": (
                            "/tmp/torghut-empirical-renewal/"
                            "sim-2026-05-05-chip-renew-20260526T212300Z"
                        ),
                        "status": "ok",
                        "empirical_promotion": {"status": "ok"},
                        "runtime_window_import": _runtime_import(),
                    }
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            with patch.object(
                packet,
                "_ceph_client_from_env",
                return_value=(fake_client, "torghut-empirical-artifacts"),
            ):
                exit_code = packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--runtime-window-import-file",
                        str(runtime_path),
                        "--completion-file",
                        str(completion_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                        "--generated-at",
                        "2026-05-26T21:30:00+00:00",
                        "--artifact-prefix",
                        "runtime-ledger-proof-packets/{run_id}",
                        "--artifact-name",
                        "authority-packet.json",
                        "--require-artifact-upload",
                    ]
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(fake_client.uploads), 1)
            upload = fake_client.uploads[0]
            self.assertEqual(upload["bucket"], "torghut-empirical-artifacts")
            self.assertEqual(
                upload["key"],
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "authority-packet.json",
            )
            local_payload = json.loads(output_path.read_text(encoding="utf-8"))
            uploaded_payload = json.loads(cast(bytes, upload["body"]).decode("utf-8"))
            self.assertEqual(
                uploaded_payload["artifact"]["payload_sha256"],
                local_payload["artifact"]["payload_sha256"],
            )
            self.assertNotIn("upload_receipt", uploaded_payload["artifact"])
            self.assertEqual(
                local_payload["artifact"]["runtime_window_import_run_id"],
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(
                local_payload["artifact"]["prefix"],
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(
                local_payload["artifact"]["uri"],
                "s3://torghut-empirical-artifacts/"
                "runtime-ledger-proof-packets/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "authority-packet.json",
            )
            self.assertTrue(local_payload["artifact"]["uploaded"])
            self.assertTrue(local_payload["artifact"]["upload_required"])
            self.assertTrue(local_payload["artifact"]["receipt_verified"])
            self.assertEqual(
                local_payload["artifact"]["upload_receipt"],
                {
                    "bucket": "torghut-empirical-artifacts",
                    "key": (
                        "runtime-ledger-proof-packets/"
                        "sim-2026-05-05-chip-renew-20260526T212300Z/"
                        "authority-packet.json"
                    ),
                    "uri": (
                        "s3://torghut-empirical-artifacts/"
                        "runtime-ledger-proof-packets/"
                        "sim-2026-05-05-chip-renew-20260526T212300Z/"
                        "authority-packet.json"
                    ),
                },
            )
            self.assertRegex(
                local_payload["artifact"]["payload_sha256"], r"^[0-9a-f]{64}$"
            )
            lineage = local_payload["evidence"]["runtime_window_import"]["lineage"]
            self.assertEqual(
                lineage["run_id"],
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertEqual(lineage["status"], "ok")
            self.assertEqual(lineage["empirical_promotion_status"], "ok")
            self.assertEqual(
                lineage["manifest_path"],
                "/tmp/torghut-empirical-renewal/"
                "sim-2026-05-05-chip-renew-20260526T212300Z/"
                "empirical-promotion-manifest.yaml",
            )
            self.assertEqual(
                lineage["output_dir"],
                "/tmp/torghut-empirical-renewal/"
                "sim-2026-05-05-chip-renew-20260526T212300Z",
            )
            self.assertTrue(lineage["nested_runtime_window_import_present"])
            self.assertEqual(lineage["runtime_window_import_item_count"], 1)
            immutable_lineage = local_payload["lineage"]
            self.assertEqual(immutable_lineage["hypothesis_id"], "H-PAIRS-01")
            self.assertEqual(
                immutable_lineage["runtime_strategy"],
                "microbar-pairs-vwap-cap-safe",
            )
            self.assertEqual(immutable_lineage["account_label"], "TORGHUT_SIM")
            self.assertEqual(immutable_lineage["stage"], "paper")
            self.assertEqual(
                immutable_lineage["strategy_runtime_ledger_bucket_refs"],
                [
                    "strategy-runtime-ledger-buckets:H-PAIRS-01:2026-05-26",
                    "strategy_runtime_ledger_buckets:runtime-ledger-bucket-1",
                ],
            )
            self.assertEqual(
                immutable_lineage["counts"]["strategy_runtime_ledger_bucket_ref_count"],
                2,
            )
            self.assertEqual(
                immutable_lineage["runtime_ledger_bucket_ids"],
                ["runtime-ledger-bucket-1"],
            )
            self.assertEqual(
                immutable_lineage["artifact"]["uri"],
                local_payload["artifact"]["uri"],
            )
            self.assertEqual(
                immutable_lineage["artifact"]["payload_sha256"],
                local_payload["artifact"]["payload_sha256"],
            )

    def test_cli_fails_closed_when_required_artifact_upload_is_not_configured(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=["paper_route_session_window_not_open"],
                    )
                ),
                encoding="utf-8",
            )

            with patch.object(
                packet,
                "_ceph_client_from_env",
                return_value=(None, "torghut-empirical-artifacts"),
            ):
                with self.assertRaisesRegex(
                    SystemExit,
                    "runtime_ledger_proof_artifact_upload_not_configured",
                ):
                    packet.main(
                        [
                            "--status-file",
                            str(status_path),
                            "--paper-route-evidence-file",
                            str(paper_path),
                            "--output-file",
                            str(output_path),
                            "--artifact-prefix",
                            "runtime-ledger-proof-packets/{run_id}",
                            "--require-artifact-upload",
                            "--allow-blocked-exit-zero",
                        ]
                    )

            self.assertFalse(output_path.exists())

    def test_cli_fails_closed_when_required_artifact_prefix_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=["paper_route_session_window_not_open"],
                    )
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                SystemExit,
                "runtime_ledger_proof_artifact_upload_prefix_missing",
            ):
                packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--output-file",
                        str(output_path),
                        "--require-artifact-upload",
                        "--allow-blocked-exit-zero",
                    ]
                )

            self.assertFalse(output_path.exists())

    def test_cli_fails_closed_when_required_artifact_receipt_is_incomplete(
        self,
    ) -> None:
        fake_client = _IncompleteReceiptObjectStoreClient()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            status_path = root / "status.json"
            paper_path = root / "paper.json"
            runtime_path = root / "runtime.json"
            completion_path = root / "completion.json"
            output_path = root / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            runtime_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            with patch.object(
                packet,
                "_ceph_client_from_env",
                return_value=(fake_client, "torghut-empirical-artifacts"),
            ):
                with self.assertRaisesRegex(
                    SystemExit,
                    (
                        "runtime_ledger_proof_artifact_upload_receipt_incomplete:"
                        "runtime_ledger_proof_artifact_upload_receipt_uri_missing"
                    ),
                ):
                    packet.main(
                        [
                            "--status-file",
                            str(status_path),
                            "--paper-route-evidence-file",
                            str(paper_path),
                            "--runtime-window-import-file",
                            str(runtime_path),
                            "--completion-file",
                            str(completion_path),
                            "--proof-mode",
                            "authority",
                            "--output-file",
                            str(output_path),
                            "--artifact-prefix",
                            "runtime-ledger-proof-packets/{run_id}",
                            "--require-artifact-upload",
                        ]
                    )

            self.assertEqual(len(fake_client.uploads), 1)
            self.assertFalse(output_path.exists())
