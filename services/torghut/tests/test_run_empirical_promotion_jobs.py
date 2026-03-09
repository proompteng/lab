from __future__ import annotations

from unittest import TestCase

from app.trading.empirical_jobs import promote_janus_payload_to_empirical
from scripts.run_empirical_promotion_jobs import _build_janus_summary


class TestRunEmpiricalPromotionJobs(TestCase):
    def test_build_janus_summary_requires_truthful_child_artifacts(self) -> None:
        event_payload = promote_janus_payload_to_empirical(
            payload={
                'schema_version': 'janus-event-car-v1',
                'summary': {'event_count': 3},
                'manifest_hash': 'event-hash',
            },
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-event',
            runtime_version_refs=['services/torghut@sha256:abc'],
            model_refs=['models/candidate@sha256:def'],
            promotion_authority_eligible=True,
        )
        reward_payload = promote_janus_payload_to_empirical(
            payload={
                'schema_version': 'janus-hgrm-reward-v1',
                'summary': {
                    'reward_count': 3,
                    'event_mapped_count': 3,
                    'direction_gate_pass_ratio': '1',
                },
                'manifest_hash': 'reward-hash',
            },
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-reward',
            runtime_version_refs=['services/torghut@sha256:abc'],
            model_refs=['models/candidate@sha256:def'],
            promotion_authority_eligible=True,
        )

        summary = _build_janus_summary(
            event_car_payload=event_payload,
            hgrm_reward_payload=reward_payload,
            event_car_artifact_ref='s3://artifacts/event.json',
            hgrm_reward_artifact_ref='s3://artifacts/reward.json',
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-summary',
            runtime_version_refs=['services/torghut@sha256:abc'],
            model_refs=['models/candidate@sha256:def'],
        )

        self.assertTrue(summary['promotion_authority_eligible'])
        self.assertTrue(summary['artifact_authority']['authoritative'])
        self.assertEqual(summary['reasons'], [])
        self.assertEqual(summary['hgrm_reward']['event_mapped_count'], 3)

    def test_build_janus_summary_blocks_non_truthful_child_artifacts(self) -> None:
        event_payload = promote_janus_payload_to_empirical(
            payload={
                'schema_version': 'janus-event-car-v1',
                'summary': {'event_count': 3},
                'manifest_hash': 'event-hash',
            },
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-event',
            runtime_version_refs=[],
            model_refs=['models/candidate@sha256:def'],
            promotion_authority_eligible=True,
        )
        reward_payload = promote_janus_payload_to_empirical(
            payload={
                'schema_version': 'janus-hgrm-reward-v1',
                'summary': {
                    'reward_count': 3,
                    'event_mapped_count': 3,
                    'direction_gate_pass_ratio': '1',
                },
                'manifest_hash': 'reward-hash',
            },
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-reward',
            runtime_version_refs=['services/torghut@sha256:abc'],
            model_refs=['models/candidate@sha256:def'],
            promotion_authority_eligible=True,
        )

        summary = _build_janus_summary(
            event_car_payload=event_payload,
            hgrm_reward_payload=reward_payload,
            event_car_artifact_ref='s3://artifacts/event.json',
            hgrm_reward_artifact_ref='s3://artifacts/reward.json',
            dataset_snapshot_ref='snapshot-1',
            job_run_id='job-summary',
            runtime_version_refs=['services/torghut@sha256:abc'],
            model_refs=['models/candidate@sha256:def'],
        )

        self.assertFalse(summary['promotion_authority_eligible'])
        self.assertFalse(summary['artifact_authority']['authoritative'])
        self.assertIn('janus_event_car_not_truthful', summary['reasons'])
