"""Load and validate the immutable order anchor from a published reducer pair."""

from __future__ import annotations

import hashlib
import json
from typing import cast

from sqlalchemy import and_, select
from sqlalchemy.orm import Session, aliased

from ...models import BrokerEconomicLedgerInput, BrokerEconomicLedgerRun
from ..broker_account_activities import ACCOUNT_ACTIVITIES_REST_SOURCE
from .journal_reducer import JOURNAL_REDUCER_NAME, JOURNAL_REDUCER_VERSION
from .state_reducer import STATE_REDUCER_NAME, STATE_REDUCER_VERSION
from .types import EconomicLedgerError, LedgerScope


def load_published_activity_order(
    session: Session,
    *,
    scope: LedgerScope,
) -> tuple[str, ...]:
    journal_run = aliased(BrokerEconomicLedgerRun)
    state_run = aliased(BrokerEconomicLedgerRun)
    input_row = session.scalar(
        select(BrokerEconomicLedgerInput)
        .join(
            journal_run,
            and_(
                journal_run.input_id == BrokerEconomicLedgerInput.id,
                journal_run.reducer_name == JOURNAL_REDUCER_NAME,
                journal_run.reducer_version == JOURNAL_REDUCER_VERSION,
            ),
        )
        .join(
            state_run,
            and_(
                state_run.input_id == BrokerEconomicLedgerInput.id,
                state_run.reducer_name == STATE_REDUCER_NAME,
                state_run.reducer_version == STATE_REDUCER_VERSION,
            ),
        )
        .where(
            BrokerEconomicLedgerInput.provider == scope.provider,
            BrokerEconomicLedgerInput.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerEconomicLedgerInput.environment == scope.environment,
            BrokerEconomicLedgerInput.account_label == scope.account_label,
            BrokerEconomicLedgerInput.endpoint_fingerprint
            == scope.endpoint_fingerprint,
            BrokerEconomicLedgerInput.quote_currency == scope.quote_currency,
        )
        .order_by(
            BrokerEconomicLedgerInput.source_watermark.desc(),
            BrokerEconomicLedgerInput.created_at.desc(),
            BrokerEconomicLedgerInput.id.desc(),
        )
        .limit(1)
    )
    if input_row is None:
        return ()
    return _manifest_activity_order(input_row)


def _manifest_activity_order(
    input_row: BrokerEconomicLedgerInput,
) -> tuple[str, ...]:
    manifest_json = input_row.manifest_canonical_json
    if _sha256(manifest_json) != input_row.manifest_sha256:
        raise EconomicLedgerError("economic_ledger_published_manifest_hash_mismatch")
    try:
        parsed_manifest = cast(object, json.loads(manifest_json))
    except json.JSONDecodeError as exc:
        raise EconomicLedgerError("economic_ledger_published_manifest_invalid") from exc
    if not isinstance(parsed_manifest, list):
        raise EconomicLedgerError("economic_ledger_published_manifest_invalid")
    manifest = cast(list[object], parsed_manifest)
    if _canonical_json(manifest) != manifest_json:
        raise EconomicLedgerError("economic_ledger_published_manifest_invalid")
    if len(manifest) != input_row.input_count:
        raise EconomicLedgerError("economic_ledger_published_manifest_count_mismatch")

    activity_order: list[str] = []
    for payload in manifest:
        if not isinstance(payload, dict):
            raise EconomicLedgerError("economic_ledger_published_manifest_invalid")
        payload = cast(dict[str, object], payload)
        external_id = payload.get("external_activity_id")
        if not isinstance(external_id, str) or not external_id.strip():
            raise EconomicLedgerError("economic_ledger_published_manifest_invalid")
        activity_order.append(external_id)
    if len(set(activity_order)) != len(activity_order):
        raise EconomicLedgerError("economic_ledger_published_manifest_duplicate")
    return tuple(activity_order)


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise EconomicLedgerError("economic_ledger_published_manifest_invalid") from exc


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = ("load_published_activity_order",)
