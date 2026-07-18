from __future__ import annotations

import io
import os
from contextlib import redirect_stdout
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Base, TigerBeetleAccountRef, TigerBeetleTransferRef
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import TigerBeetleLedgerJournal
from app.trading.tigerbeetle_journal.stable_ref_backfill import (
    _missing_stable_ref_clause,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_FILL_POST,
)
from scripts.backfill_tigerbeetle_stable_refs import (
    _parse_args,
    _print_payload,
    _result_int,
    main,
    run_stable_ref_backfill,
)


DEBIT_ACCOUNT_ID = "101"
CREDIT_ACCOUNT_ID = "102"


def _settings() -> Settings:
    return Settings(
        TORGHUT_TIGERBEETLE_ENABLED=True,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
    )


def _seed_refs(
    session: Session,
    *,
    count: int,
    include_credit_account_ref: bool = True,
    credit_account_label: str | None = "paper",
) -> None:
    account_refs = [
        TigerBeetleAccountRef(
            cluster_id=2001,
            account_id=DEBIT_ACCOUNT_ID,
            account_key="cash:paper:usd",
            ledger=LEDGER_USD_MICRO,
            code=1001,
            account_label="paper",
        )
    ]
    if include_credit_account_ref:
        account_refs.append(
            TigerBeetleAccountRef(
                cluster_id=2001,
                account_id=CREDIT_ACCOUNT_ID,
                account_key="execution:paper:aapl",
                ledger=LEDGER_USD_MICRO,
                code=1502,
                account_label=credit_account_label,
                symbol="AAPL",
            )
        )
    session.add_all(account_refs)
    session.add_all(
        [
            TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(201 + index),
                transfer_kind=TRANSFER_KIND_FILL_POST,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
                amount=Decimal("2500000"),
                status="created",
                source_type="execution_order_event",
                source_id=f"event-{index}",
                event_fingerprint=f"fingerprint-{index}",
                payload_json={
                    "account_label": "paper",
                    "debit_account_id": DEBIT_ACCOUNT_ID,
                    "credit_account_id": CREDIT_ACCOUNT_ID,
                },
            )
            for index in range(count)
        ]
    )
    session.commit()


class TestBackfillTigerBeetleStableRefs(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_cli_accepts_bounded_apply_configuration(self) -> None:
        args = _parse_args(
            [
                "--dsn-env",
                "CUSTOM_DSN",
                "--batch-size",
                "5000",
                "--max-batches",
                "1000",
                "--apply",
                "--require-complete",
                "--json",
            ]
        )

        self.assertEqual(args.dsn_env, "CUSTOM_DSN")
        self.assertEqual(args.batch_size, 5_000)
        self.assertEqual(args.max_batches, 1_000)
        self.assertTrue(args.apply)
        self.assertTrue(args.require_complete)
        self.assertTrue(args.json)

    def test_cli_rejects_unsafe_bounds_and_uncommitted_completion(self) -> None:
        invalid_argv = (
            ["--batch-size", "0"],
            ["--batch-size", "5001"],
            ["--max-batches", "0"],
            ["--max-batches", "1001"],
            ["--require-complete"],
        )
        for argv in invalid_argv:
            with self.subTest(argv=argv), patch("sys.stderr", new=io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    _parse_args(argv)
                self.assertEqual(raised.exception.code, 2)

    def test_result_counts_reject_bool_negative_and_non_integer_values(self) -> None:
        for value in (True, -1, "1", None):
            with self.subTest(value=value):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "tigerbeetle_stable_ref_backfill_selected_invalid",
                ):
                    _result_int({"selected": value}, "selected")

    def test_receipt_prints_json_and_human_formats(self) -> None:
        payload = {
            "apply": True,
            "complete": True,
            "missing_before": 3,
            "missing_after": 0,
            "postgres_rows_updated": 3,
        }
        json_output = io.StringIO()
        human_output = io.StringIO()

        with redirect_stdout(json_output):
            _print_payload(payload, as_json=True)
        with redirect_stdout(human_output):
            _print_payload(payload, as_json=False)

        self.assertEqual(
            json_output.getvalue().strip(),
            '{"apply":true,"complete":true,"missing_after":0,'
            '"missing_before":3,"postgres_rows_updated":3}',
        )
        self.assertIn("apply=True complete=True", human_output.getvalue())
        self.assertIn("missing_before=3 missing_after=0", human_output.getvalue())

    def test_main_requires_the_selected_dsn_environment_variable(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var: CUSTOM_DSN"):
                main(["--dsn-env", "CUSTOM_DSN"])

    def test_postgresql_missing_predicate_uses_a_text_json_key(self) -> None:
        engine = create_engine("postgresql+psycopg://", future=True)
        try:
            with Session(engine) as session:
                clause = _missing_stable_ref_clause(session)
                compiled = clause.compile(dialect=engine.dialect)
        finally:
            engine.dispose()

        self.assertIn("payload_json ->", str(compiled))
        self.assertIn("::TEXT", str(compiled))
        self.assertNotIn("::JSONB", str(compiled))
        self.assertEqual(compiled.params["payload_json_1"], "stable_ref")
        self.assertEqual(compiled.params["jsonb_typeof_1"], "object")

    def test_apply_drains_multiple_batches_without_tigerbeetle_writes(self) -> None:
        with Session(self.engine) as session:
            _seed_refs(session, count=3)
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            result = run_stable_ref_backfill(
                session,
                journal,
                batch_size=2,
                max_batches=2,
                apply=True,
            )

            refs = session.execute(
                select(TigerBeetleTransferRef).order_by(
                    TigerBeetleTransferRef.transfer_id
                )
            ).scalars()
            payloads = [ref.payload_json for ref in refs]

        self.assertTrue(result["complete"])
        self.assertEqual(result["missing_before"], 3)
        self.assertEqual(result["missing_after"], 0)
        self.assertEqual(result["stable_ref_mismatch_count"], 0)
        self.assertEqual(result["stable_ref_count"], 3)
        self.assertEqual(result["transfer_ref_count"], 3)
        self.assertEqual(result["selected_count"], 3)
        self.assertEqual(result["postgres_rows_updated"], 3)
        self.assertEqual(result["postgres_rows_would_update"], 0)
        self.assertEqual(result["tigerbeetle_writes"], 0)
        self.assertFalse(result["capital_authority"])
        self.assertFalse(result["promotion_authority"])
        self.assertEqual(
            result["batches"],
            [
                {"batch": 1, "selected": 2, "updated": 2},
                {"batch": 2, "selected": 1, "updated": 1},
            ],
        )
        self.assertEqual(client.transfers, {})
        for payload in payloads:
            stable_ref = payload["stable_ref"]
            self.assertEqual(stable_ref["components"]["account_label"], "paper")
            self.assertEqual(
                stable_ref["account_keys"],
                ["cash:paper:usd", "execution:paper:aapl"],
            )

    def test_preview_rolls_back_the_bounded_batch(self) -> None:
        with Session(self.engine) as session:
            _seed_refs(session, count=3)
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            result = run_stable_ref_backfill(
                session,
                journal,
                batch_size=2,
                max_batches=10,
                apply=False,
            )
            payloads = session.scalars(
                select(TigerBeetleTransferRef.payload_json)
            ).all()

        self.assertFalse(result["complete"])
        self.assertEqual(result["missing_before"], 3)
        self.assertEqual(result["missing_after"], 3)
        self.assertEqual(result["selected_count"], 2)
        self.assertEqual(result["postgres_rows_updated"], 0)
        self.assertEqual(result["postgres_rows_would_update"], 2)
        self.assertTrue(all("stable_ref" not in payload for payload in payloads))

    def test_apply_reports_incomplete_when_batch_bound_is_exhausted(self) -> None:
        with Session(self.engine) as session:
            _seed_refs(session, count=3)
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            result = run_stable_ref_backfill(
                session,
                journal,
                batch_size=1,
                max_batches=1,
                apply=True,
            )

        self.assertFalse(result["complete"])
        self.assertEqual(result["postgres_rows_updated"], 1)
        self.assertEqual(result["missing_after"], 2)

    def test_missing_account_metadata_fails_closed(self) -> None:
        with Session(self.engine) as session:
            _seed_refs(session, count=1, include_credit_account_ref=False)
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_stable_ref_backfill_account_ref_missing",
            ):
                run_stable_ref_backfill(
                    session,
                    journal,
                    batch_size=1,
                    max_batches=1,
                    apply=True,
                )
            session.rollback()
            payload = session.scalar(select(TigerBeetleTransferRef.payload_json))

        self.assertNotIn("stable_ref", payload)

    def test_missing_account_label_fails_closed(self) -> None:
        with Session(self.engine) as session:
            _seed_refs(session, count=1, credit_account_label=None)
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_stable_ref_backfill_account_label_missing",
            ):
                run_stable_ref_backfill(
                    session,
                    journal,
                    batch_size=1,
                    max_batches=1,
                    apply=True,
                )
            session.rollback()
            payload = session.scalar(select(TigerBeetleTransferRef.payload_json))

        self.assertNotIn("stable_ref", payload)
