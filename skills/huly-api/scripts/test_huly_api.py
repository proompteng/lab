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
        compact = module.build_mission_provenance_compact(
            mission_id='swarm-jangar-control-plane',
            stage='implement',
            status='running',
            swarm_agent_worker_id='worker-1',
            swarm_agent_identity='agent-abc',
        )
        self.assertEqual(
            compact,
            'Mission Metadata: missionId=swarm-jangar-control-plane | stage=implement | status=running | '
            'swarmAgentWorkerId=worker-1 | swarmAgentIdentity=agent-abc',
        )

    def test_normalize_text_block_unescapes_newlines(self):
        module = self.module
        normalized = module.normalize_text_block('Owner Update:\\n\\n## Summary\\nLine one\\nLine two')
        self.assertEqual(normalized, 'Owner Update:\n\n## Summary\nLine one\nLine two')

    def test_parser_includes_upsert_context_args(self):
        parser = self.module.build_parser()
        operation = parser._option_string_actions['--operation']
        self.assertIn('upsert-mission', operation.choices)
        for option in ['--tracker-url', '--swarm-name', '--swarm-human-name', '--swarm-team-name']:
            self.assertIn(option, parser._option_string_actions)

    def test_upsert_mission_context_metadata(self):
        parser = self.module.build_parser()
        args = parser.parse_args(
            [
                '--swarm-name',
                'jangar-control-plane',
                '--swarm-human-name',
                'Ava Runner',
                '--swarm-team-name',
                'Swarm Team',
                '--worker-id',
                'WORKER_JANGAR_IMPLEMENT',
                '--worker-identity',
                'WORKER_JANGAR_IMPLEMENT',
                '--swarm-agent-worker-id',
                'worker-override',
                '--swarm-agent-identity',
                'agent-override',
                '--tracker-url',
                'https://example-tracker.local',
            ]
        )
        metadata = self.module.build_upsert_mission_metadata(args=args)
        self.assertEqual(
            metadata,
            {
                'swarm': 'jangar-control-plane',
                'human': 'Ava Runner',
                'team': 'Swarm Team',
                'workerId': 'worker-override',
                'workerIdentity': 'agent-override',
                'trackerUrl': 'https://example-tracker.local',
            },
        )
        self.assertEqual(
            self.module.build_upsert_mission_context_section(metadata=metadata).strip(),
            '## Mission context\n'
            '- Owner: Ava Runner (Swarm Team)\n'
            '- Worker: worker-override/agent-override\n'
            '- Tracker: https://example-tracker.local\n'
            '- Swarm: jangar-control-plane',
        )
        self.assertEqual(
            self.module.build_upsert_mission_context_message(metadata=metadata),
            'Ava Runner (Swarm Team) | worker-override/agent-override | https://example-tracker.local',
        )

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
                'Plan the next delivery lane.\\nWith explicit checks.',
                '--details',
                'Include proof and PR links.\\nAttach tracker refs.',
                '--message',
                'Owner update: implementation started.\\n\\n## Summary\\nCompleted first pass.',
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
        self.assertIn('swarmAgentWorkerId=worker-override', called['channel_message'])
        self.assertIn('swarmAgentIdentity=agent-override', called['channel_message'])
        self.assertNotIn('\\n', called['channel_message'])
        self.assertIn('\n## Summary\n', called['channel_message'])
        self.assertIn('Mission Metadata: missionId=swarm-jangar-control-plane', called['channel_message'])
        self.assertNotIn('### Mission Metadata', called['channel_message'])
        self.assertIn('Plan the next delivery lane.\nWith explicit checks.', called['issue_body'])
        self.assertIn('Include proof and PR links.\nAttach tracker refs.', called['document_body'])

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

    def test_ensure_inline_body_limit_truncates_long_text(self):
        module = self.module
        text = 'a' * (module.MAX_INLINE_MISSION_BODY_CHARS + 200)
        trimmed = module.ensure_inline_body_limit(text)
        self.assertLessEqual(len(trimmed), module.MAX_INLINE_MISSION_BODY_CHARS)
        self.assertTrue(trimmed.endswith(module.TRUNCATION_NOTICE))

    def test_create_or_update_issue_clamps_body_before_tx(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_project = module.resolve_project
        original_find_issue_by_title = module.find_issue_by_title
        original_create_tx_update_doc = module.create_tx_update_doc
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_issue_by_title = lambda ctx, project_id, title: {'_id': 'issue-1'}
        module.create_tx_update_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.create_or_update_issue(
                context=context,
                project_ref='DefaultProject',
                title='Issue title',
                body='X' * 3000,
                mission_id='swarm-test',
                status='tracker:status:Backlog',
                priority=2,
            )
            self.assertEqual(result['action'], 'updated')
        finally:
            module.resolve_project = original_resolve_project
            module.find_issue_by_title = original_find_issue_by_title
            module.create_tx_update_doc = original_create_tx_update_doc
            module.submit_tx = original_submit_tx

        description = called['tx']['operations']['description']
        self.assertLessEqual(len(description), module.MAX_INLINE_MISSION_BODY_CHARS)
        self.assertTrue(description.endswith(module.TRUNCATION_NOTICE))

    def test_create_or_update_document_clamps_body_before_tx(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_teamspace = module.resolve_teamspace
        original_find_document_by_title = module.find_document_by_title
        original_create_tx_update_doc = module.create_tx_update_doc
        original_submit_tx = module.submit_tx

        module.resolve_teamspace = lambda ctx, ref: {'_id': 'teamspace-1'}
        module.find_document_by_title = lambda ctx, teamspace_id, title: {'_id': 'doc-1'}
        module.create_tx_update_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.create_or_update_document(
                context=context,
                teamspace_ref='PROOMPTENG',
                title='Doc title',
                body='Y' * 3000,
                mission_id='swarm-test',
            )
            self.assertEqual(result['action'], 'updated')
        finally:
            module.resolve_teamspace = original_resolve_teamspace
            module.find_document_by_title = original_find_document_by_title
            module.create_tx_update_doc = original_create_tx_update_doc
            module.submit_tx = original_submit_tx

        content = called['tx']['operations']['content']
        self.assertLessEqual(len(content), module.MAX_INLINE_MISSION_BODY_CHARS)
        self.assertTrue(content.endswith(module.TRUNCATION_NOTICE))


if __name__ == '__main__':
    unittest.main()
