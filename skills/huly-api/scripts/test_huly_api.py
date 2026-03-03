#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
import io
import contextlib


def load_module():
    module_path = pathlib.Path(__file__).with_name('huly-api.py')
    spec = importlib.util.spec_from_file_location('huly_api_script', module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError('unable to load huly-api.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class HulyApiFormattingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_normalize_channel_ref_huly_uri(self):
        channel = self.module.normalize_channel_ref('huly://virtual-workers/channels/general')
        self.assertEqual(channel, 'general')

    def test_normalize_channel_ref_workbench_url(self):
        channel = self.module.normalize_channel_ref(
            'https://huly.proompteng.ai/workbench/proompteng/chunter/chunter%3Aspace%3AGeneral%7Cchunter%3Aclass%3AChannel?message'
        )
        self.assertEqual(channel, 'general')

    def test_parser_includes_list_channel_messages_operation(self):
        parser = self.module.build_parser()
        operation = parser._option_string_actions['--operation']
        self.assertIn('list-channel-messages', operation.choices)

    def test_build_mission_provenance_includes_optional_agent_metadata(self):
        module = self.module
        provenance = module.build_mission_provenance(
            mission_id='swarm-jangar-control-plane',
            stage='implement',
            status='running',
            swarm_agent_worker_id='worker-1',
            swarm_agent_identity='agent-abc',
        )
        self.assertIn('missionId: swarm-jangar-control-plane', provenance)
        self.assertIn('stage: implement', provenance)
        self.assertIn('status: running', provenance)
        self.assertIn('swarmAgentWorkerId: worker-1', provenance)
        self.assertIn('swarmAgentIdentity: agent-abc', provenance)

    def test_verify_chat_access_requires_message(self):
        parser = self.module.build_parser()
        args = parser.parse_args(['--operation', 'verify-chat-access'])
        result = self.module.run_verify_chat_access(args)
        self.assertEqual(result, 2)

    def test_upsert_mission_includes_metadata_in_all_artifacts(self):
        module = self.module
        parser = module.build_parser()
        args = parser.parse_args(
            [
                '--operation',
                'upsert-mission',
                '--mission-id',
                'swarm-jangar-control-plane',
                '--title',
                'Jangar plan mission',
                '--summary',
                'Plan the next delivery lane.',
                '--details',
                'Include proof and PR links.',
                '--message',
                'Owner update: implementation started.',
                '--worker-id',
                'worker-1',
                '--worker-identity',
                'agent-abc',
                '--swarm-agent-worker-id',
                'worker-override',
                '--swarm-agent-identity',
                'agent-override',
            ]
        )

        called = {}

        original_build_context = module.build_context
        original_create_or_update_issue = module.create_or_update_issue
        original_create_or_update_document = module.create_or_update_document
        original_post_channel_message = module.post_channel_message

        module.build_context = lambda args, for_platform_api: module.HulyContext(
            base_url='https://example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )

        def fake_issue(
            *,
            context: module.HulyContext,
            project_ref: str,
            title: str,
            body: str,
            mission_id: str,
            status: str,
            priority: int,
        ) -> dict[str, object]:
            called['issue_body'] = body
            return {'action': 'created'}

        def fake_document(
            *,
            context: module.HulyContext,
            teamspace_ref: str,
            title: str,
            body: str,
            mission_id: str,
        ) -> dict[str, object]:
            called['document_body'] = body
            return {'action': 'created'}

        def fake_channel(
            *,
            context: module.HulyContext,
            channel_ref: str,
            message: str,
        ) -> dict[str, object]:
            called['channel_message'] = message
            return {'action': 'created'}

        module.create_or_update_issue = fake_issue
        module.create_or_update_document = fake_document
        module.post_channel_message = fake_channel

        try:
            with io.StringIO() as output:
                with contextlib.redirect_stdout(output):
                    result = module.run_upsert_mission(args)
            self.assertEqual(result, 0)
        finally:
            module.build_context = original_build_context
            module.create_or_update_issue = original_create_or_update_issue
            module.create_or_update_document = original_create_or_update_document
            module.post_channel_message = original_post_channel_message

        self.assertIn('swarmAgentWorkerId: worker-override', called['issue_body'])
        self.assertIn('swarmAgentIdentity: agent-override', called['issue_body'])
        self.assertIn('swarmAgentWorkerId: worker-override', called['document_body'])
        self.assertIn('swarmAgentIdentity: agent-override', called['document_body'])
        self.assertIn('swarmAgentWorkerId: worker-override', called['channel_message'])
        self.assertIn('swarmAgentIdentity: agent-override', called['channel_message'])

    def test_upsert_mission_requires_message(self):
        parser = self.module.build_parser()
        args = parser.parse_args(
            [
                '--operation',
                'upsert-mission',
                '--mission-id',
                'swarm-jangar-control-plane-plan',
                '--title',
                'Jangar plan mission',
                '--summary',
                'Plan the next delivery lane.',
            ]
        )
        result = self.module.run_upsert_mission(args)
        self.assertEqual(result, 2)


if __name__ == '__main__':
    unittest.main()
