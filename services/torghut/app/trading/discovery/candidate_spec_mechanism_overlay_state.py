"""Mutable state for candidate mechanism overlay assembly."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence


def _empty_overlay_ids() -> list[str]:
    return []


def _empty_overlay_contracts() -> list[dict[str, Any]]:
    return []


def _empty_payload_mapping() -> dict[str, Any]:
    return {}


@dataclass
class MechanismOverlayState:
    """Accumulated overlay payload pieces for a candidate hypothesis."""

    haystack: str
    overlay_ids: list[str] = field(default_factory=_empty_overlay_ids)
    overlay_contracts: list[dict[str, Any]] = field(
        default_factory=_empty_overlay_contracts
    )
    parameter_space: dict[str, Any] = field(default_factory=_empty_payload_mapping)
    hard_vetoes: dict[str, Any] = field(default_factory=_empty_payload_mapping)
    promotion_contract: dict[str, Any] = field(default_factory=_empty_payload_mapping)

    def has_any(self, tokens: Sequence[str]) -> bool:
        return any(token in self.haystack for token in tokens)


__all__ = ["MechanismOverlayState"]
