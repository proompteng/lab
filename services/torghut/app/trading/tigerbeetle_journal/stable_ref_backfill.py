"""Bounded, deterministic repair of legacy TigerBeetle stable-ref payloads."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast

from sqlalchemy import cast as sa_cast
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models import (
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_ids import u128_decimal
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)

from .journal_payloads import (
    StableRefPayloadInput,
    nested_mapping,
    tigerbeetle_stable_ref_payload,
)


def _missing_stable_ref_clause(session: Session) -> ColumnElement[bool]:
    dialect_name = session.get_bind().dialect.name
    if dialect_name == "postgresql":
        stable_ref = TigerBeetleTransferRef.payload_json["stable_ref"]
        stable_ref_type = func.jsonb_typeof(stable_ref)
        empty_object = stable_ref == sa_cast({}, JSONB)
    elif dialect_name == "sqlite":
        stable_ref_type = func.json_type(
            TigerBeetleTransferRef.payload_json,
            "$.stable_ref",
        )
        empty_object = (
            func.json_extract(
                TigerBeetleTransferRef.payload_json,
                "$.stable_ref",
            )
            == "{}"
        )
    else:
        raise RuntimeError(
            f"tigerbeetle_stable_ref_backfill_dialect_unsupported:{dialect_name}"
        )
    return or_(
        stable_ref_type.is_(None),
        stable_ref_type != "object",
        empty_object,
    )


def _required_payload_account_id(
    payload: Mapping[str, object],
    key: str,
) -> str:
    value = payload.get(key)
    if value is None or not str(value).strip():
        raise RuntimeError(f"tigerbeetle_stable_ref_backfill_{key}_missing")
    try:
        return u128_decimal(int(str(value).strip()))
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"tigerbeetle_stable_ref_backfill_{key}_invalid") from exc


def _payload_account_id_texts(payload: Mapping[str, object]) -> tuple[str, ...]:
    values: list[object] = [
        _required_payload_account_id(payload, "debit_account_id"),
        _required_payload_account_id(payload, "credit_account_id"),
    ]
    raw_account_ids = payload.get("account_ids")
    if isinstance(raw_account_ids, Sequence) and not isinstance(
        raw_account_ids,
        (str, bytes, bytearray),
    ):
        values.extend(cast(Sequence[object], raw_account_ids))

    account_ids: list[str] = []
    for value in values:
        if value is None:
            continue
        try:
            account_id = u128_decimal(int(str(value).strip()))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "tigerbeetle_stable_ref_backfill_account_id_invalid"
            ) from exc
        if account_id not in account_ids:
            account_ids.append(account_id)
    return tuple(sorted(account_ids))


def _repairable_ref_predicates(
    session: Session,
    *,
    cluster_id: int,
) -> tuple[ColumnElement[bool], ...]:
    return (
        TigerBeetleTransferRef.cluster_id == cluster_id,
        TigerBeetleTransferRef.source_type.is_not(None),
        TigerBeetleTransferRef.source_id.is_not(None),
        func.length(func.trim(TigerBeetleTransferRef.source_type)) > 0,
        func.length(func.trim(TigerBeetleTransferRef.source_id)) > 0,
        _missing_stable_ref_clause(session),
    )


def _select_missing_refs(
    session: Session,
    *,
    cluster_id: int,
    limit: int,
) -> Sequence[TigerBeetleTransferRef]:
    return session.scalars(
        select(TigerBeetleTransferRef)
        .where(*_repairable_ref_predicates(session, cluster_id=cluster_id))
        .order_by(
            TigerBeetleTransferRef.created_at.asc(),
            TigerBeetleTransferRef.id.asc(),
        )
        .limit(max(1, int(limit)))
        .with_for_update(skip_locked=True)
    ).all()


def _load_account_specs(
    session: Session,
    *,
    cluster_id: int,
    payloads: Sequence[Mapping[str, object]],
) -> dict[str, TigerBeetleAccountSpec]:
    account_ids = sorted(
        {
            account_id
            for payload in payloads
            for account_id in _payload_account_id_texts(payload)
        }
    )
    account_refs = session.scalars(
        select(TigerBeetleAccountRef).where(
            TigerBeetleAccountRef.cluster_id == cluster_id,
            TigerBeetleAccountRef.account_id.in_(account_ids),
        )
    ).all()
    return {
        account_ref.account_id: TigerBeetleAccountSpec(
            account_id=int(account_ref.account_id),
            account_key=account_ref.account_key,
            ledger=account_ref.ledger,
            code=account_ref.code,
            account_label=account_ref.account_label,
            symbol=account_ref.symbol,
            strategy_id=account_ref.strategy_id,
        )
        for account_ref in account_refs
    }


def _account_specs_for_ref(
    ref: TigerBeetleTransferRef,
    payload: Mapping[str, object],
    account_specs_by_id: Mapping[str, TigerBeetleAccountSpec],
) -> tuple[TigerBeetleAccountSpec, ...]:
    account_ids = _payload_account_id_texts(payload)
    if any(account_id not in account_specs_by_id for account_id in account_ids):
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_ref_missing")
    account_specs = tuple(account_specs_by_id[account_id] for account_id in account_ids)
    if any(spec.ledger != ref.ledger for spec in account_specs):
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_ledger_mismatch")
    if any(not spec.account_key.strip() for spec in account_specs):
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_key_missing")
    return account_specs


def _validate_account_label(
    payload: Mapping[str, object],
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> None:
    labels = [str(spec.account_label or "").strip() for spec in account_specs]
    if not labels:
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_label_missing")
    if all(not label for label in labels):
        return
    if any(not label for label in labels):
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_label_missing")
    account_labels = set(labels)
    payload_account_label = str(payload.get("account_label") or "").strip()
    if len(account_labels) != 1 or (
        payload_account_label and payload_account_label not in account_labels
    ):
        raise RuntimeError("tigerbeetle_stable_ref_backfill_account_label_mismatch")


def _backfill_ref(
    session: Session,
    ref: TigerBeetleTransferRef,
    payload: Mapping[str, object],
    account_specs_by_id: Mapping[str, TigerBeetleAccountSpec],
) -> bool:
    stable_ref = payload.get("stable_ref")
    if isinstance(stable_ref, Mapping) and stable_ref:
        return False
    source_type = str(ref.source_type or "").strip()
    source_id = str(ref.source_id or "").strip()
    if not source_type or not source_id:
        return False

    account_specs = _account_specs_for_ref(ref, payload, account_specs_by_id)
    _validate_account_label(payload, account_specs)
    transfer_spec = TigerBeetleTransferSpec(
        transfer_id=int(ref.transfer_id),
        transfer_kind=ref.transfer_kind,
        debit_account_id=int(_required_payload_account_id(payload, "debit_account_id")),
        credit_account_id=int(
            _required_payload_account_id(payload, "credit_account_id")
        ),
        amount=int(ref.amount),
        ledger=ref.ledger,
        code=ref.code,
    )
    ref.payload_json = coerce_json_payload(
        {
            **payload,
            **tigerbeetle_stable_ref_payload(
                StableRefPayloadInput(
                    cluster_id=ref.cluster_id,
                    account_specs=account_specs,
                    transfer_spec=transfer_spec,
                    source_type=source_type,
                    source_id=source_id,
                    payload_json=payload,
                    event_fingerprint=ref.event_fingerprint,
                )
            ),
        }
    )
    session.add(ref)
    return True


def backfill_stable_ref_payloads(
    session: Session,
    *,
    cluster_id: int,
    limit: int,
) -> dict[str, object]:
    """Backfill one locked batch without contacting TigerBeetle."""

    refs = _select_missing_refs(session, cluster_id=cluster_id, limit=limit)
    payloads_by_ref_id = {ref.id: nested_mapping(ref.payload_json) for ref in refs}
    account_specs_by_id = _load_account_specs(
        session,
        cluster_id=cluster_id,
        payloads=list(payloads_by_ref_id.values()),
    )
    updated = sum(
        _backfill_ref(
            session,
            ref,
            payloads_by_ref_id[ref.id],
            account_specs_by_id,
        )
        for ref in refs
    )
    if updated:
        session.flush()
    return {
        "selected": len(refs),
        "updated": updated,
        "skipped": len(refs) - updated,
    }


def count_missing_stable_ref_payloads(
    session: Session,
    *,
    cluster_id: int,
) -> int:
    """Count source-linked transfer refs without a stable-ref object."""

    count = session.scalar(
        select(func.count())
        .select_from(TigerBeetleTransferRef)
        .where(*_repairable_ref_predicates(session, cluster_id=cluster_id))
    )
    return int(count or 0)
