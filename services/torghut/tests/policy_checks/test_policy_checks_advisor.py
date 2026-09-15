from __future__ import annotations

from tests.policy_checks.policy_checks_support import (
    Path,
    PolicyChecksTestCaseBase,
    _candidate_state,
    _gate_report,
    _write_advisor_fallback_slo_payload,
    evaluate_promotion_prerequisites,
    json,
    tempfile,
)


class TestPolicyChecksAdvisor(PolicyChecksTestCaseBase):
    def test_promotion_prerequisites_pass_with_valid_advisor_fallback_slo_contract(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "backtest").mkdir(parents=True, exist_ok=True)
            (root / "gates").mkdir(parents=True, exist_ok=True)
            (root / "research" / "candidate-spec.json").write_text(
                "{}", encoding="utf-8"
            )
            (root / "backtest" / "evaluation-report.json").write_text(
                "{}", encoding="utf-8"
            )
            gate_report = _gate_report()
            (root / "gates" / "gate-evaluation.json").write_text(
                json.dumps(gate_report),
                encoding="utf-8",
            )
            _write_advisor_fallback_slo_payload(root)

            promotion = evaluate_promotion_prerequisites(
                policy_payload={
                    "promotion_require_patch_targets": [],
                    "promotion_require_advisor_fallback_slo": True,
                    "promotion_advisor_fallback_required_targets": ["paper"],
                    "promotion_advisor_fallback_required_artifacts": [
                        "execution/advisor-fallback-slo-report-v1.json"
                    ],
                    "promotion_advisor_fallback_max_timeout_rate": 0.005,
                    "promotion_advisor_fallback_max_state_stale_rate": 0.01,
                    "promotion_advisor_fallback_max_advice_stale_rate": 0.01,
                    "promotion_advisor_fallback_min_safe_fallback_rate": 0.99,
                    "promotion_require_deeplob_bdlob_contract": False,
                    "promotion_require_foundation_router_parity": False,
                    "promotion_require_benchmark_parity": False,
                    "promotion_require_contamination_registry": False,
                    "promotion_require_stress_evidence": False,
                    "promotion_require_hmm_state_posterior": False,
                    "promotion_require_expert_router_registry": False,
                    "promotion_require_janus_evidence": False,
                    "promotion_require_profitability_stage_manifest": False,
                    "gate6_require_profitability_evidence": False,
                    "gate6_require_janus_evidence": False,
                },
                gate_report_payload=gate_report,
                candidate_state_payload=_candidate_state(),
                promotion_target="paper",
                artifact_root=root,
            )

        self.assertTrue(promotion.allowed)
        self.assertFalse(
            any(
                reason.startswith("advisor_fallback_slo_")
                for reason in promotion.reasons
            )
        )
