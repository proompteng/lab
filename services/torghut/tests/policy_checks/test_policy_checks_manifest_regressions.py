from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.policy_check.profitability_manifest import (
    append_profitability_stage_manifest_reasons,
)


class TestPolicyChecksManifestRegressions(TestCase):
    def test_failed_stage_chain_is_reported_without_valid_stages(self) -> None:
        for stages in ({}, []):
            with self.subTest(stages=stages), tempfile.TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                manifest_path = (
                    root / "profitability" / "profitability-stage-manifest-v1.json"
                )
                manifest_path.parent.mkdir(parents=True)
                manifest_path.write_text(
                    json.dumps(
                        {
                            "stages": stages,
                            "overall_status": "fail",
                            "failure_reasons": ["validation_check_failed"],
                        }
                    ),
                    encoding="utf-8",
                )
                reasons: list[str] = []
                reason_details: list[dict[str, object]] = []

                append_profitability_stage_manifest_reasons(
                    reasons=reasons,
                    reason_details=reason_details,
                    policy_payload={},
                    artifact_root=root,
                )

                self.assertEqual(
                    reasons.count(
                        "profitability_stage_manifest_stage_chain_not_passed"
                    ),
                    1,
                )
                self.assertIn(
                    {
                        "reason": "profitability_stage_manifest_stage_chain_not_passed",
                        "artifact_ref": str(manifest_path),
                        "failure_reasons": ["validation_check_failed"],
                    },
                    reason_details,
                )
