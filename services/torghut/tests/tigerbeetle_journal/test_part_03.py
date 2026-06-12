from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.tigerbeetle_journal.support import *


class TestTigerBeetleLedgerJournalPart3(_TestTigerBeetleLedgerJournalBase):
    def test_journal_detects_account_ref_id_key_conflict(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-ref-conflict")
            spec = next(
                item
                for item in _account_specs(event)
                if item.account_key.startswith("order_hold:")
            )
            session.add(
                TigerBeetleAccountRef(
                    cluster_id=_settings().tigerbeetle_cluster_id,
                    account_id=str(spec.account_id),
                    account_key=f"{spec.account_key}:conflict",
                    ledger=spec.ledger,
                    code=spec.code,
                    account_label=spec.account_label,
                    symbol=spec.symbol,
                    strategy_id=spec.strategy_id,
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_account_ref_conflict",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(),
                    client=FakeTigerBeetleClient(),
                ).journal_order_event(session, event)

    def test_persist_account_refs_accepts_matching_concurrent_insert(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=101,
            account_key="order_hold:paper:test-order",
            ledger=LEDGER_USD_MICRO,
            code=1101,
            account_label="paper",
            symbol="AAPL",
            strategy_id="strategy-1",
        )
        existing = TigerBeetleAccountRef(
            cluster_id=2001,
            account_id=u128_decimal(spec.account_id),
            account_key=spec.account_key,
            ledger=spec.ledger,
            code=spec.code,
            account_label=spec.account_label,
            symbol=spec.symbol,
            strategy_id=spec.strategy_id,
        )
        session = _RacingAccountRefSession(existing)

        _persist_account_refs(
            cast(Session, session),
            cluster_id=2001,
            account_specs=(spec,),
        )

        self.assertEqual(session.execute_count, 2)
        self.assertEqual(len(session.added_refs), 1)

    def test_persist_account_refs_reraises_unresolved_integrity_error(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=102,
            account_key="order_hold:paper:missing-race-row",
            ledger=LEDGER_USD_MICRO,
            code=1101,
        )
        session = _RacingAccountRefSession(None)

        with self.assertRaises(IntegrityError):
            _persist_account_refs(
                cast(Session, session),
                cluster_id=2001,
                account_specs=(spec,),
            )

    def test_persist_account_refs_rejects_conflicting_concurrent_insert(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=103,
            account_key="order_hold:paper:conflicting-race-row",
            ledger=LEDGER_USD_MICRO,
            code=1101,
        )
        existing = TigerBeetleAccountRef(
            cluster_id=2001,
            account_id=u128_decimal(spec.account_id),
            account_key=spec.account_key,
            ledger=spec.ledger,
            code=9999,
        )
        session = _RacingAccountRefSession(existing)

        with self.assertRaisesRegex(
            RuntimeError,
            "tigerbeetle_account_ref_conflict",
        ):
            _persist_account_refs(
                cast(Session, session),
                cluster_id=2001,
                account_specs=(spec,),
            )

    def test_persist_transfer_accepts_matching_concurrent_insert(self) -> None:
        transfer_spec = TigerBeetleTransferSpec(
            transfer_id=12345,
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            debit_account_id=101,
            credit_account_id=202,
            amount=1000,
            ledger=LEDGER_USD_MICRO,
            code=2010,
        )
        existing = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id=u128_decimal(transfer_spec.transfer_id),
            transfer_kind=transfer_spec.transfer_kind,
            ledger=transfer_spec.ledger,
            code=transfer_spec.code,
            amount=Decimal(transfer_spec.amount),
            status="created",
            result_code="created",
            source_type="execution",
            source_id="execution-race-row",
            payload_json={
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
            },
        )
        session = _RacingTransferRefSession(existing)

        ref = TigerBeetleLedgerJournal(
            settings_obj=_settings(),
            client=FakeTigerBeetleClient(),
        )._persist_transfer(
            cast(Session, session),
            account_specs=(),
            transfer_spec=transfer_spec,
            source_type="execution",
            source_id="execution-race-row",
            payload_json={"source": "execution"},
        )

        self.assertIs(ref, existing)
        self.assertEqual(session.execute_count, 3)
        self.assertEqual(session.flush_count, 2)
        self.assertEqual(len(session.added_refs), 2)
        self.assertEqual(existing.source_type, "execution")
        self.assertEqual(existing.source_id, "execution-race-row")

    def test_journal_ignores_non_transfer_and_missing_amount_events(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-non-transfer")
            event.event_type = "trade_update"
            event.status = "pending_replace"
            event.raw_event = {"event": "pending_replace"}

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, event)
            )

            missing = _create_fill_event(session, fingerprint="fingerprint-missing")
            missing.raw_event = {"event": "fill"}
            missing.qty = None
            missing.filled_qty = None
            missing.avg_fill_price = None

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, missing)
            )

    def test_journal_fails_on_create_transfer_error_status(self) -> None:
        class ErrorTransferClient(FakeTigerBeetleClient):
            def create_transfers(self, transfers: list[object]) -> list[object]:
                return [{"status": "limit_exceeded"}]

        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-error-status")

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_create_transfer_failed:limit_exceeded"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(),
                    client=ErrorTransferClient(),
                ).journal_order_event(session, event)

    def test_journal_accepts_official_numeric_exists_status(self) -> None:
        class NumericExistsTransferClient(FakeTigerBeetleClient):
            def create_transfers(self, transfers: list[object]) -> list[object]:
                for transfer in transfers:
                    transfer_id = int(getattr(transfer, "transfer_id"))
                    self.transfers[transfer_id] = transfer
                return [SimpleNamespace(status=46)]

        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-exists-status")
            client = NumericExistsTransferClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.status, "exists")
            self.assertEqual(
                _result_status(
                    SimpleNamespace(status=46),
                    status_type_names=("CreateTransferStatus",),
                ),
                "exists",
            )
            self.assertEqual(
                _result_status(
                    SimpleNamespace(status=4294967295),
                    status_type_names=("CreateTransferStatus",),
                ),
                "created",
            )
