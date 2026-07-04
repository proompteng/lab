from __future__ import annotations

from tests.assemble_runtime_ledger_proof_packet.support import (
    HTTPError,
    Namespace,
    Path,
    _TestRuntimeLedgerProofPacketBase,
    _completion,
    _paper_route_evidence,
    _runtime_import,
    _status,
    io,
    json,
    packet,
    patch,
    tempfile,
)


class TestPacketAcceptsAlternateRuntimePlanAndCompletionGateShapes(
    _TestRuntimeLedgerProofPacketBase
):
    def test_packet_accepts_alternate_runtime_plan_and_completion_gate_shapes(
        self,
    ) -> None:
        paper = _paper_route_evidence()
        plan = paper.pop("next_paper_route_runtime_window_targets")
        assert isinstance(plan, dict)
        paper["runtime_window_import_plan"] = plan
        completion_gate = _completion()["gates"][0]

        result = packet.build_runtime_ledger_proof_packet(
            {"mode": "paper", "running": True, "live_gate": {"allowed": True}},
            proof_mode="authority",
            paper_route_evidence=paper,
            runtime_window_import={
                "status": "ok",
                "proof_status": "ok",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "summary": {
                    "runtime_observation": {
                        "authoritative": True,
                        "runtime_ledger_profit_proof_present": True,
                        "runtime_ledger_tca_profit_proof_count": 1,
                        "runtime_ledger_source_execution_materialized_bucket_count": 1,
                        "runtime_ledger_source_materializations": [
                            "execution_order_events"
                        ],
                        "runtime_ledger_materialization_pnl_derivations": [
                            "execution_order_events_runtime_ledger"
                        ],
                    },
                    "runtime_materialization_target": {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "observed_stage": "paper",
                        "account_label": "TORGHUT_SIM",
                        "runtime_ledger_profit_proof_present": True,
                        "metric_window_count": 1,
                        "promotion_decision_count": 1,
                        "runtime_ledger_bucket_count": 1,
                        "evidence_grade_runtime_ledger_bucket_count": 1,
                        "materialized": True,
                        "materialization_blockers": [],
                        "metric_window_ids": ["metric-window-1"],
                        "promotion_decision_id": "promotion-decision-1",
                        "runtime_ledger_bucket_ids": ["runtime-ledger-bucket-1"],
                        "evidence_grade_runtime_ledger_bucket_ids": [
                            "runtime-ledger-bucket-1"
                        ],
                        "readback": {
                            "schema_version": "torghut.runtime-window-import-readback.v1",
                            "metric_window_count": 1,
                            "promotion_decision_count": 1,
                            "runtime_ledger_bucket_count": 1,
                            "evidence_grade_runtime_ledger_bucket_count": 1,
                            "metric_window_refs": [
                                "strategy_hypothesis_metric_windows:metric-window-1"
                            ],
                            "promotion_decision_refs": [
                                "strategy_promotion_decisions:promotion-decision-1"
                            ],
                            "runtime_ledger_bucket_refs": [
                                "strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"
                            ],
                            "evidence_grade_runtime_ledger_bucket_refs": [
                                "strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"
                            ],
                            "source_refs": [
                                "postgres:trade_decisions",
                                "postgres:executions",
                                "postgres:execution_order_events",
                                "postgres:order_feed_source_windows",
                            ],
                            "runtime_ledger_source_window_ids": ["source-window-1"],
                            "runtime_ledger_execution_order_event_ids": ["event-1"],
                            "execution_ids": ["execution-1"],
                            "execution_tca_metric_ids": ["tca-1"],
                            "trade_decision_ids": ["decision-1"],
                            "source_offsets": [
                                {
                                    "topic": "alpaca.trade_updates",
                                    "partition": 0,
                                    "offset": 42,
                                }
                            ],
                            "runtime_ledger_cost_amount": "1250",
                            "cost_basis_counts": {
                                "alpaca_2026_equity_fee_schedule": 300
                            },
                            "authority_classes": [
                                "runtime_order_feed_execution_source"
                            ],
                            "authority_reasons": [
                                "event_sourced_runtime_ledger_profit_proof"
                            ],
                            "source_materializations": ["execution_order_events"],
                        },
                    },
                },
            },
            completion_status={
                "gates_by_id": {
                    packet.DOC29_LIVE_SCALE_GATE: completion_gate,
                },
            },
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["evidence"]["paper_route_target_plan"]["target_count"], 1
        )
        self.assertEqual(
            result["evidence"]["runtime_window_import"][
                "authoritative_observation_count"
            ],
            1,
        )

    def test_packet_preserves_string_proof_blockers_from_runtime_imports(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import={
                "proof_status": "blocked",
                "proof_blockers": ["runtime_ledger_bucket_missing"],
                "imports": [
                    {
                        "proof_status": "blocked",
                        "proof_blockers": ["runtime_ledger_pnl_basis_missing"],
                        "summary": {
                            "runtime_observation": {
                                "authoritative": False,
                            },
                        },
                    }
                ],
            },
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_bucket_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "run_runtime_window_import_from_paper_route_target_plan",
            result["required_actions"],
        )

    def test_cli_writes_packet_and_returns_nonzero_for_blocked_packet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(
                json.dumps(
                    _runtime_import(
                        proof_status="blocked",
                        proof_blockers=["runtime_ledger_pnl_basis_missing"],
                    )
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "blocked")
            self.assertIn(
                "runtime_ledger_pnl_basis_missing",
                payload["promotion_authority"]["blocking_reasons"],
            )

    def test_cli_defaults_to_smoke_mode_without_promotion_authority(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")
            completion_path.write_text(
                json.dumps(_completion(trading_days=1, net_pnl="600")),
                encoding="utf-8",
            )

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["proof_mode"], "smoke")
            self.assertEqual(
                payload["proof_mode_contract"]["authority_scope"], "plumbing_only"
            )
            self.assertFalse(
                payload["proof_mode_contract"]["implicit_default_final_authority"]
            )
            self.assertEqual(
                payload["verdict"],
                "smoke_proof_satisfied_evidence_collection_only",
            )
            self.assertFalse(payload["promotion_allowed"])
            self.assertFalse(payload["final_promotion_allowed"])
            self.assertFalse(payload["final_authority_ok"])
            self.assertTrue(payload["evidence_collection_ok"])
            self.assertFalse(payload["promotion_authority"]["allowed"])
            self.assertEqual(
                payload["promotion_authority"]["reason"],
                "runtime_ledger_proof_mode_not_authority",
            )
            self.assertEqual(
                payload["authority_blockers"],
                ["runtime_ledger_proof_mode_not_authority"],
            )
            self.assertEqual(
                payload["next_action"], "rerun_proof_packet_in_authority_mode"
            )
            self.assertEqual(
                payload["checks"]["runtime_ledger_proof_mode_contract"]["observed"][
                    "promotion_allowed"
                ],
                False,
            )

    def test_cli_authority_mode_ignores_lower_runtime_floor_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--proof-mode",
                    "authority",
                    "--min-runtime-ledger-net-pnl",
                    "1",
                    "--min-runtime-ledger-daily-net-pnl",
                    "1",
                    "--min-runtime-ledger-trading-days",
                    "1",
                    "--max-runtime-ledger-drawdown-pct-equity",
                    "1",
                    "--max-runtime-ledger-best-day-share",
                    "1",
                    "--max-runtime-ledger-symbol-concentration-share",
                    "1",
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "promotion_authority_allowed")
            self.assertEqual(
                payload["target"]["min_runtime_ledger_net_pnl_after_costs"],
                "10000",
            )
            self.assertEqual(
                payload["target"]["min_runtime_ledger_daily_net_pnl_after_costs"],
                "500",
            )
            self.assertEqual(payload["target"]["min_runtime_ledger_trading_days"], 20)
            self.assertEqual(
                payload["target"]["min_runtime_ledger_closed_round_trips"],
                300,
            )
            self.assertEqual(
                payload["target"]["min_runtime_ledger_filled_notional"],
                "10000000",
            )
            self.assertEqual(
                payload["target"]["max_runtime_ledger_drawdown_pct_equity"],
                "0.03",
            )
            self.assertEqual(
                payload["target"]["max_runtime_ledger_best_day_share"],
                "0.25",
            )
            self.assertEqual(
                payload["target"]["max_runtime_ledger_symbol_concentration_share"],
                "0.35",
            )

    def test_cli_can_write_blocked_packet_without_failing_scheduled_collection(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            import_path = tmp_path / "import.json"
            completion_path = tmp_path / "completion.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")
            import_path.write_text(
                json.dumps(
                    _runtime_import(
                        proof_status="blocked",
                        proof_blockers=["runtime_ledger_pnl_basis_missing"],
                    )
                ),
                encoding="utf-8",
            )
            completion_path.write_text(json.dumps(_completion()), encoding="utf-8")

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--runtime-window-import-file",
                    str(import_path),
                    "--completion-file",
                    str(completion_path),
                    "--output-file",
                    str(output_path),
                    "--allow-blocked-exit-zero",
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "blocked")
            self.assertFalse(payload["promotion_authority"]["allowed"])

    def test_cli_can_emit_waiting_packet_before_import_outputs_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            output_path = tmp_path / "packet.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=["alpaca_regular_session_closed"],
                    )
                ),
                encoding="utf-8",
            )

            exit_code = packet.main(
                [
                    "--status-file",
                    str(status_path),
                    "--paper-route-evidence-file",
                    str(paper_path),
                    "--output-file",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "waiting_for_runtime_window")
            self.assertEqual(
                payload["checks"]["runtime_window_import_proof"]["status"],
                "waiting_for_paper_route_runtime_window_import",
            )
            self.assertEqual(
                payload["checks"]["runtime_ledger_post_cost_profit_target"]["status"],
                "deferred_until_paper_route_runtime_window_import_is_due",
            )
            self.assertTrue(
                payload["checks"]["runtime_ledger_post_cost_profit_target"]["observed"][
                    "runtime_import_due"
                ]
                is False
            )
            self.assertEqual(
                payload["checks"]["runtime_ledger_lifecycle_counts"]["status"],
                "deferred_until_paper_route_runtime_window_import_is_due",
            )

    def test_cli_can_assemble_from_service_base_url(self) -> None:
        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        def open_url(url: str, *, timeout: float) -> _Response:
            self.assertEqual(timeout, packet.DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS)
            payloads = {
                "http://torghut.local/trading/status": _status(),
                f"http://torghut.local{packet.PAPER_ROUTE_EVIDENCE_ENDPOINT}": (
                    _paper_route_evidence()
                ),
                "http://torghut.local/trading/completion/doc29": _completion(),
            }
            return _Response(payloads[url])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            import_path = tmp_path / "import.json"
            output_path = tmp_path / "packet.json"
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")

            with patch(
                "scripts.runtime_ledger_proof_packet.io_artifacts.urlopen",
                side_effect=open_url,
            ):
                exit_code = packet.main(
                    [
                        "--service-base-url",
                        "http://torghut.local/",
                        "--runtime-window-import-file",
                        str(import_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "promotion_authority_allowed")
            self.assertEqual(
                payload["assembly"]["defaulted_urls"],
                {
                    "status_url": "http://torghut.local/trading/status",
                    "paper_route_evidence_url": (
                        f"http://torghut.local{packet.PAPER_ROUTE_EVIDENCE_ENDPOINT}"
                    ),
                    "completion_url": ("http://torghut.local/trading/completion/doc29"),
                },
            )
            self.assertEqual(payload["assembly"]["status_source"], "url")
            self.assertEqual(
                payload["assembly"]["runtime_window_import_source"],
                "file",
            )

    def test_cli_can_assemble_from_split_live_and_paper_route_services(self) -> None:
        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        def open_url(url: str, *, timeout: float) -> _Response:
            self.assertEqual(timeout, packet.DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS)
            payloads = {
                "http://torghut-live.local/trading/status": _status(),
                f"http://torghut-sim.local{packet.PAPER_ROUTE_EVIDENCE_ENDPOINT}": (
                    _paper_route_evidence()
                ),
                "http://torghut-live.local/trading/completion/doc29": _completion(),
            }
            return _Response(payloads[url])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            import_path = tmp_path / "import.json"
            output_path = tmp_path / "packet.json"
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")

            with patch(
                "scripts.runtime_ledger_proof_packet.io_artifacts.urlopen",
                side_effect=open_url,
            ):
                exit_code = packet.main(
                    [
                        "--status-service-base-url",
                        "http://torghut-live.local/",
                        "--paper-route-service-base-url",
                        "http://torghut-sim.local/",
                        "--completion-service-base-url",
                        "http://torghut-live.local/",
                        "--runtime-window-import-file",
                        str(import_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["verdict"], "promotion_authority_allowed")
            self.assertEqual(
                payload["assembly"]["service_base_urls"],
                {
                    "status": "http://torghut-live.local/",
                    "paper_route_evidence": "http://torghut-sim.local/",
                    "completion": "http://torghut-live.local/",
                },
            )
            self.assertEqual(
                payload["assembly"]["defaulted_urls"],
                {
                    "status_url": "http://torghut-live.local/trading/status",
                    "paper_route_evidence_url": (
                        f"http://torghut-sim.local{packet.PAPER_ROUTE_EVIDENCE_ENDPOINT}"
                    ),
                    "completion_url": (
                        "http://torghut-live.local/trading/completion/doc29"
                    ),
                },
            )

    def test_cli_records_degraded_paper_route_fetch_as_blocked_packet(self) -> None:
        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        def open_url(url: str, *, timeout: float) -> _Response:
            self.assertEqual(timeout, packet.DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS)
            if url == "http://torghut-live.local/trading/status":
                return _Response(_status())
            if url == f"http://torghut-sim.local{packet.PAPER_ROUTE_EVIDENCE_ENDPOINT}":
                raise HTTPError(
                    url=url,
                    code=503,
                    msg="Service Unavailable",
                    hdrs={},
                    fp=io.BytesIO(b"Service Unavailable"),
                )
            if url == "http://torghut-live.local/trading/completion/doc29":
                return _Response(_completion())
            raise AssertionError(f"unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            import_path = tmp_path / "import.json"
            output_path = tmp_path / "packet.json"
            import_path.write_text(json.dumps(_runtime_import()), encoding="utf-8")

            with patch(
                "scripts.runtime_ledger_proof_packet.io_artifacts.urlopen",
                side_effect=open_url,
            ):
                exit_code = packet.main(
                    [
                        "--status-service-base-url",
                        "http://torghut-live.local/",
                        "--paper-route-service-base-url",
                        "http://torghut-sim.local/",
                        "--completion-service-base-url",
                        "http://torghut-live.local/",
                        "--runtime-window-import-file",
                        str(import_path),
                        "--proof-mode",
                        "authority",
                        "--output-file",
                        str(output_path),
                        "--allow-blocked-exit-zero",
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["verdict"], "blocked")
            self.assertIn(
                "paper_route_evidence_fetch_failed",
                payload["evidence"]["paper_route_runtime_window_import_audit"][
                    "blockers"
                ],
            )
            self.assertIn(
                "paper_route_evidence_fetch_failed",
                payload["checks"]["paper_route_runtime_window_import_audit"][
                    "observed"
                ]["blockers"],
            )

    def test_cli_rejects_missing_duplicate_and_invalid_sources(self) -> None:
        with self.assertRaisesRegex(SystemExit, "exactly_one_status_source_required"):
            packet.main([])

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / "status.json"
            paper_path = tmp_path / "paper.json"
            status_path.write_text(json.dumps(_status()), encoding="utf-8")
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding="utf-8")

            with self.assertRaisesRegex(
                SystemExit, "--min-runtime-ledger-net-pnl must be decimal"
            ):
                packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--min-runtime-ledger-net-pnl",
                        "bad",
                    ]
                )
            with self.assertRaisesRegex(
                SystemExit, "--min-runtime-ledger-daily-net-pnl must be decimal"
            ):
                packet.main(
                    [
                        "--status-file",
                        str(status_path),
                        "--paper-route-evidence-file",
                        str(paper_path),
                        "--min-runtime-ledger-daily-net-pnl",
                        "bad",
                    ]
                )
            with self.assertRaisesRegex(
                SystemExit, "exactly_one_paper_route_evidence_source_required"
            ):
                packet._required_source_args(
                    Namespace(
                        service_base_url=None,
                        status_file=status_path,
                        status_url=None,
                        paper_route_evidence_file=paper_path,
                        paper_route_evidence_url="http://example.invalid/paper.json",
                        completion_file=None,
                        completion_url=None,
                    )
                )
