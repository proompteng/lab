from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from app.models import BrokerEconomicLedgerReconciliation
from app.trading.economic_ledger import EconomicLedgerError, LedgerScope
from app.trading.economic_ledger.tigerbeetle_parity import (
    load_persisted_tigerbeetle_economic_parity,
)


_SCOPE = LedgerScope(
    provider="alpaca",
    environment="paper",
    account_label="parity-test",
    endpoint_fingerprint="c" * 64,
)


def test_non_scalar_projection_version_fails_with_economic_ledger_error() -> None:
    row = cast(
        BrokerEconomicLedgerReconciliation,
        SimpleNamespace(
            result={
                "tigerbeetle_economic_parity": {
                    "projection_version": [],
                },
            },
        ),
    )

    with pytest.raises(EconomicLedgerError):
        load_persisted_tigerbeetle_economic_parity(
            row,
            scope=_SCOPE,
            expected_cluster_id=2001,
        )
