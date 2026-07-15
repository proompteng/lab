from datetime import UTC, datetime
from decimal import Decimal

from app.options_lane.alpaca import normalize_contract_record
from app.options_lane.catalog_change_detection import contract_catalog_row_changed


def _normalized_contract(*, close_price: str) -> dict[str, object]:
    return normalize_contract_record(
        {
            "id": "contract-amd",
            "symbol": "AMD260715C00300000",
            "status": "active",
            "tradable": True,
            "expiration_date": "2026-07-15",
            "root_symbol": "AMD",
            "underlying_symbol": "AMD",
            "type": "call",
            "style": "american",
            "strike_price": "300.125",
            "size": "100",
            "close_price": close_price,
            "close_price_date": "2026-07-14",
        },
        observed_at=datetime(2026, 7, 15, 14, 0, tzinfo=UTC),
    )


def test_postgres_numeric_prices_do_not_create_false_catalog_changes() -> None:
    payload = _normalized_contract(close_price="261.59")
    current = dict(payload)
    current["strike_price"] = Decimal("300.125000")
    current["close_price"] = Decimal("261.590000")

    assert payload["strike_price"] == Decimal("300.125000")
    assert payload["close_price"] == Decimal("261.590000")
    assert not contract_catalog_row_changed(current=current, payload=payload)


def test_material_price_change_remains_visible() -> None:
    current = _normalized_contract(close_price="261.59")
    payload = _normalized_contract(close_price="261.60")

    assert contract_catalog_row_changed(current=current, payload=payload)
