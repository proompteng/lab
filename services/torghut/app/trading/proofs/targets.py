"""Runtime-window target selection for proof payloads."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, cast
from zoneinfo import ZoneInfo

from ..session_context import is_regular_equities_session_date
from .schemas import PROOFS_RUNTIME_ACCOUNT_LABEL, ProofWindowSelector

US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(hour=9, minute=30)
US_EQUITIES_CLOSE = time(hour=16, minute=0)


@dataclass(frozen=True)
class ProofTarget:
    raw: dict[str, Any]
    hypothesis_id: str | None
    candidate_id: str | None
    strategy_family: str | None
    strategy_name: str | None
    runtime_strategy_name: str | None
    account_label: str
    source_account_label: str | None
    source_kind: str | None
    source_plan_ref: str | None
    source_decision_mode: str | None
    target_notional: str | None
    symbol_actions: dict[str, str]
    symbol_quantities: dict[str, str]
    symbols: tuple[str, ...]
    window_start: datetime
    window_end: datetime

    @property
    def identity_key(self) -> tuple[str, str, str, str, str]:
        return (
            self.hypothesis_id or "",
            self.candidate_id or "",
            self.runtime_strategy_name or self.strategy_name or "",
            isoformat(self.window_start),
            isoformat(self.window_end),
        )

    def target_plan_payload(self) -> dict[str, object]:
        payload = dict(self.raw)
        payload.update(
            {
                "hypothesis_id": self.hypothesis_id,
                "candidate_id": self.candidate_id,
                "strategy_family": self.strategy_family,
                "strategy_name": self.strategy_name or self.runtime_strategy_name,
                "runtime_strategy_name": self.runtime_strategy_name
                or self.strategy_name,
                "account_label": self.account_label,
                "source_account_label": self.source_account_label or self.account_label,
                "source_kind": self.source_kind,
                "source_plan_ref": self.source_plan_ref,
                "target_notional": self.target_notional,
                "window_start": isoformat(self.window_start),
                "window_end": isoformat(self.window_end),
                "paper_route_probe_symbols": list(self.symbols),
                "symbols": list(self.symbols),
                "paper_route_probe_symbol_actions": self.symbol_actions,
                "paper_route_probe_symbol_quantities": self.symbol_quantities,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
            }
        )
        return {key: value for key, value in payload.items() if value is not None}


def mapping_items(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        {str(key): entry for key, entry in cast(Mapping[object, Any], item).items()}
        for item in cast(Sequence[object], value)
        if isinstance(item, Mapping)
    ]


def mapping_value(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def text_value(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def isoformat(value: datetime) -> str:
    resolved = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return resolved.astimezone(timezone.utc).isoformat()


def parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def next_regular_equities_session_window(
    generated_at: datetime,
) -> tuple[datetime, datetime]:
    local_now = generated_at.astimezone(ZoneInfo(US_EQUITIES_TIMEZONE))
    candidate_date = local_now.date()
    while True:
        start_local = datetime.combine(
            candidate_date,
            US_EQUITIES_OPEN,
            tzinfo=ZoneInfo(US_EQUITIES_TIMEZONE),
        )
        end_local = datetime.combine(
            candidate_date,
            US_EQUITIES_CLOSE,
            tzinfo=ZoneInfo(US_EQUITIES_TIMEZONE),
        )
        if local_now < end_local and is_regular_equities_session_date(candidate_date):
            return (
                start_local.astimezone(timezone.utc),
                end_local.astimezone(timezone.utc),
            )
        candidate_date += timedelta(days=1)


def latest_closed_regular_equities_session_window(
    generated_at: datetime,
) -> tuple[datetime, datetime]:
    local_now = generated_at.astimezone(ZoneInfo(US_EQUITIES_TIMEZONE))
    candidate_date = local_now.date()
    while True:
        start_local = datetime.combine(
            candidate_date,
            US_EQUITIES_OPEN,
            tzinfo=ZoneInfo(US_EQUITIES_TIMEZONE),
        )
        end_local = datetime.combine(
            candidate_date,
            US_EQUITIES_CLOSE,
            tzinfo=ZoneInfo(US_EQUITIES_TIMEZONE),
        )
        if local_now >= end_local and is_regular_equities_session_date(candidate_date):
            return (
                start_local.astimezone(timezone.utc),
                end_local.astimezone(timezone.utc),
            )
        candidate_date -= timedelta(days=1)


def selected_window_bounds(
    selector: ProofWindowSelector,
    generated_at: datetime,
) -> tuple[datetime, datetime]:
    if selector == "latest_closed":
        return latest_closed_regular_equities_session_window(generated_at)
    return next_regular_equities_session_window(generated_at)


def select_proof_targets(
    *,
    live_submission_gate: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any],
    limit: int,
    window: ProofWindowSelector,
    generated_at: datetime,
) -> list[ProofTarget]:
    plan = mapping_value(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    raw_targets = mapping_items(plan.get("targets"))
    if not raw_targets:
        raw_targets = mapping_items(route_reacquisition_book.get("targets"))

    selected_start, selected_end = selected_window_bounds(
        "latest_closed" if window == "latest_closed" else "next",
        generated_at,
    )
    targets: list[ProofTarget] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for raw_target in raw_targets:
        target = proof_target_from_mapping(
            raw_target,
            selector=window,
            selected_start=selected_start,
            selected_end=selected_end,
        )
        if target is None:
            continue
        if target.identity_key in seen:
            continue
        seen.add(target.identity_key)
        targets.append(target)
        if len(targets) >= limit:
            break
    return targets


def proof_target_from_mapping(
    target: Mapping[str, Any],
    *,
    selector: ProofWindowSelector,
    selected_start: datetime,
    selected_end: datetime,
) -> ProofTarget | None:
    raw = {str(key): value for key, value in target.items()}
    if selector == "auto":
        window_start = parse_datetime(raw.get("window_start")) or selected_start
        window_end = parse_datetime(raw.get("window_end")) or selected_end
    else:
        window_start = selected_start
        window_end = selected_end
    if window_end <= window_start:
        return None

    symbol_actions = _string_mapping(raw.get("paper_route_probe_symbol_actions"))
    symbol_quantities = _string_mapping(raw.get("paper_route_probe_symbol_quantities"))
    symbols = sorted(
        {
            *_symbol_values(raw.get("paper_route_probe_symbols")),
            *_symbol_values(raw.get("paper_route_probe_raw_target_symbols")),
            *_symbol_values(raw.get("symbols")),
            *_symbol_values(raw.get("target_symbols")),
            *symbol_actions.keys(),
            *symbol_quantities.keys(),
        }
    )
    account_label = text_value(raw.get("account_label")) or PROOFS_RUNTIME_ACCOUNT_LABEL
    strategy_name = text_value(raw.get("strategy_name"))
    runtime_strategy_name = (
        text_value(raw.get("runtime_strategy_name")) or strategy_name
    )
    return ProofTarget(
        raw=raw,
        hypothesis_id=text_value(raw.get("hypothesis_id")),
        candidate_id=text_value(raw.get("candidate_id")),
        strategy_family=text_value(raw.get("strategy_family")),
        strategy_name=strategy_name,
        runtime_strategy_name=runtime_strategy_name,
        account_label=account_label,
        source_account_label=text_value(raw.get("source_account_label"))
        or account_label,
        source_kind=text_value(raw.get("source_kind")),
        source_plan_ref=text_value(raw.get("source_plan_ref")),
        source_decision_mode=text_value(raw.get("source_decision_mode")),
        target_notional=text_value(raw.get("target_notional"))
        or text_value(raw.get("max_notional")),
        symbol_actions=symbol_actions,
        symbol_quantities=symbol_quantities,
        symbols=tuple(symbols),
        window_start=window_start,
        window_end=window_end,
    )


def _symbol_values(value: object) -> set[str]:
    if isinstance(value, str):
        values: Sequence[object] = value.split(",")
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        values = cast(Sequence[object], value)
    else:
        values = ()
    return {str(item).strip().upper() for item in values if str(item).strip()}


def _string_mapping(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, str] = {}
    for raw_key, raw_value in cast(Mapping[object, object], value).items():
        key = str(raw_key).strip().upper()
        item = str(raw_value or "").strip()
        if key and item:
            result[key] = item
    return result
