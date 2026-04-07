from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

import scripts.backfill_whitepaper_semantic_index as backfill
from app.models import (
    Base,
    WhitepaperAnalysisRun,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperSynthesis,
)


class _FakeWorkflow:
    def __init__(self) -> None:
        self.synced = False

    @staticmethod
    def _coerce_string_list(value: object) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str):
            text = value.strip()
            return [text] if text else []
        return []

    def _build_chunks(self, text: str, *, source_scope: str) -> list[str]:
        del source_scope
        return [text] if text else []

    def index_full_text_semantic_content(self, session: Session, *, run_id: str, full_text: str) -> dict[str, int]:
        del session, run_id, full_text
        return {'indexed_chunks': 0}

    def index_synthesis_semantic_content(self, session: Session, *, run_id: str) -> dict[str, int]:
        del session, run_id
        return {'indexed_chunks': 1}

    def _sync_structured_research_outputs(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: dict[str, object],
    ) -> None:
        del session, run, payload
        self.synced = True


class TestBackfillWhitepaperSemanticIndex(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as session:
            document = WhitepaperDocument(
                document_key='doc-1',
                source='upload',
                language='en',
                status='uploaded',
            )
            version = WhitepaperDocumentVersion(
                document=document,
                version_number=1,
                trigger_reason='upload',
                mime_type='application/pdf',
                checksum_sha256='a' * 64,
                ceph_bucket='bucket',
                ceph_object_key='paper.pdf',
                parse_status='parsed',
            )
            run = WhitepaperAnalysisRun(
                run_id='run-1',
                document=document,
                document_version=version,
                status='completed',
                trigger_source='api',
            )
            synthesis = WhitepaperSynthesis(
                analysis_run=run,
                executive_summary='summary',
                synthesis_json={'claims': [{'claim_id': 'claim-1', 'claim_text': 'edge'}]},
            )
            session.add_all([document, version, run, synthesis])
            session.commit()

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_process_run_syncs_claim_graph_when_requested(self) -> None:
        fake_workflow = _FakeWorkflow()
        with (
            patch('scripts.backfill_whitepaper_semantic_index.SessionLocal', side_effect=lambda: Session(self.engine)),
            patch('scripts.backfill_whitepaper_semantic_index.WhitepaperWorkflowService', return_value=fake_workflow),
        ):
            result = backfill._process_run(
                run_id='run-1',
                dry_run=False,
                include_claim_graph=True,
            )

        self.assertEqual(result['status'], 'indexed')
        self.assertTrue(result['claim_graph_synced'])
        self.assertTrue(fake_workflow.synced)

    def test_main_parses_include_claim_graph_flag(self) -> None:
        stdout = io.StringIO()
        with (
            patch.object(
                sys,
                'argv',
                ['prog', '--run-id', 'run-1', '--dry-run', '--include-claim-graph'],
            ),
            patch(
                'scripts.backfill_whitepaper_semantic_index._process_run',
                return_value={'run_id': 'run-1', 'status': 'dry_run'},
            ) as mock_process,
            redirect_stdout(stdout),
        ):
            exit_code = backfill.main()

        self.assertEqual(exit_code, 0)
        mock_process.assert_called_once_with(
            run_id='run-1',
            dry_run=True,
            include_claim_graph=True,
        )
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload['candidates'], 1)
