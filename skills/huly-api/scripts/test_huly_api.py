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
        self.assertIn('repair-teamspace-documents', operation.choices)
        self.assertIn('repair-project-issues', operation.choices)
        self.assertIn('dedupe-project-mission-issues', operation.choices)
        self.assertIn('--collaborator-url', parser._option_string_actions)
        self.assertIn('--fill-empty-issue-descriptions', parser._option_string_actions)

    def test_normalize_collaborator_base_url_from_frontend(self):
        module = self.module
        collaborator = module.normalize_collaborator_base_url('https://front.huly.proompteng.ai')
        self.assertEqual(collaborator, 'https://collaborator.huly.proompteng.ai')

    def test_derive_collaborator_base_url_from_transactor(self):
        module = self.module
        collaborator = module.derive_collaborator_base_url('http://transactor.huly.svc.cluster.local')
        self.assertEqual(collaborator, 'http://collaborator.huly.svc.cluster.local')

    def test_derive_issue_status_for_mission_status(self):
        module = self.module
        self.assertEqual(module.derive_issue_status_for_mission_status('completed'), module.ISSUE_STATUS_DONE)
        self.assertEqual(module.derive_issue_status_for_mission_status('running'), module.ISSUE_STATUS_IN_PROGRESS)

    def test_parser_includes_thread_reply_args(self):
        parser = self.module.build_parser()
        self.assertIn('--reply-to-message-id', parser._option_string_actions)
        self.assertIn('--reply-to-message-class', parser._option_string_actions)

    def test_post_channel_message_posts_to_channel_root_by_default(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_channel = module.resolve_channel
        original_create_tx_create_doc = module.create_tx_create_doc
        original_submit_tx = module.submit_tx

        module.resolve_channel = lambda ctx, ref: {'_id': 'channel-1', 'name': 'general'}
        module.create_tx_create_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.post_channel_message(
                context=context,
                channel_ref='general',
                message='hello team',
            )
            self.assertEqual(result['action'], 'created')
        finally:
            module.resolve_channel = original_resolve_channel
            module.create_tx_create_doc = original_create_tx_create_doc
            module.submit_tx = original_submit_tx

        self.assertEqual(called['tx']['attached_to'], 'channel-1')
        self.assertEqual(called['tx']['attached_to_class'], module.CHANNEL_CLASS)
        self.assertEqual(called['tx']['collection'], 'messages')
        self.assertIsNone(result['replyToMessageId'])
        self.assertEqual(result['collection'], 'messages')

    def test_post_channel_message_posts_thread_reply_when_parent_message_is_set(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_channel = module.resolve_channel
        original_resolve_chat_message = module.resolve_chat_message
        original_create_tx_create_doc = module.create_tx_create_doc
        original_submit_tx = module.submit_tx

        module.resolve_channel = lambda ctx, ref: {'_id': 'channel-1', 'name': 'general'}
        module.resolve_chat_message = lambda ctx, ref: {
            '_id': 'msg-parent-1',
            '_class': module.CHAT_MESSAGE_CLASS,
            'attachedTo': 'channel-1',
            'attachedToClass': module.CHANNEL_CLASS,
        }
        module.create_tx_create_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.post_channel_message(
                context=context,
                channel_ref='general',
                message='thread reply',
                reply_to_message_id='msg-parent-1',
            )
            self.assertEqual(result['action'], 'created')
        finally:
            module.resolve_channel = original_resolve_channel
            module.resolve_chat_message = original_resolve_chat_message
            module.create_tx_create_doc = original_create_tx_create_doc
            module.submit_tx = original_submit_tx

        self.assertEqual(called['tx']['object_class'], module.THREAD_MESSAGE_CLASS)
        self.assertEqual(called['tx']['attached_to'], 'msg-parent-1')
        self.assertEqual(called['tx']['attached_to_class'], module.CHAT_MESSAGE_CLASS)
        self.assertEqual(called['tx']['collection'], 'replies')
        self.assertEqual(called['tx']['attributes']['objectId'], 'channel-1')
        self.assertEqual(called['tx']['attributes']['objectClass'], module.CHANNEL_CLASS)
        self.assertEqual(result['replyToMessageId'], 'msg-parent-1')
        self.assertEqual(result['replyToMessageClass'], module.CHAT_MESSAGE_CLASS)
        self.assertEqual(result['collection'], 'replies')

    def test_post_channel_message_reuses_thread_root_when_replying_to_thread_message(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_channel = module.resolve_channel
        original_resolve_chat_message = module.resolve_chat_message
        original_create_tx_create_doc = module.create_tx_create_doc
        original_submit_tx = module.submit_tx

        module.resolve_channel = lambda ctx, ref: {'_id': 'channel-1', 'name': 'general'}
        module.resolve_chat_message = lambda ctx, ref: {
            '_id': 'reply-1',
            '_class': module.THREAD_MESSAGE_CLASS,
            'attachedTo': 'msg-parent-1',
            'attachedToClass': module.CHAT_MESSAGE_CLASS,
            'objectId': 'channel-1',
            'objectClass': module.CHANNEL_CLASS,
        }
        module.create_tx_create_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.post_channel_message(
                context=context,
                channel_ref='general',
                message='follow-up reply',
                reply_to_message_id='reply-1',
            )
            self.assertEqual(result['action'], 'created')
        finally:
            module.resolve_channel = original_resolve_channel
            module.resolve_chat_message = original_resolve_chat_message
            module.create_tx_create_doc = original_create_tx_create_doc
            module.submit_tx = original_submit_tx

        self.assertEqual(called['tx']['object_class'], module.THREAD_MESSAGE_CLASS)
        self.assertEqual(called['tx']['attached_to'], 'msg-parent-1')
        self.assertEqual(called['tx']['attached_to_class'], module.CHAT_MESSAGE_CLASS)
        self.assertEqual(called['tx']['attributes']['objectId'], 'channel-1')
        self.assertEqual(called['tx']['attributes']['objectClass'], module.CHANNEL_CLASS)
        self.assertEqual(result['replyToMessageId'], 'reply-1')
        self.assertEqual(result['replyToMessageClass'], module.CHAT_MESSAGE_CLASS)
        self.assertEqual(result['collection'], 'replies')

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

    def test_upsert_mission_keeps_channel_message_human_by_default(self):
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
            collaborator_base_url='https://collaborator.example.com',
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
            called['issue_status'] = status
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
        self.assertNotIn('swarmAgentWorkerId=worker-override', called['channel_message'])
        self.assertNotIn('swarmAgentIdentity=agent-override', called['channel_message'])
        self.assertNotIn('\\n', called['channel_message'])
        self.assertIn('\n## Summary\n', called['channel_message'])
        self.assertNotIn('Mission Metadata: missionId=swarm-jangar-control-plane', called['channel_message'])
        self.assertNotIn('### Mission Metadata', called['channel_message'])
        self.assertIn('Plan the next delivery lane.\nWith explicit checks.', called['issue_body'])
        self.assertIn('Include proof and PR links.\nAttach tracker refs.', called['document_body'])
        self.assertEqual(called['issue_status'], module.ISSUE_STATUS_IN_PROGRESS)

    def test_upsert_mission_can_append_channel_metadata_when_requested(self):
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
                '--append-channel-metadata',
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
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )

        module.create_or_update_issue = lambda **kwargs: {'action': 'created'}
        module.create_or_update_document = lambda **kwargs: {'action': 'created'}

        def fake_channel(**kwargs):
            called['channel_message'] = kwargs['message']
            return {'action': 'created'}

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

        self.assertIn('Mission Metadata: missionId=swarm-jangar-control-plane', called['channel_message'])
        self.assertIn('swarmAgentWorkerId=worker-override', called['channel_message'])

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

    def test_create_or_update_issue_uses_collaborator_ref_on_update(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_project = module.resolve_project
        original_find_issue_by_mission_id = module.find_issue_by_mission_id
        original_find_issue_by_title = module.find_issue_by_title
        original_create_issue_description_ref = module.create_issue_description_ref
        original_create_tx_update_doc = module.create_tx_update_doc
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_issue_by_mission_id = lambda ctx, project_id, mission_id: {'_id': 'issue-1'}
        module.find_issue_by_title = lambda ctx, project_id, title: {'_id': 'issue-1'}
        module.create_issue_description_ref = lambda **kwargs: 'issue-description-ref-123'
        module.create_tx_update_doc = lambda **kwargs: called.setdefault('tx', kwargs) or {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.create_or_update_issue(
                context=context,
                project_ref='DefaultProject',
                title='Issue title',
                body='This is a long-form issue body',
                mission_id='swarm-test',
                status='tracker:status:Backlog',
                priority=2,
            )
            self.assertEqual(result['action'], 'updated')
        finally:
            module.resolve_project = original_resolve_project
            module.find_issue_by_mission_id = original_find_issue_by_mission_id
            module.find_issue_by_title = original_find_issue_by_title
            module.create_issue_description_ref = original_create_issue_description_ref
            module.create_tx_update_doc = original_create_tx_update_doc
            module.submit_tx = original_submit_tx

        self.assertEqual(called['tx']['operations']['description'], 'issue-description-ref-123')
        self.assertEqual(called['tx']['operations']['status'], 'tracker:status:Backlog')

    def test_create_or_update_issue_create_uses_project_default_status_and_collab_ref(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_project = module.resolve_project
        original_find_issue_by_mission_id = module.find_issue_by_mission_id
        original_find_issue_by_title = module.find_issue_by_title
        original_latest_issue_number = module.latest_issue_number
        original_create_issue_description_ref = module.create_issue_description_ref
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {
            '_id': 'project-1',
            'identifier': 'TSK',
            'defaultIssueStatus': 'tracker:status:InProgress',
        }
        module.find_issue_by_mission_id = lambda ctx, project_id, mission_id: None
        module.find_issue_by_title = lambda ctx, project_id, title: None
        module.latest_issue_number = lambda ctx, project_id: 100
        module.create_issue_description_ref = lambda **kwargs: 'issue-description-ref-created-123'
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.create_or_update_issue(
                context=context,
                project_ref='DefaultProject',
                title='Issue title',
                body='Long form body for issue',
                mission_id='swarm-test',
                status='',
                priority=2,
            )
            self.assertEqual(result['action'], 'created')
        finally:
            module.resolve_project = original_resolve_project
            module.find_issue_by_mission_id = original_find_issue_by_mission_id
            module.find_issue_by_title = original_find_issue_by_title
            module.latest_issue_number = original_latest_issue_number
            module.create_issue_description_ref = original_create_issue_description_ref
            module.submit_tx = original_submit_tx

        self.assertEqual(len(submitted), 1)
        created_attributes = submitted[0]['attributes']
        self.assertEqual(created_attributes['status'], 'tracker:status:InProgress')
        self.assertEqual(created_attributes['description'], 'issue-description-ref-created-123')

    def test_create_or_update_issue_prefers_mission_match_over_title_lookup(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )

        original_resolve_project = module.resolve_project
        original_find_issue_by_mission_id = module.find_issue_by_mission_id
        original_find_issue_by_title = module.find_issue_by_title
        original_create_tx_update_doc = module.create_tx_update_doc
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_issue_by_mission_id = lambda ctx, project_id, mission_id: {'_id': 'issue-by-mission'}
        module.find_issue_by_title = lambda ctx, project_id, title: (_ for _ in ()).throw(AssertionError('title lookup should not run'))
        module.create_tx_update_doc = lambda **kwargs: {'_id': 'tx-1'}
        module.submit_tx = lambda **kwargs: {}

        try:
            result = module.create_or_update_issue(
                context=context,
                project_ref='DefaultProject',
                title='Issue title',
                body='',
                mission_id='swarm-test',
                status='',
                priority=2,
            )
            self.assertEqual(result['action'], 'updated')
            self.assertEqual(result['issueId'], 'issue-by-mission')
        finally:
            module.resolve_project = original_resolve_project
            module.find_issue_by_mission_id = original_find_issue_by_mission_id
            module.find_issue_by_title = original_find_issue_by_title
            module.create_tx_update_doc = original_create_tx_update_doc
            module.submit_tx = original_submit_tx

    def test_create_or_update_document_uses_collaborator_blob_ref_on_update(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        called = {}

        original_resolve_teamspace = module.resolve_teamspace
        original_find_document_by_title = module.find_document_by_title
        original_create_document_content_ref = module.create_document_content_ref
        original_create_tx_update_doc = module.create_tx_update_doc
        original_submit_tx = module.submit_tx

        module.resolve_teamspace = lambda ctx, ref: {'_id': 'teamspace-1'}
        module.find_document_by_title = lambda ctx, teamspace_id, title: {'_id': 'doc-1'}
        module.create_document_content_ref = lambda **kwargs: 'blob-ref-1234567890'
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
            module.create_document_content_ref = original_create_document_content_ref
            module.create_tx_update_doc = original_create_tx_update_doc
            module.submit_tx = original_submit_tx

        content = called['tx']['operations']['content']
        self.assertEqual(content, 'blob-ref-1234567890')

    def test_create_or_update_document_creates_then_sets_collaborator_content_ref(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_teamspace = module.resolve_teamspace
        original_find_document_by_title = module.find_document_by_title
        original_create_document_content_ref = module.create_document_content_ref
        original_submit_tx = module.submit_tx

        module.resolve_teamspace = lambda ctx, ref: {'_id': 'teamspace-1'}
        module.find_document_by_title = lambda ctx, teamspace_id, title: None
        module.create_document_content_ref = lambda **kwargs: 'blob-ref-created-123456'
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.create_or_update_document(
                context=context,
                teamspace_ref='PROOMPTENG',
                title='Doc title',
                body='Long form markdown body',
                mission_id='swarm-test',
            )
            self.assertEqual(result['action'], 'created')
        finally:
            module.resolve_teamspace = original_resolve_teamspace
            module.find_document_by_title = original_find_document_by_title
            module.create_document_content_ref = original_create_document_content_ref
            module.submit_tx = original_submit_tx

        self.assertEqual(len(submitted), 2)
        self.assertEqual(submitted[1]['operations']['content'], 'blob-ref-created-123456')

    def test_repair_teamspace_documents_converts_legacy_inline_content(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_teamspace = module.resolve_teamspace
        original_find_all = module.find_all
        original_create_document_content_ref = module.create_document_content_ref
        original_submit_tx = module.submit_tx

        module.resolve_teamspace = lambda ctx, ref: {'_id': 'teamspace-1', 'name': 'PROOMPTENG'}
        module.find_all = lambda **kwargs: [
            {'_id': 'doc-legacy', 'title': '[mission:alpha] Legacy doc', 'content': '# Legacy markdown\n\nBody'},
            {'_id': 'doc-healthy', 'title': '[mission:beta] Healthy doc', 'content': 'blobref1234567890abcd'},
            {'_id': 'doc-non-mission', 'title': 'Random note', 'content': '# ignore'},
        ]
        module.create_document_content_ref = lambda **kwargs: 'blob-ref-fixed-123456'
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.repair_teamspace_documents(
                context=context,
                teamspace_ref='PROOMPTENG',
                limit=50,
                mission_only=True,
                dry_run=False,
            )
        finally:
            module.resolve_teamspace = original_resolve_teamspace
            module.find_all = original_find_all
            module.create_document_content_ref = original_create_document_content_ref
            module.submit_tx = original_submit_tx

        self.assertEqual(result['converted'], 1)
        self.assertEqual(result['alreadyHealthy'], 1)
        self.assertEqual(result['skippedNonMission'], 1)
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0]['operations']['content'], 'blob-ref-fixed-123456')

    def test_repair_project_issues_converts_legacy_inline_description(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_project = module.resolve_project
        original_find_all = module.find_all
        original_create_issue_description_ref = module.create_issue_description_ref
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_all = lambda **kwargs: [
            {'_id': 'issue-legacy', 'title': '[mission:alpha] Legacy issue', 'description': 'Legacy plain text body'},
            {'_id': 'issue-healthy', 'title': '[mission:beta] Healthy issue', 'description': 'blobref1234567890abcd'},
            {'_id': 'issue-non-mission', 'title': 'Random issue', 'description': 'Legacy plain text body'},
        ]
        module.create_issue_description_ref = lambda **kwargs: 'issue-ref-fixed-123456'
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.repair_project_issues(
                context=context,
                project_ref='DefaultProject',
                limit=50,
                mission_only=True,
                fill_empty_descriptions=False,
                dry_run=False,
            )
        finally:
            module.resolve_project = original_resolve_project
            module.find_all = original_find_all
            module.create_issue_description_ref = original_create_issue_description_ref
            module.submit_tx = original_submit_tx

        self.assertEqual(result['converted'], 1)
        self.assertEqual(result['alreadyHealthy'], 1)
        self.assertEqual(result['skippedNonMission'], 1)
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0]['operations']['description'], 'issue-ref-fixed-123456')

    def test_repair_project_issues_can_fill_empty_descriptions(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_project = module.resolve_project
        original_find_all = module.find_all
        original_create_issue_description_ref = module.create_issue_description_ref
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_all = lambda **kwargs: [
            {
                '_id': 'issue-empty',
                'title': '[mission:alpha] Empty issue',
                'description': '',
                'status': module.ISSUE_STATUS_IN_PROGRESS,
            },
        ]
        module.create_issue_description_ref = lambda **kwargs: 'issue-ref-filled-123456'
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.repair_project_issues(
                context=context,
                project_ref='DefaultProject',
                limit=50,
                mission_only=True,
                fill_empty_descriptions=True,
                dry_run=False,
            )
        finally:
            module.resolve_project = original_resolve_project
            module.find_all = original_find_all
            module.create_issue_description_ref = original_create_issue_description_ref
            module.submit_tx = original_submit_tx

        self.assertEqual(result['converted'], 1)
        self.assertEqual(result['filledEmptyDescriptions'], 1)
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0]['operations']['description'], 'issue-ref-filled-123456')

    def test_dedupe_project_mission_issues_cancels_older_duplicates(self):
        module = self.module
        context = module.HulyContext(
            base_url='https://example.com',
            collaborator_base_url='https://collaborator.example.com',
            token='token',
            token_source='test',
            workspace_id='workspace-1',
            actor_id='actor-1',
            timeout_seconds=30,
        )
        submitted = []

        original_resolve_project = module.resolve_project
        original_find_all = module.find_all
        original_submit_tx = module.submit_tx

        module.resolve_project = lambda ctx, ref: {'_id': 'project-1', 'identifier': 'TSK'}
        module.find_all = lambda **kwargs: [
            {'_id': 'issue-new', 'title': '[mission:alpha] Newest', 'status': module.ISSUE_STATUS_IN_PROGRESS},
            {'_id': 'issue-old', 'title': '[mission:alpha] Older', 'status': module.ISSUE_STATUS_IN_PROGRESS},
            {'_id': 'issue-canceled', 'title': '[mission:alpha] Already canceled', 'status': module.ISSUE_STATUS_CANCELED},
            {'_id': 'issue-other', 'title': '[mission:beta] Other', 'status': module.ISSUE_STATUS_IN_PROGRESS},
        ]
        module.submit_tx = lambda **kwargs: submitted.append(kwargs['payload']) or {}

        try:
            result = module.dedupe_project_mission_issues(
                context=context,
                project_ref='DefaultProject',
                limit=50,
                dry_run=False,
            )
        finally:
            module.resolve_project = original_resolve_project
            module.find_all = original_find_all
            module.submit_tx = original_submit_tx

        self.assertEqual(result['duplicateMissionGroups'], 1)
        self.assertEqual(result['canceledDuplicates'], 1)
        self.assertEqual(result['alreadyCanceledDuplicates'], 1)
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0]['operations']['status'], module.ISSUE_STATUS_CANCELED)


if __name__ == '__main__':
    unittest.main()
