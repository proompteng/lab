#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


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

    def test_verify_chat_access_requires_message(self):
        parser = self.module.build_parser()
        args = parser.parse_args(['--operation', 'verify-chat-access'])
        result = self.module.run_verify_chat_access(args)
        self.assertEqual(result, 2)

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
