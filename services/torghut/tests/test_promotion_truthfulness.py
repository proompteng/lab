from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.policy_checks import evaluate_promotion_prerequisites
from app.trading.evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)


class TestPromotionTruthfulness(TestCase):
    def test_promotion_prerequisites_fail_closed_on_deterministic_evidence_without_policy_toggle(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'promotion_evidence': {
                        'janus_q': {
                            'artifact_ref': 'research/janus-q-evidence.json',
                            'artifact_authority': evidence_contract_payload(
                                provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
                                maturity=EvidenceMaturity.STUB,
                                authoritative=False,
                                placeholder=True,
                            ),
                        }
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn(
            'promotion_evidence_deterministic_authority_blocked',
            result.reasons,
        )

    def test_promotion_prerequisites_fail_on_non_authoritative_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={
                    'promotion_require_truthful_evidence_contracts': True,
                },
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'coverage_error': 0.01,
                    'uncertainty_gate_action': 'pass',
                    'promotion_evidence': {
                        'benchmark_parity': {
                            'artifact_ref': 'benchmarks/benchmark-parity-report-v1.json',
                            'artifact_authority': evidence_contract_payload(
                                provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
                                maturity=EvidenceMaturity.STUB,
                                authoritative=False,
                                placeholder=True,
                            ),
                        }
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn('promotion_evidence_non_authoritative', result.reasons)
        self.assertIn('promotion_evidence_authoritative_flag_false', result.reasons)

    def test_promotion_prerequisites_fail_when_simulation_calibration_is_uncalibrated(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            report_path = artifact_root / 'gates' / 'simulation-calibration-report-v1.json'
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                json.dumps(
                    {
                        'schema_version': 'simulation-calibration-report-v1',
                        'run_id': 'run-1',
                        'candidate_id': 'cand-1',
                        'status': 'uncalibrated',
                        'order_count': 0,
                        'expected_shortfall_sample_count': 0,
                        'expected_shortfall_coverage': '0',
                        'avg_calibration_error_bps': '30',
                        'confidence_gate_action': 'abstain',
                        'artifact_authority': evidence_contract_payload(
                            provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                            maturity=EvidenceMaturity.UNCALIBRATED,
                            calibration_summary={'status': 'uncalibrated'},
                        ),
                    }
                ),
                encoding='utf-8',
            )
            result = evaluate_promotion_prerequisites(
                policy_payload={
                    'promotion_required_artifacts': [],
                    'promotion_require_patch_targets': [],
                    'gate6_require_profitability_evidence': False,
                    'promotion_require_janus_evidence': False,
                    'gate6_require_janus_evidence': False,
                    'promotion_require_simulation_calibration': True,
                    'promotion_simulation_calibration_required_artifacts': [
                        'gates/simulation-calibration-report-v1.json'
                    ],
                },
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'promotion_evidence': {
                        'simulation_calibration': {
                            'artifact_ref': 'gates/simulation-calibration-report-v1.json',
                            'artifact_authority': evidence_contract_payload(
                                provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                                maturity=EvidenceMaturity.UNCALIBRATED,
                                calibration_summary={'status': 'uncalibrated'},
                            ),
                        }
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn('simulation_calibration_status_not_calibrated', result.reasons)
        self.assertIn(
            'simulation_calibration_order_count_below_minimum',
            result.reasons,
        )

    def test_promotion_prerequisites_fail_when_shadow_live_deviation_exceeds_budget(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            report_path = artifact_root / 'gates' / 'shadow-live-deviation-report-v1.json'
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                json.dumps(
                    {
                        'schema_version': 'shadow-live-deviation-report-v1',
                        'run_id': 'run-1',
                        'candidate_id': 'cand-1',
                        'status': 'out_of_budget',
                        'order_count': 5,
                        'avg_abs_slippage_bps': '35',
                        'avg_abs_divergence_bps': '22',
                        'artifact_authority': evidence_contract_payload(
                            provenance=ArtifactProvenance.PAPER_RUNTIME_OBSERVED,
                            maturity=EvidenceMaturity.UNCALIBRATED,
                            deviation_summary={'status': 'out_of_budget'},
                        ),
                    }
                ),
                encoding='utf-8',
            )
            result = evaluate_promotion_prerequisites(
                policy_payload={
                    'promotion_required_artifacts': [],
                    'promotion_require_patch_targets': [],
                    'gate6_require_profitability_evidence': False,
                    'promotion_require_janus_evidence': False,
                    'gate6_require_janus_evidence': False,
                    'promotion_require_shadow_live_deviation': True,
                    'promotion_shadow_live_deviation_required_artifacts': [
                        'gates/shadow-live-deviation-report-v1.json'
                    ],
                    'promotion_shadow_live_deviation_max_avg_abs_slippage_bps': '20',
                    'promotion_shadow_live_deviation_max_avg_abs_divergence_bps': '15',
                },
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'promotion_evidence': {
                        'shadow_live_deviation': {
                            'artifact_ref': 'gates/shadow-live-deviation-report-v1.json',
                            'artifact_authority': evidence_contract_payload(
                                provenance=ArtifactProvenance.PAPER_RUNTIME_OBSERVED,
                                maturity=EvidenceMaturity.UNCALIBRATED,
                                deviation_summary={'status': 'out_of_budget'},
                            ),
                        }
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn(
            'shadow_live_deviation_status_not_within_budget',
            result.reasons,
        )
        self.assertIn(
            'shadow_live_deviation_avg_abs_slippage_bps_exceeds_threshold',
            result.reasons,
        )

    def test_promotion_prerequisites_fail_when_multi_strategy_portfolio_is_not_fully_compiled(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'vnext': {
                        'portfolio_promotion': {
                            'strategy_count': 2,
                            'spec_compiled_count': 1,
                            'missing_policy_refs': [
                                'legacy-a:promotion_policy_ref',
                            ],
                        }
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn(
            'portfolio_promotion_strategy_compilation_incomplete',
            result.reasons,
        )
        self.assertIn('portfolio_promotion_policy_refs_missing', result.reasons)

    def test_promotion_prerequisites_fail_when_dependency_quorum_is_not_allow(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={
                    'promotion_required_artifacts': [],
                    'promotion_require_patch_targets': [],
                    'gate6_require_profitability_evidence': False,
                    'promotion_require_janus_evidence': False,
                    'gate6_require_janus_evidence': False,
                    'promotion_require_jangar_dependency_quorum': True,
                    'promotion_jangar_dependency_quorum_required_targets': [
                        'paper',
                        'live',
                    ],
                },
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                },
                candidate_state_payload={
                    'dependencyQuorum': {
                        'decision': 'delay',
                        'reasons': ['workflow_backoff_warning'],
                        'message': 'Delay capital promotion until workflows recover.',
                    }
                },
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn('jangar_dependency_quorum_delay', result.reasons)

    def test_promotion_prerequisites_fail_when_alpha_readiness_contract_is_unmapped(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={
                    'promotion_required_artifacts': [],
                    'promotion_require_patch_targets': [],
                    'gate6_require_profitability_evidence': False,
                    'promotion_require_janus_evidence': False,
                    'gate6_require_janus_evidence': False,
                    'promotion_require_alpha_readiness_contract': True,
                    'promotion_alpha_readiness_required_targets': [
                        'paper',
                        'live',
                    ],
                },
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                },
                candidate_state_payload={
                    'alphaReadiness': {
                        'mode': 'candidate_alignment_v1',
                        'registry_loaded': True,
                        'registry_errors': [],
                        'strategy_families': ['legacy_macd_rsi'],
                        'matched_hypothesis_ids': [],
                        'missing_strategy_families': ['legacy_macd_rsi'],
                        'promotion_eligible': False,
                        'reasons': ['strategy_family_hypothesis_unmapped'],
                        'dependency_quorum': {
                            'decision': 'allow',
                            'reasons': [],
                            'message': 'ok',
                        },
                    }
                },
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn('alpha_readiness_strategy_family_unmapped', result.reasons)
        self.assertIn('alpha_readiness_not_promotion_eligible', result.reasons)

    def test_promotion_prerequisites_fail_when_alpha_readiness_or_dependency_quorum_block(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir)
            result = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload={
                    'promotion_allowed': True,
                    'recommended_mode': 'paper',
                    'alpha_readiness': {
                        'promotion_eligible': False,
                        'strategy_families': ['intraday_tsmom_v1'],
                        'matched_hypothesis_ids': [],
                        'reasons': ['strategy_family_hypothesis_unmapped'],
                    },
                    'dependency_quorum': {
                        'decision': 'delay',
                        'reasons': ['workflows_degraded'],
                        'message': 'Jangar workflow reliability is degraded.',
                    },
                },
                candidate_state_payload={},
                promotion_target='paper',
                artifact_root=artifact_root,
            )

        self.assertIn('alpha_readiness_not_promotion_eligible', result.reasons)
        self.assertIn('jangar_dependency_quorum_delay', result.reasons)
