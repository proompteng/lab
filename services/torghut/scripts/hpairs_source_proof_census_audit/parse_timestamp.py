#!/usr/bin/env python
"""Read-only H-PAIRS/TORGHUT_SIM source-proof census/readback CLI.

This command deliberately performs diagnostics only: it reads SQLAlchemy rows or
fixture JSON and emits a deterministic machine-readable census of the gap between
paper-route activity and authority-grade runtime-ledger proof. It never writes
proof artifacts, promotion state, or database rows.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast


from .shared_context import (
    CensusIdentity,
    CensusSourceRows,
    build_source_proof_census,
    census_json,
    load_dsn_rows,
    load_fixture_rows,
    parse_args,
)
from .blocker_ladder import (
    _parse_cli_timestamp,
)


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {
            str(key): item for key, item in cast(Mapping[object, object], value).items()
        }
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, *, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object) -> int:
    try:
        return int(str(value if value is not None else "0"))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")
    return parsed if parsed.is_finite() else Decimal("0")


def _decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    started_at = _parse_cli_timestamp(args.started_at)
    ended_at = _parse_cli_timestamp(args.ended_at)
    identity = CensusIdentity(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        runtime_strategy_name=args.runtime_strategy_name,
        account_label=args.account_label,
        source_account_label=args.source_account_label,
        observed_stage=args.observed_stage,
    )
    read_error = None
    try:
        if args.fixture_json is not None:
            rows = load_fixture_rows(args.fixture_json)
            source_kind = "fixture_json"
        else:
            rows = load_dsn_rows(
                args.dsn,
                identity=identity,
                started_at=started_at,
                ended_at=ended_at,
            )
            source_kind = "sqlalchemy_dsn"
    except Exception as exc:
        rows = CensusSourceRows()
        read_error = str(exc)
        source_kind = (
            "fixture_json" if args.fixture_json is not None else "sqlalchemy_dsn"
        )
    report = build_source_proof_census(
        rows,
        identity=identity,
        started_at=started_at,
        ended_at=ended_at,
        read_error=read_error,
        source_kind=source_kind,
    )
    sys.stdout.write(census_json(report))
    verdict = _mapping(report.get("verdict"))
    return (
        1
        if args.fail_on_blockers
        and verdict.get("authority_candidate_ready") is not True
        else 0
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = ("main",)
