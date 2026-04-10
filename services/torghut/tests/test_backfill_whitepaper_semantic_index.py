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


class _RaisingWorkflow(_FakeWorkflow):
    def __init__(self, *, raise_full_text: bool = False, raise_synthesis: bool = False) -> None:
        super().__init__()
        self.raise_full_text = raise_full_text
        self.raise_synthesis = raise_synthesis

    def index_full_text_semantic_content(self, session: Session, *, run_id: str, full_text: str) -> dict[str, int]:
        del session, run_id, full_text
        if self.raise_full_text:
            raise RuntimeError('full-text-failed')
        return {'indexed_chunks': 1}

    def index_synthesis_semantic_content(self, session: Session, *, run_id: str) -> dict[str, int]:
        del session, run_id
        if self.raise_synthesis:
            raise RuntimeError('synthesis-failed')
        return {'indexed_chunks': 1}


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

    def test_process_run_returns_partial_when_one_indexer_fails(self) -> None:
        raising_workflow = _RaisingWorkflow(raise_full_text=True)
        with Session(self.engine) as session:
            run = session.query(WhitepaperAnalysisRun).filter_by(run_id='run-1').one()
            run.document_version.content = None
            run.orchestration_context_json = {'attachment_url': 'https://example.com/paper.pdf'}
            session.commit()

        raising_workflow._download_pdf = lambda _url: b'%PDF-1.4 fake'  # type: ignore[attr-defined]
        raising_workflow._extract_pdf_text = lambda _bytes: {  # type: ignore[attr-defined]
            'full_text': 'downloaded full text',
            'metadata': {'pages': 1},
        }
        raising_workflow._upsert_whitepaper_content = lambda *args, **kwargs: None  # type: ignore[attr-defined]

        with (
            patch('scripts.backfill_whitepaper_semantic_index.SessionLocal', side_effect=lambda: Session(self.engine)),
            patch('scripts.backfill_whitepaper_semantic_index.WhitepaperWorkflowService', return_value=raising_workflow),
        ):
            result = backfill._process_run(
                run_id='run-1',
                dry_run=False,
                include_claim_graph=False,
            )

        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['synthesis_chunks'], 1)
        self.assertIn('full_text_index:full-text-failed', result['errors'])

    def test_process_run_indexes_downloaded_full_text_when_available(self) -> None:
        workflow = _RaisingWorkflow()
        with Session(self.engine) as session:
            run = session.query(WhitepaperAnalysisRun).filter_by(run_id='run-1').one()
            run.document_version.content = None
            run.orchestration_context_json = {'attachment_url': 'https://example.com/paper.pdf'}
            session.commit()

        workflow._download_pdf = lambda _url: b'%PDF-1.4 fake'  # type: ignore[attr-defined]
        workflow._extract_pdf_text = lambda _bytes: {  # type: ignore[attr-defined]
            'full_text': 'downloaded full text',
            'metadata': {'pages': 1},
        }
        workflow._upsert_whitepaper_content = lambda *args, **kwargs: None  # type: ignore[attr-defined]

        with (
            patch('scripts.backfill_whitepaper_semantic_index.SessionLocal', side_effect=lambda: Session(self.engine)),
            patch('scripts.backfill_whitepaper_semantic_index.WhitepaperWorkflowService', return_value=workflow),
        ):
            result = backfill._process_run(
                run_id='run-1',
                dry_run=False,
                include_claim_graph=False,
            )

        self.assertEqual(result['status'], 'indexed')
        self.assertEqual(result['full_text_chunks'], 1)
        self.assertEqual(result['synthesis_chunks'], 1)

    def test_process_run_raises_when_all_indexers_fail(self) -> None:
        workflow = _RaisingWorkflow(raise_full_text=True, raise_synthesis=True)
        with Session(self.engine) as session:
            run = session.query(WhitepaperAnalysisRun).filter_by(run_id='run-1').one()
            run.document_version.content = None
            run.orchestration_context_json = {'attachment_url': 'https://example.com/paper.pdf'}
            session.commit()

        workflow._download_pdf = lambda _url: b'%PDF-1.4 fake'  # type: ignore[attr-defined]
        workflow._extract_pdf_text = lambda _bytes: {  # type: ignore[attr-defined]
            'full_text': 'downloaded full text',
            'metadata': {'pages': 1},
        }
        workflow._upsert_whitepaper_content = lambda *args, **kwargs: None  # type: ignore[attr-defined]

        with (
            patch('scripts.backfill_whitepaper_semantic_index.SessionLocal', side_effect=lambda: Session(self.engine)),
            patch('scripts.backfill_whitepaper_semantic_index.WhitepaperWorkflowService', return_value=workflow),
        ):
            with self.assertRaisesRegex(RuntimeError, 'full_text_index:full-text-failed;synthesis_index:synthesis-failed'):
                backfill._process_run(
                    run_id='run-1',
                    dry_run=False,
                    include_claim_graph=False,
                )

    def test_run_backfill_requires_statuses(self) -> None:
        with self.assertRaisesRegex(ValueError, 'at least one status is required'):
            backfill.run_backfill_whitepaper_semantic_index(
                statuses=[],
                selected_run_ids=[],
                limit=10,
                concurrency=1,
                dry_run=True,
                include_claim_graph=False,
            )

    def test_run_backfill_returns_empty_report_when_no_candidates(self) -> None:
        with patch(
            'scripts.backfill_whitepaper_semantic_index._list_candidate_run_ids',
            return_value=[],
        ):
            report = backfill.run_backfill_whitepaper_semantic_index(
                statuses=['completed'],
                selected_run_ids=[],
                limit=10,
                concurrency=1,
                dry_run=True,
                include_claim_graph=False,
            )

        self.assertEqual(report['candidates'], 0)
        self.assertEqual(report['results'], [])

    def test_run_backfill_records_failed_worker_results(self) -> None:
        with patch(
            'scripts.backfill_whitepaper_semantic_index._process_run',
            side_effect=RuntimeError('worker-failed'),
        ):
            report = backfill.run_backfill_whitepaper_semantic_index(
                statuses=['completed'],
                selected_run_ids=['run-1'],
                limit=10,
                concurrency=1,
                dry_run=False,
                include_claim_graph=False,
            )

        self.assertEqual(report['failed'], 1)
        self.assertEqual(report['results'][0]['status'], 'failed')
        self.assertIn('worker-failed', report['results'][0]['error'])

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

    def test_main_rejects_empty_statuses(self) -> None:
        with patch.object(sys, 'argv', ['prog', '--statuses', ',,,']):
            with self.assertRaisesRegex(SystemExit, 'at least one status is required'):
                backfill.main()
