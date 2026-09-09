from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence

from scripts.whitepaper_autoresearch_runner.common import _string


def _candidate_board_score_rows(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    return {
        _string(row.get("candidate_spec_id")): row
        for row in rows
        if _string(row.get("candidate_spec_id"))
    }


def _candidate_board_decimal_field(scorecard: Mapping[str, Any], key: str) -> str:
    value = scorecard.get(key)
    if value is None:
        return ""
    return str(value)


def _candidate_board_int_field(scorecard: Mapping[str, Any], key: str) -> int:
    try:
        return max(0, int(Decimal(str(scorecard.get(key, 0) or 0))))
    except Exception:
        return 0


def _candidate_board_first_int_field(
    scorecard: Mapping[str, Any], keys: Sequence[str]
) -> int:
    for key in keys:
        value = _candidate_board_int_field(scorecard, key)
        if value > 0:
            return value
    return 0


__all__ = [
    "_candidate_board_score_rows",
    "_candidate_board_decimal_field",
    "_candidate_board_int_field",
    "_candidate_board_first_int_field",
]
