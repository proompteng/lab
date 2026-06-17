from __future__ import annotations

from tests.hypotheses.support import (
    _FakeHttpResponse,
    _TestHypothesisReadinessBase,
    load_jangar_dependency_quorum,
    patch,
    settings,
)


class TestLoadJangarDependencyQuorumPrefersDependencyQuorumContract(
    _TestHypothesisReadinessBase
):
    def test_load_jangar_dependency_quorum_prefers_dependency_quorum_contract(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    },
                    "stage_trust": {
                        "stages": [
                            {
                                "stage": "implement",
                                "state": "renewing",
                                "reason_codes": ["agentrun_active"],
                            }
                        ]
                    },
                    "stage_renewal_bonds": [
                        {
                            "bond_id": "bond-implement-1",
                            "stage": "implement",
                            "state": "renewing",
                        }
                    ],
                    "controller_ingestion_settlement": {
                        "decision": "current",
                        "settlement_id": "ingest-1",
                    },
                    "generated_at": "2026-05-07T12:00:00Z",
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])
        self.assertEqual(status.message, "degraded")
        self.assertEqual(
            status.stage_trust["stages"],
            [
                {
                    "stage": "implement",
                    "state": "renewing",
                    "reason_codes": ["agentrun_active"],
                }
            ],
        )
        self.assertEqual(status.stage_renewal_bonds[0]["bond_id"], "bond-implement-1")
        self.assertEqual(status.controller_ingestion_settlement["decision"], "current")
        self.assertEqual(status.as_payload()["generated_at"], "2026-05-07T12:00:00Z")

    def test_load_jangar_dependency_quorum_preserves_verify_foreclosure_board(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
            "execution_trust_status": "degraded",
            "source_rollout_truth_state": "converged",
            "foreclosure_tickets": [
                {
                    "ticket_id": "verify-trust-foreclosure-ticket:test",
                    "state": "open",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                }
            ],
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "generated_at": "2026-05-14T16:10:00Z",
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ok",
                    },
                    "verify_trust_foreclosure_board": board,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "allow")
        self.assertEqual(status.message, "ok")
        payload = status.as_payload()
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_load_jangar_dependency_quorum_preserves_repair_slot_carry(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        repair_slot_escrow = {
            "schema_version": "jangar.repair-slot-escrow.v1",
            "escrow_id": "repair-slot-escrow:test",
            "status": "block",
            "reason_codes": ["selected_receipt_source_revenue_repair_ref_mismatch"],
        }
        rollout_witness = {
            "schema_version": "jangar.foreclosure-carry-rollout-witness.v1",
            "witness_id": "foreclosure-carry-rollout-witness:test",
            "fresh_until": "2026-05-14T16:30:00Z",
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "generated_at": "2026-05-14T16:10:00Z",
                    "dependency_quorum": {
                        "decision": "block",
                        "reasons": ["empirical_jobs_degraded"],
                        "message": "blocked",
                    },
                    "repair_slot_escrow": repair_slot_escrow,
                    "foreclosure_carry_rollout_witness": rollout_witness,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        payload = status.as_payload()
        self.assertEqual(status.decision, "block")
        self.assertEqual(payload["repair_slot_escrow"], repair_slot_escrow)
        self.assertEqual(
            payload["foreclosure_carry_rollout_witness"],
            rollout_witness,
        )

    def test_load_jangar_dependency_quorum_can_omit_torghut_consumer_evidence(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ok",
                    }
                }
            ),
        ) as urlopen_mock:
            status = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )

        self.assertEqual(status.decision, "allow")
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(
            request.get_header("X-torghut-consumer-evidence-mode"),
            "omit",
        )

    def test_load_jangar_dependency_quorum_caches_by_consumer_evidence_mode(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 30
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    }
                }
            ),
        ) as urlopen_mock:
            first = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )
            second = load_jangar_dependency_quorum(
                omit_torghut_consumer_evidence=True,
            )

        self.assertEqual(first.decision, "delay")
        self.assertIs(first, second)
        urlopen_mock.assert_called_once()

    def test_load_jangar_dependency_quorum_falls_back_to_legacy_status_when_needed(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "workflows": {
                        "data_confidence": "unknown",
                        "backoff_limit_exceeded_jobs": 0,
                    }
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "block")
        self.assertEqual(status.reasons, ["workflows_data_unknown"])

    def test_load_jangar_dependency_quorum_preserves_ready_controller_ingestion_settlement(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/ready"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settlement = {
            "schema_version": "jangar.controller-ingestion-settlement.v1",
            "settlement_id": "controller-ingestion-settlement:ready-test",
            "decision": "hold",
            "agentrun_ingestion_current": False,
            "reason_codes": ["source_serving_hold"],
        }
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:ready-test",
        }
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "status": "ok",
                    "controller_ingestion_settlement": settlement,
                    "verify_trust_foreclosure_board": board,
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "unknown")
        self.assertEqual(status.reasons, ["jangar_dependency_quorum_missing"])
        payload = status.as_payload()
        self.assertEqual(payload["controller_ingestion_settlement"], settlement)
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_load_jangar_dependency_quorum_handles_malformed_url(self) -> None:
        settings.trading_jangar_control_plane_status_url = "jangar.example/status"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "unknown")
        self.assertEqual(status.reasons, ["jangar_status_fetch_failed"])
        self.assertIn("fetch failed", status.message)
