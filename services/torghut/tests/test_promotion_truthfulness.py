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
