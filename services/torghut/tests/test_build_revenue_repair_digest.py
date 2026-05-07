from __future__ import annotations

import json
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest import TestCase

from scripts.build_revenue_repair_digest import (
    SCHEMA_VERSION,
    _bool,
    _build_repair_queue,
    _business_state,
    _collect_blocking_reasons,
    _int,
    _load_json_object,
    _parse_generated_at,
    _sequence,
    build_revenue_repair_digest,
    main,
)


NOW = datetime(2026, 5, 7, 16, 0, tzinfo=timezone.utc)


def _repair_only_readyz() -> dict[str, object]:
    return {
        "status": "degraded",
        "dependencies": {
            "live_submission_gate": {
                "ok": False,
                "detail": "simple_submit_disabled",
                "capital_stage": "shadow",
            },
            "profitability_proof_floor": {
                "ok": False,
                "detail": "repair_only",
                "capital_state": "zero_notional",
                "required": True,
            },
            "quant_evidence": {
                "ok": False,
                "detail": "quant_pipeline_degraded",
                "required": True,
            },
        },
    }


def _repair_only_status() -> dict[str, object]:
    return {
        "mode": "live",
        "pipeline_mode": "simple",
        "build": {
            "commit": "315dde4b8581598309238c2989b95451a167c110",
            "active_revision": "torghut-00252",
        },
        "live_submission_gate": {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "configured_live_promotion": False,
        },
        "proof_floor": {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "floor_state": "fail",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_stale",
                "quant_pipeline_degraded",
                "simple_submit_disabled",
            ],
            "repair_ladder": [
                {},
                {
                    "code": "live_submit_gate_closed",
                    "dimension": "live_submission_gate",
                    "action": "keep_submit_disabled_until_proof_floor_passes",
                    "reason": "simple_submit_disabled",
                    "priority": 80,
                    "expected_unblock_value": 1,
                },
                {
                    "code": "repair_alpha_readiness",
                    "dimension": "alpha_readiness",
                    "action": "clear_hypothesis_blockers_before_capital",
                    "reason": "alpha_readiness_not_promotion_eligible",
                    "priority": 70,
                    "expected_unblock_value": 3,
                },
                {
                    "code": "repair_execution_tca",
                    "dimension": "execution_tca",
                    "action": "refresh_execution_tca_settlement",
                    "reason": "execution_tca_stale",
                    "priority": 65,
                    "expected_unblock_value": 3,
                },
                {
                    "code": "repair_quant_ingestion",
                    "dimension": "quant_ingestion",
                    "action": "settle_quant_pipeline_stage_lag",
                    "reason": "quant_pipeline_degraded",
                    "priority": 60,
                    "expected_unblock_value": 1,
                },
            ],
            "proof_dimensions": [
                {
                    "dimension": "market_context",
                    "state": "pass",
                    "reason": "fresh",
                    "source_ref": {},
                },
                {
                    "dimension": "alpha_readiness",
                    "state": "fail",
                    "reason": "alpha_readiness_not_promotion_eligible",
                    "source_ref": {
                        "promotion_eligible_total": 0,
                        "rollback_required_total": 3,
                        "state_totals": {"blocked": 1, "shadow": 2},
                    },
                },
                {
                    "dimension": "execution_tca",
                    "state": "stale",
                    "reason": "execution_tca_stale",
                    "freshness_seconds": 2990000,
                    "threshold_seconds": 604800,
                    "source_ref": {
                        "order_count": 13775,
                        "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
                        "avg_abs_slippage_bps": "568.6138848199565249",
                    },
                },
            ],
        },
        "quant_evidence": {
            "ok": False,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
            "max_stage_lag_seconds": 56287,
            "blocking_reasons": ["quant_pipeline_degraded"],
        },
        "simple_lane_reject_reason_totals": {
            "insufficient_buying_power": 8,
        },
    }


def _ready_status() -> dict[str, object]:
    return {
        "status": "ok",
        "dependencies": {
            "live_submission_gate": {"ok": True, "detail": "ready"},
            "profitability_proof_floor": {
                "ok": True,
                "detail": "candidate",
                "capital_state": "micro_canary",
                "required": True,
            },
            "quant_evidence": {"ok": True, "detail": "ready", "required": True},
        },
    }


def _ready_trading_status() -> dict[str, object]:
    return {
        "mode": "live",
        "pipeline_mode": "simple",
        "build": {"commit": "commit-1", "active_revision": "torghut-00253"},
        "live_submission_gate": {
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
            "configured_live_promotion": True,
        },
        "proof_floor": {
            "floor_state": "pass",
            "route_state": "candidate",
            "capital_state": "micro_canary",
            "max_notional": "25",
            "blocking_reasons": [],
            "repair_ladder": [],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "reason": "promotion_eligible",
                    "source_ref": {
                        "promotion_eligible_total": 2,
                        "rollback_required_total": 0,
                        "state_totals": {"candidate": 2},
                    },
                },
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "fresh",
                    "source_ref": {
                        "order_count": 42,
                        "last_computed_at": "2026-05-07T15:45:00+00:00",
                        "avg_abs_slippage_bps": "4.2",
                    },
                },
            ],
        },
        "quant_evidence": {"ok": True, "status": "healthy", "reason": "ready"},
    }


class TestBuildRevenueRepairDigest(TestCase):
    def test_repair_only_payload_prioritizes_evidence_before_live_submit(self) -> None:
        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=_repair_only_status(),
            generated_at=NOW,
        )

        self.assertEqual(digest["schema_version"], SCHEMA_VERSION)
        self.assertFalse(digest["revenue_ready"])
        self.assertEqual(digest["business_state"], "repair_only")
        capital = digest["capital"]
        self.assertIsInstance(capital, dict)
        self.assertEqual(capital["capital_state"], "zero_notional")
        self.assertEqual(capital["max_notional"], "0")
        blockers = {
            str(item["reason"]) for item in digest["blockers"] if isinstance(item, dict)
        }
        self.assertGreaterEqual(
            blockers,
            {
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_stale",
                "quant_pipeline_degraded",
                "simple_submit_disabled",
            },
        )
        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_alpha_readiness")
        self.assertEqual(repair_queue[1]["code"], "repair_execution_tca")
        self.assertNotIn("repair_repair_only", [item["code"] for item in repair_queue])
        self.assertIn(
            "keep_submit_disabled",
            str(
                [
                    item
                    for item in repair_queue
                    if item["code"] == "live_submit_gate_closed"
                ][0]["action"]
            ),
        )

    def test_all_clear_payload_is_revenue_candidate(self) -> None:
        digest = build_revenue_repair_digest(
            readyz_payload=_ready_status(),
            status_payload=_ready_trading_status(),
            generated_at=NOW,
        )

        self.assertTrue(digest["revenue_ready"])
        self.assertEqual(digest["business_state"], "revenue_candidate")
        self.assertEqual(digest["repair_queue"], [])
        self.assertEqual(
            digest["operating_rule"], "eligible_for_guarded_revenue_verification"
        )

    def test_digest_defaults_generated_at_and_handles_missing_tca_dimension(
        self,
    ) -> None:
        status = _ready_trading_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["proof_dimensions"] = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") != "execution_tca"
        ]

        digest = build_revenue_repair_digest(
            readyz_payload=_ready_status(),
            status_payload=status,
        )

        self.assertTrue(str(digest["generated_at"]).endswith("+00:00"))
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        execution_tca = evidence["execution_tca"]
        self.assertIsInstance(execution_tca, dict)
        self.assertEqual(execution_tca["reason"], "missing")

    def test_status_degraded_quant_reason_becomes_blocker_when_ok_flag_is_true(
        self,
    ) -> None:
        readyz = _ready_status()
        status = _ready_trading_status()
        status["quant_evidence"] = {
            "ok": True,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
        }

        reasons = _collect_blocking_reasons(readyz, status)

        self.assertIn("quant_pipeline_degraded", reasons)

    def test_scalar_helpers_cover_string_and_numeric_variants(self) -> None:
        self.assertEqual(_sequence(("a", "b")), ["a", "b"])
        self.assertEqual(_sequence("not-a-list"), [])
        self.assertTrue(_bool("allow"))
        self.assertFalse(_bool("blocked", default=True))
        self.assertTrue(_bool("not-recognized", default=True))
        self.assertEqual(_int(True), 1)
        self.assertEqual(_int(3.8), 3)
        self.assertEqual(_int("7.0"), 7)
        self.assertEqual(_int("not-a-number", default=9), 9)

    def test_repair_queue_derives_unknown_blocker_and_skips_empty_reasons(self) -> None:
        repair_queue = _build_repair_queue(
            {"route_state": "candidate", "repair_ladder": []},
            {"simple_lane_reject_reason_totals": {"insufficient_buying_power": 4}},
            ["", "insufficient_buying_power", "custom_blocker"],
        )

        repair_codes = [item["code"] for item in repair_queue]
        self.assertIn("repair_buying_power", repair_codes)
        self.assertIn("repair_custom_blocker", repair_codes)

    def test_business_state_distinguishes_capital_blocked_and_not_ready(self) -> None:
        self.assertEqual(
            _business_state(
                revenue_ready=False,
                proof_floor={"route_state": "candidate", "capital_state": "micro"},
                live_submission_gate={"allowed": False},
            ),
            "capital_blocked",
        )
        self.assertEqual(
            _business_state(
                revenue_ready=False,
                proof_floor={"route_state": "candidate", "capital_state": "micro"},
                live_submission_gate={"allowed": True},
            ),
            "not_revenue_ready",
        )

    def test_load_json_object_rejects_malformed_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "payload.json"
            path.write_text("{", encoding="utf-8")

            with self.assertRaises(ValueError):
                _load_json_object(path, field_name="status")

    def test_parse_generated_at_handles_empty_z_suffix_and_naive_values(self) -> None:
        self.assertIsNone(_parse_generated_at(None))
        self.assertIsNone(_parse_generated_at(" "))
        parsed = _parse_generated_at("2026-05-07T16:00:00Z")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.tzinfo, timezone.utc)
        with self.assertRaises(ValueError):
            _parse_generated_at("2026-05-07T16:00:00")

    def test_cli_prints_digest_to_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            readyz_path.write_text(json.dumps(_ready_status()), encoding="utf-8")
            status_path.write_text(
                json.dumps(_ready_trading_status()), encoding="utf-8"
            )
            stdout = StringIO()

            with redirect_stdout(stdout):
                exit_code = main(
                    [
                        "--readyz-json",
                        str(readyz_path),
                        "--status-json",
                        str(status_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["business_state"], "revenue_candidate")

    def test_cli_writes_digest_to_output_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            output_path = tmp / "digest.json"
            readyz_path.write_text(json.dumps(_repair_only_readyz()), encoding="utf-8")
            status_path.write_text(json.dumps(_repair_only_status()), encoding="utf-8")

            exit_code = main(
                [
                    "--readyz-json",
                    str(readyz_path),
                    "--status-json",
                    str(status_path),
                    "--generated-at",
                    NOW.isoformat(),
                    "--output",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], SCHEMA_VERSION)
            self.assertEqual(payload["business_state"], "repair_only")

    def test_cli_rejects_non_object_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            readyz_path.write_text("[]", encoding="utf-8")
            status_path.write_text(json.dumps(_repair_only_status()), encoding="utf-8")

            exit_code = main(
                [
                    "--readyz-json",
                    str(readyz_path),
                    "--status-json",
                    str(status_path),
                ]
            )

            self.assertEqual(exit_code, 2)
