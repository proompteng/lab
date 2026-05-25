from __future__ import annotations

import json
import tempfile
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from scripts import assemble_runtime_ledger_proof_packet as packet


def _status(*, blockers: list[str] | None = None) -> dict[str, object]:
    return {
        "mode": "paper",
        "running": True,
        "live_submission_gate": {
            "allowed": not blockers,
            "reason": "allowed" if not blockers else blockers[0],
            "blocked_reasons": blockers or [],
        },
        "proof_floor": {
            "blocking_reasons": [],
        },
    }


def _paper_route_evidence(
    *,
    import_ready: bool = True,
    import_blockers: list[str] | None = None,
) -> dict[str, object]:
    blockers = import_blockers if import_blockers is not None else []
    return {
        "schema_version": "torghut.paper-route-evidence.v1",
        "next_paper_route_runtime_window_targets": {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "target_count": 1,
            "session_window": {
                "start": "2026-05-26T13:30:00+00:00",
                "end": "2026-05-26T20:00:00+00:00",
            },
            "session_readiness": {
                "import_ready": import_ready,
                "import_blockers": blockers,
            },
            "runtime_window_import_handoff": {
                "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
                "import_ready": import_ready,
                "import_blockers": blockers,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
            },
            "targets": [
                {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "hypothesis_id": "H-PAIRS-01",
                    "observed_stage": "paper",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-pairs-vwap-cap-safe",
                    "account_label": "TORGHUT_SIM",
                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                    "window_start": "2026-05-26T13:30:00+00:00",
                    "window_end": "2026-05-26T20:00:00+00:00",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                }
            ],
        },
    }


def _runtime_import(
    *,
    proof_status: str = "ok",
    proof_blockers: list[str] | None = None,
    authoritative: bool = True,
) -> dict[str, object]:
    blocker_payloads = [{"blocker": blocker} for blocker in proof_blockers or []]
    return {
        "status": "ok",
        "proof_status": proof_status,
        "proof_blockers": blocker_payloads,
        "target_count": 1,
        "imports": [
            {
                "status": "ok",
                "proof_status": proof_status,
                "proof_blockers": blocker_payloads,
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": {
                    "promotion_allowed": authoritative,
                    "runtime_observation": {
                        "authoritative": authoritative,
                        "authority_reason": "runtime_ledger_profit_proof_present"
                        if authoritative
                        else "runtime_without_runtime_ledger_profit_proof",
                    },
                },
            }
        ],
    }


def _completion(
    *,
    status: str = "satisfied",
    net_pnl: str = "650",
    trading_days: int = 1,
    expectancy_bps: str = "13",
    ledger_refs: list[str] | None = None,
    unbacked_refs: list[str] | None = None,
) -> dict[str, object]:
    return {
        "doc_id": "doc29",
        "summary": {"all_satisfied": status == "satisfied"},
        "gates": [
            {
                "gate_id": packet.DOC29_LIVE_SCALE_GATE,
                "status": status,
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_ledger_summary": {
                    "runtime_ledger_bucket_count": 1,
                    "runtime_ledger_fill_count": 4,
                    "runtime_ledger_closed_trade_count": 2,
                    "runtime_ledger_filled_notional": "50000",
                    "runtime_ledger_net_strategy_pnl_after_costs": net_pnl,
                    "runtime_ledger_post_cost_expectancy_bps": expectancy_bps,
                    "runtime_ledger_observed_trading_day_count": trading_days,
                },
                "db_row_refs": {
                    "strategy_runtime_ledger_buckets": ledger_refs
                    if ledger_refs is not None
                    else ["strategy-runtime-ledger-buckets:H-PAIRS-01:2026-05-26"],
                    "runtime_ledger_unbacked_hypothesis_metric_windows": unbacked_refs
                    if unbacked_refs is not None
                    else [],
                },
            }
        ],
    }


class TestRuntimeLedgerProofPacket(TestCase):
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

    def test_packet_allows_only_complete_post_cost_runtime_ledger_proof(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
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
        self.assertEqual(result["candidate"]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            result["checks"]["runtime_ledger_post_cost_profit_target"]["observed"][
                "daily_net_pnl_after_costs"
            ],
            "650",
        )

    def test_packet_waits_before_paper_route_window_is_importable(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=["paper_route_session_window_not_open"],
            ),
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_proof"]["observed"][
                "runtime_import_due"
            ]
        )

    def test_packet_blocks_non_authoritative_import_and_weak_daily_profit(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(
                proof_status="blocked",
                proof_blockers=["runtime_without_runtime_ledger_profit_proof"],
                authoritative=False,
            ),
            completion_status=_completion(net_pnl="600", trading_days=3),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_without_runtime_ledger_profit_proof",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_daily_net_pnl_below_target",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_incomplete_identity_unbacked_refs_and_lifecycle_gaps(
        self,
    ) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["candidate_id"] = ""
        completion = _completion(
            status="blocked",
            net_pnl="bad",
            trading_days=0,
            expectancy_bps="0",
            ledger_refs=[],
            unbacked_refs=["hypothesis_metric_windows:H-PAIRS-01:2026-05-26"],
        )
        gate = completion["gates"][0]
        assert isinstance(gate, dict)
        gate["blocking_reasons"] = ["live_scale_runtime_ledger_summary_incomplete"]
        gate["blocked_reason"] = "live_canary_not_satisfied"
        summary = gate["runtime_ledger_summary"]
        assert isinstance(summary, dict)
        summary["runtime_ledger_bucket_count"] = 0
        summary["runtime_ledger_fill_count"] = 0
        summary["runtime_ledger_closed_trade_count"] = 0
        summary["runtime_ledger_filled_notional"] = "0"

        result = packet.build_runtime_ledger_proof_packet(
            _status(blockers=["simple_submit_disabled"]),
            paper_route_evidence=paper,
            runtime_window_import={"runtime_window_import": _runtime_import()},
            completion_status=completion,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        blockers = result["promotion_authority"]["blocking_reasons"]
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn("simple_submit_disabled", blockers)
        self.assertIn("paper_route_target_identity_incomplete", blockers)
        self.assertIn("live_scale_runtime_ledger_summary_incomplete", blockers)
        self.assertIn("live_canary_not_satisfied", blockers)
        self.assertIn("runtime_ledger_db_refs_missing_or_unbacked", blockers)
        self.assertIn("runtime_ledger_bucket_count_zero", blockers)
        self.assertIn("runtime_ledger_fill_count_zero", blockers)
        self.assertIn("runtime_ledger_closed_trade_count_zero", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_post_cost_expectancy_not_positive", blockers)
        self.assertIn("runtime_ledger_net_pnl_below_target", blockers)
        self.assertIn("runtime_ledger_trading_days_below_target", blockers)
        self.assertIn("runtime_ledger_daily_net_pnl_below_target", blockers)
        self.assertIn(
            "keep_promotion_blocked_until_live_gate_and_proof_floor_pass",
            result["required_actions"],
        )
        self.assertIn(
            "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence",
            result["required_actions"],
        )
        self.assertIn(
            "collect_or_improve_post_cost_runtime_profit_evidence",
            result["required_actions"],
        )

    def test_packet_waits_on_target_level_settlement_blocker(self) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["paper_route_session_import_blockers"] = [
            "paper_route_session_settlement_pending"
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=paper,
            generated_at="2026-05-26T20:01:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_settlement_pending"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_paper_route_settlement_grace"],
        )

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
            paper_route_evidence=paper,
            runtime_window_import={
                "status": "ok",
                "proof_status": "ok",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "summary": {
                    "runtime_observation": {
                        "authoritative": True,
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
                        import_blockers=["paper_route_session_window_not_open"],
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
            self.assertEqual(timeout, 10.0)
            payloads = {
                "http://torghut.local/trading/status": _status(),
                "http://torghut.local/trading/paper-route-evidence": (
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

            with patch.object(packet, "urlopen", side_effect=open_url):
                exit_code = packet.main(
                    [
                        "--service-base-url",
                        "http://torghut.local/",
                        "--runtime-window-import-file",
                        str(import_path),
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
                        "http://torghut.local/trading/paper-route-evidence"
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
            self.assertEqual(timeout, 10.0)
            payloads = {
                "http://torghut-live.local/trading/status": _status(),
                "http://torghut-sim.local/trading/paper-route-evidence": (
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

            with patch.object(packet, "urlopen", side_effect=open_url):
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
                        "http://torghut-sim.local/trading/paper-route-evidence"
                    ),
                    "completion_url": (
                        "http://torghut-live.local/trading/completion/doc29"
                    ),
                },
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

    def test_json_loaders_require_objects_and_support_urls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            bad_path = Path(tmp_dir) / "bad.json"
            bad_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_object(bad_path)

        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        with patch.object(packet, "urlopen", return_value=_Response({"ok": True})):
            self.assertEqual(
                packet._load_json_url(
                    "http://example.invalid/status.json", timeout_seconds=1
                ),
                {"ok": True},
            )
        with patch.object(packet, "urlopen", return_value=_Response(["bad"])):
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_url(
                    "http://example.invalid/status.json",
                    timeout_seconds=1,
                )
