from __future__ import annotations

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
