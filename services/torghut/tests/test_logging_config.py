from __future__ import annotations

import json
import logging
import sys
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from app.logging_config import JsonFormatter, configure_logging
from app.whitepapers.workflow import WhitepaperKafkaIssueIngestor


class _FakeWorkflowResult:
    def __init__(self, *, accepted: bool) -> None:
        self.accepted = accepted


class _FakeWorkflowService:
    def __init__(self, *, accepted: bool = True) -> None:
        self.accepted = accepted

    def ingest_github_issue_event(
        self,
        session: Any,
        payload: dict[str, object],
        source: str,
    ) -> _FakeWorkflowResult:
        del session, payload, source
        return _FakeWorkflowResult(accepted=self.accepted)


class _FakeKafkaConsumer:
    def __init__(self, records: list['_FakeRecord']) -> None:
        self._records = records
        self.commit_calls = 0

    def poll(self, *, timeout_ms: int, max_records: int) -> dict[tuple[str, int], list['_FakeRecord']]:
        del timeout_ms
        batch = self._records[:max_records]
        self._records = self._records[max_records:]
        if not batch:
            return {}
        return {('topic', 0): batch}

    def commit(self) -> None:
        self.commit_calls += 1


class _FakeRecord:
    def __init__(self, payload: bytes) -> None:
        self.value = payload


class _FakeSession:
    def __init__(self) -> None:
        self.commit_calls = 0
        self.rollback_calls = 0

    def commit(self) -> None:
        self.commit_calls += 1

    def rollback(self) -> None:
        self.rollback_calls += 1


class TestLoggingConfig(TestCase):
    def test_configure_logging_uses_json_in_prod_by_default(self) -> None:
        with patch.dict(
            'os.environ',
            {
                'APP_ENV': 'prod',
                'LOG_LEVEL': 'debug',
            },
            clear=False,
        ):
            runtime_config = configure_logging(force=True)

        root_logger = logging.getLogger()
        self.assertEqual(runtime_config.level, 'DEBUG')
        self.assertEqual(runtime_config.format, 'json')
        self.assertIsInstance(root_logger.handlers[0].formatter, JsonFormatter)
        self.assertEqual(root_logger.level, logging.DEBUG)
        handler = cast(logging.StreamHandler[Any], root_logger.handlers[0])
        self.assertIs(handler.stream, sys.stderr)

    def test_json_formatter_emits_structured_payload(self) -> None:
        formatter = JsonFormatter()
        record = logging.makeLogRecord(
            {
                'name': 'app.test',
                'levelno': logging.INFO,
                'levelname': 'INFO',
                'msg': 'hello %s',
                'args': ('world',),
                'created': 0,
                'service': 'torghut',
                'environment': 'test',
                'run_id': 'run-123',
            }
        )

        payload = json.loads(formatter.format(record))
        self.assertEqual(payload['message'], 'hello world')
        self.assertEqual(payload['service'], 'torghut')
        self.assertEqual(payload['environment'], 'test')
        self.assertEqual(payload['extra']['run_id'], 'run-123')

    def test_whitepaper_kafka_ingest_logs_cycle_summary(self) -> None:
        ingestor = WhitepaperKafkaIssueIngestor(
            workflow_service=cast(Any, _FakeWorkflowService())
        )
        cast(Any, ingestor)._consumer = _FakeKafkaConsumer(
            [_FakeRecord(b'{"action":"opened","issue":{"number":1}}')]
        )
        session = _FakeSession()

        with patch('app.whitepapers.workflow.whitepaper_workflow_enabled', return_value=True), patch(
            'app.whitepapers.workflow.whitepaper_kafka_enabled',
            return_value=True,
        ), patch('app.whitepapers.workflow.logger.info') as mock_info:
            counters = ingestor.ingest_once(cast(Any, session))

        self.assertEqual(counters['messages_total'], 1)
        self.assertEqual(counters['accepted_total'], 1)
        self.assertEqual(session.commit_calls, 1)
        mock_info.assert_called_once_with(
            'Whitepaper Kafka ingest cycle messages=%s accepted=%s ignored=%s failed=%s consumer_errors=%s',
            1,
            1,
            0,
            0,
            0,
        )
