from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.tigerbeetle_ledger_model import (
    ACCOUNT_CODE_CASH_CONTROL,
    ACCOUNT_CODE_EXECUTION_COST,
    ACCOUNT_CODE_FILL_NOTIONAL,
    ACCOUNT_CODE_ORDER_HOLD,
    ACCOUNT_CODE_REALIZED_PNL,
    LEDGER_USD_MICRO,
    TRANSFER_CODE_CANCEL_VOID,
    TRANSFER_CODE_EXPLICIT_FEE,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_CODE_REJECT_VOID,
    TRANSFER_CODE_SUBMITTED_PENDING,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_REJECT_VOID,
    TRANSFER_KIND_SUBMITTED_PENDING,
    decimal_usd_to_micros,
    transfer_code_for_kind,
    transfer_kind_for_event,
)


class TestTigerBeetleLedgerModel(TestCase):
    def test_usd_micro_ledger_is_fixed(self) -> None:
        self.assertEqual(LEDGER_USD_MICRO, 840001)

    def test_decimal_usd_to_micros_rejects_extra_precision_and_negatives(self) -> None:
        self.assertEqual(decimal_usd_to_micros(Decimal("1.234567")), 1234567)
        with self.assertRaisesRegex(ValueError, "usd_amount_exceeds_micro_precision"):
            decimal_usd_to_micros(Decimal("1.0000001"))
        with self.assertRaisesRegex(ValueError, "usd_amount_negative"):
            decimal_usd_to_micros(Decimal("-0.01"))

    def test_account_and_transfer_codes_do_not_overlap(self) -> None:
        account_codes = {
            ACCOUNT_CODE_CASH_CONTROL,
            ACCOUNT_CODE_ORDER_HOLD,
            ACCOUNT_CODE_FILL_NOTIONAL,
            ACCOUNT_CODE_EXECUTION_COST,
            ACCOUNT_CODE_REALIZED_PNL,
        }
        transfer_codes = {
            TRANSFER_CODE_SUBMITTED_PENDING,
            TRANSFER_CODE_FILL_POST,
            TRANSFER_CODE_CANCEL_VOID,
            TRANSFER_CODE_REJECT_VOID,
            TRANSFER_CODE_EXPLICIT_FEE,
        }

        self.assertFalse(account_codes & transfer_codes)

    def test_transfer_kind_mapping_is_stable(self) -> None:
        self.assertEqual(
            transfer_kind_for_event("order_submitted", None),
            TRANSFER_KIND_SUBMITTED_PENDING,
        )
        self.assertEqual(transfer_kind_for_event("fill", None), TRANSFER_KIND_FILL_POST)
        self.assertEqual(
            transfer_kind_for_event(None, "canceled"), TRANSFER_KIND_CANCEL_VOID
        )
        self.assertEqual(
            transfer_kind_for_event(None, "rejected"), TRANSFER_KIND_REJECT_VOID
        )
        self.assertIsNone(transfer_kind_for_event("heartbeat", None))

    def test_transfer_code_for_kind_rejects_unknown_kind(self) -> None:
        self.assertEqual(
            transfer_code_for_kind(TRANSFER_KIND_FILL_POST), TRANSFER_CODE_FILL_POST
        )
        with self.assertRaisesRegex(ValueError, "unknown_tigerbeetle_transfer_kind"):
            transfer_code_for_kind("unknown")
