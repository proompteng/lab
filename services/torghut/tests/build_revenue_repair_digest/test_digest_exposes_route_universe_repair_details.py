from __future__ import annotations

from tests.build_revenue_repair_digest.support import (
    NOW,
    Path,
    StringIO,
    _TestBuildRevenueRepairDigestBase,
    _bool,
    _build_repair_queue,
    _business_state,
    _collect_blocking_reasons,
    _int,
    _load_json_object,
    _parse_generated_at,
    _ready_status,
    _ready_trading_status,
    _repair_only_readyz,
    _repair_only_status,
    _sequence,
    build_revenue_repair_digest,
    json,
    main,
    redirect_stdout,
    tempfile,
    timezone,
)


class TestDigestExposesRouteUniverseRepairDetails(_TestBuildRevenueRepairDigestBase):
    def test_digest_exposes_route_universe_repair_details(self) -> None:
        status = _repair_only_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["blocking_reasons"] = [
            "alpha_readiness_not_promotion_eligible",
            "execution_tca_route_universe_empty",
            "simple_submit_disabled",
        ]
        proof_floor["repair_ladder"] = [
            {
                "code": "repair_route_universe",
                "reason": "execution_tca_route_universe_empty",
                "priority": 78,
                "expected_unblock_value": 4,
            }
        ]
        execution_tca_dimension = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") == "execution_tca"
        ][0]
        source_ref = execution_tca_dimension["source_ref"]
        self.assertIsInstance(source_ref, dict)
        execution_tca_dimension["state"] = "fail"
        execution_tca_dimension["reason"] = "execution_tca_route_universe_empty"
        source_ref["slippage_guardrail_bps"] = "8"
        source_ref["aggregate_reason"] = "execution_tca_slippage_guardrail_exceeded"
        source_ref["symbol_routes"] = {
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "slippage_guardrail_bps": "8",
            "routeable_symbol_count": 0,
            "blocked_symbol_count": 2,
            "missing_symbol_count": 1,
            "routeable_symbols": [],
            "blocked_symbols": [
                {"symbol": "AAPL", "order_count": 2033},
                {"symbol": "NVDA", "order_count": 3289},
            ],
            "missing_symbols": ["ORCL"],
        }

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status,
            generated_at=NOW,
        )

        blockers = {
            str(item["reason"]) for item in digest["blockers"] if isinstance(item, dict)
        }
        self.assertIn("execution_tca_route_universe_empty", blockers)
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        execution_tca = evidence["execution_tca"]
        self.assertIsInstance(execution_tca, dict)
        self.assertEqual(
            execution_tca["reason"],
            "execution_tca_route_universe_empty",
        )
        self.assertEqual(
            execution_tca["aggregate_reason"],
            "execution_tca_slippage_guardrail_exceeded",
        )
        symbol_routes = execution_tca["symbol_routes"]
        self.assertIsInstance(symbol_routes, dict)
        self.assertEqual(symbol_routes["routeable_symbol_count"], 0)
        self.assertEqual(symbol_routes["missing_symbols"], ["ORCL"])
        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_route_universe")
        self.assertEqual(
            repair_queue[0]["action"],
            "produce_executable_route_universe_before_capital",
        )

    def test_digest_does_not_prioritize_pass_state_route_exclusions(self) -> None:
        status = _repair_only_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["blocking_reasons"] = [
            "alpha_readiness_not_promotion_eligible",
            "simple_submit_disabled",
        ]
        proof_floor["repair_ladder"] = [
            {
                "code": "repair_route_universe",
                "reason": "execution_tca_route_universe_exclusions_applied",
                "action": "exclude_missing_or_high_slippage_symbols_before_promotion",
                "priority": 78,
                "expected_unblock_value": 7,
            },
            {
                "code": "repair_alpha_readiness",
                "reason": "alpha_readiness_not_promotion_eligible",
                "priority": 70,
                "expected_unblock_value": 3,
            },
        ]
        execution_tca_dimension = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") == "execution_tca"
        ][0]
        execution_tca_dimension["state"] = "pass"
        execution_tca_dimension["reason"] = (
            "execution_tca_route_universe_exclusions_applied"
        )

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status,
            generated_at=NOW,
        )

        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_alpha_readiness")
        self.assertNotIn(
            "execution_tca_route_universe_exclusions_applied",
            {str(item["reason"]) for item in repair_queue if isinstance(item, dict)},
        )

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
            self.assertTrue(payload["revenue_ready"])
            self.assertEqual(payload["business_state"], "revenue_candidate")
            self.assertEqual(payload["repair_queue"], [])

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
