"""Persisted-field change detection for options contract catalog rows."""

from __future__ import annotations

from collections.abc import Mapping


_CONTRACT_CATALOG_CHANGE_FIELDS = (
    "contract_id",
    "status",
    "tradable",
    "expiration_date",
    "root_symbol",
    "underlying_symbol",
    "option_type",
    "style",
    "strike_price",
    "contract_size",
    "open_interest",
    "open_interest_date",
    "close_price",
    "close_price_date",
    "provider_updated_ts",
)


def contract_catalog_row_changed(
    *,
    current: Mapping[str, object] | None,
    payload: Mapping[str, object],
) -> bool:
    """Return whether a provider payload changes a persisted catalog field."""
    return current is None or any(
        payload.get(field) != current.get(field)
        for field in _CONTRACT_CATALOG_CHANGE_FIELDS
    )


__all__ = ["contract_catalog_row_changed"]
