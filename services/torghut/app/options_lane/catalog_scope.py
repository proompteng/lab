"""Bounded query scope shared by live options catalog operations."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Mapping


@dataclass(frozen=True)
class OptionsCatalogScope:
    """Normalized underlying and expiration bounds for one complete catalog scan."""

    underlying_symbols: tuple[str, ...]
    expiration_date_gte: date
    expiration_date_lte: date

    def __post_init__(self) -> None:
        normalized_symbols = tuple(
            sorted(
                {
                    symbol.strip().upper()
                    for symbol in self.underlying_symbols
                    if symbol.strip()
                }
            )
        )
        if not normalized_symbols:
            raise ValueError("options live underlying universe must not be empty")
        if self.expiration_date_lte < self.expiration_date_gte:
            raise ValueError("options catalog expiration range is inverted")
        object.__setattr__(self, "underlying_symbols", normalized_symbols)

    @property
    def query_parameters(self) -> dict[str, object]:
        return {
            "underlying_symbols": list(self.underlying_symbols),
            "expiration_date_gte": self.expiration_date_gte,
            "expiration_date_lte": self.expiration_date_lte,
        }

    def contains(self, contract: Mapping[str, object]) -> bool:
        underlying_symbol = str(contract.get("underlying_symbol") or "").strip().upper()
        expiration_date = contract.get("expiration_date")
        return (
            underlying_symbol in self.underlying_symbols
            and isinstance(expiration_date, date)
            and self.expiration_date_gte <= expiration_date <= self.expiration_date_lte
        )
