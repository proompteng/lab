#!/usr/bin/env python3
"""Safely materialize bounded H-PAIRS paper-route targets into TORGHUT_SIM."""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, Strategy
from app.trading.paper_route_target_plan import (
    PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
    materialize_bounded_paper_route_target_plan,
    paper_route_target_plan_targets,
)

from .target_materialization_core import (
    ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER,
    ACTIVE_TARGET_WINDOW_SKIP_REASON,
    DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
    LIVE_LABEL_MARKERS,
    OPERATOR_CONFIRMATION,
    PROMOTION_FLAG_FIELDS,
    SCHEMA_VERSION,
    _active_target_window_check,
    _confirmed_dynamic_target_filters,
    _confirmed_selected_plan_sources,
    _decimal_text,
    _json_default,
    _load_plan,
    _plan_with_target_indexes,
    _resolve_now_utc,
    _safe_decimal,
    _safe_text,
    _target_summaries,
    _target_window_check_active_indexes,
    _truthy,
    _unique_texts,
)


def _confirmed_dynamic_target_indexes(
    summaries: Sequence[Mapping[str, Any]],
    filters: Mapping[str, str],
) -> list[int]:
    if not filters:
        return []
    return [
        int(summary.get("target_index", 0))
        for summary in summaries
        if _summary_matches_dynamic_target_filters(summary, filters)
    ]


def _summary_matches_dynamic_target_filters(
    summary: Mapping[str, Any],
    filters: Mapping[str, str],
) -> bool:
    return all(
        _summary_dynamic_target_filter_matches(summary, field, expected)
        for field, expected in filters.items()
    )


def _summary_dynamic_target_filter_matches(
    summary: Mapping[str, Any],
    field: str,
    expected: str,
) -> bool:
    if field == "runtime_strategy_name":
        return expected in _runtime_strategy_confirmation_names(summary)
    return _safe_text(summary.get(field)) == expected


def _runtime_strategy_confirmation_names(summary: Mapping[str, Any]) -> set[str]:
    confirmation_names = summary.get("runtime_strategy_confirmation_names")
    if not isinstance(confirmation_names, Sequence) or isinstance(
        confirmation_names,
        (str, bytes),
    ):
        confirmation_names = []
    allowed_names = {_safe_text(summary.get("runtime_strategy_name"))}
    allowed_names.update(_safe_text(value) for value in confirmation_names)
    return {value for value in allowed_names if value}


def _plan_flag_blockers(plan: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for field in PROMOTION_FLAG_FIELDS:
        if _truthy(plan.get(field)):
            blockers.append(f"paper_route_materialization_plan_{field}_must_be_false")
    for index, target in enumerate(paper_route_target_plan_targets(plan)):
        for field in PROMOTION_FLAG_FIELDS:
            if _truthy(target.get(field)):
                blockers.append(
                    f"paper_route_materialization_target_{index}_{field}_must_be_false"
                )
    return blockers


def _confirmation_blockers(
    *,
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
    plan_source: Mapping[str, Any],
    dsn_env: str,
) -> list[str]:
    if not bool(args.commit):
        return []

    blockers: list[str] = []
    blockers.extend(
        _confirmation_pair_blockers(_base_confirmations(args, summaries, dsn_env))
    )
    if not _runtime_strategy_confirmation_matches(args, summaries):
        blockers.append(
            "paper_route_materialization_commit_confirm_runtime_strategy_name_missing"
        )

    if not bool(args.allow_dynamic_target_plan):
        blockers.extend(
            _confirmation_pair_blockers(_exact_target_confirmations(args, summaries))
        )
    else:
        blockers.extend(
            _dynamic_target_confirmation_blockers(args, summaries, plan_source)
        )

    if _safe_text(args.operator_confirmation) != OPERATOR_CONFIRMATION:
        blockers.append("paper_route_materialization_operator_confirmation_missing")
    return blockers


def _base_confirmations(
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
    dsn_env: str,
) -> dict[str, tuple[str | None, str | None]]:
    return {
        "account_label": (
            _safe_text(args.confirm_account_label),
            PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        ),
        "dsn_env": (_safe_text(args.confirm_dsn_env), dsn_env),
        "hypothesis_id": (
            _safe_text(args.confirm_hypothesis_id),
            _joined_summary_values(summaries, "hypothesis_id"),
        ),
        "max_notional": (
            _safe_text(args.confirm_max_notional),
            _safe_text(args.max_notional),
        ),
    }


def _exact_target_confirmations(
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
) -> dict[str, tuple[str | None, str | None]]:
    return {
        "candidate_id": (
            _safe_text(args.confirm_candidate_id),
            _joined_summary_values(summaries, "candidate_id"),
        ),
        "target_plan_ref": (
            _safe_text(args.confirm_target_plan_ref),
            _joined_summary_values(summaries, "target_plan_ref"),
        ),
    }


def _joined_summary_values(
    summaries: Sequence[Mapping[str, Any]],
    field: str,
) -> str:
    return ",".join(_unique_texts([item.get(field) for item in summaries]))


def _confirmation_pair_blockers(
    confirmations: Mapping[str, tuple[str | None, str | None]],
) -> list[str]:
    return [
        f"paper_route_materialization_commit_confirm_{name}_missing"
        for name, (observed, expected) in confirmations.items()
        if expected is None or not observed or observed != expected
    ]


def _runtime_strategy_confirmation_matches(
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
) -> bool:
    runtime_strategy_confirmation = _safe_text(args.confirm_runtime_strategy_name)
    return (
        bool(summaries)
        and bool(runtime_strategy_confirmation)
        and all(
            runtime_strategy_confirmation
            in _runtime_strategy_confirmation_names(summary)
            for summary in summaries
        )
    )


def _dynamic_target_confirmation_blockers(
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
    plan_source: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    selected_plan = _safe_text(plan_source.get("selected_plan"))
    confirmed_selected_plans = _confirmed_selected_plan_sources(
        args.confirm_selected_plan_source
    )
    if (
        not selected_plan
        or not confirmed_selected_plans
        or selected_plan not in confirmed_selected_plans
    ):
        blockers.append(
            "paper_route_materialization_commit_confirm_selected_plan_source_missing"
        )
    minimum_target_count = int(args.confirm_target_count_min or 0)
    if minimum_target_count <= 0 or len(summaries) < minimum_target_count:
        blockers.append(
            "paper_route_materialization_commit_confirm_target_count_min_missing"
        )
    return blockers


def _safety_blockers(
    *,
    args: argparse.Namespace,
    plan: Mapping[str, Any],
    plan_source: Mapping[str, Any],
    summaries: Sequence[Mapping[str, Any]],
    dsn: str | None,
    dsn_env: str,
) -> list[str]:
    blockers: list[str] = []
    max_notional = _safe_decimal(args.max_notional)
    blockers.extend(
        _request_safety_blockers(args=args, dsn=dsn, max_notional=max_notional)
    )
    blockers.extend(_plan_flag_blockers(plan))
    if not summaries:
        blockers.append("paper_route_materialization_target_plan_targets_missing")
    for summary in summaries:
        blockers.extend(_target_summary_safety_blockers(summary, max_notional))
    blockers.extend(
        _confirmation_blockers(
            args=args,
            summaries=summaries,
            plan_source=plan_source,
            dsn_env=dsn_env,
        )
    )
    return sorted(dict.fromkeys(blockers))


def _request_safety_blockers(
    *,
    args: argparse.Namespace,
    dsn: str | None,
    max_notional: Decimal,
) -> list[str]:
    blockers: list[str] = []
    blockers.extend(_account_label_blockers(_safe_text(args.account_label)))
    if not dsn:
        blockers.append("paper_route_materialization_database_dsn_env_missing")
    if max_notional <= 0:
        blockers.append("paper_route_materialization_bounded_max_notional_required")
    capital_mode = _safe_text(args.capital_mode) or ""
    if capital_mode.lower() in {"live", "prod", "production", "real"}:
        blockers.append("paper_route_materialization_non_live_capital_mode_required")
    blockers.extend(_request_flag_blockers(args))
    return blockers


def _account_label_blockers(account_label: str | None) -> list[str]:
    blockers: list[str] = []
    if account_label != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL:
        blockers.append("paper_route_materialization_account_label_must_be_torghut_sim")
    if account_label and any(
        marker in account_label.upper() for marker in LIVE_LABEL_MARKERS
    ):
        blockers.append("paper_route_materialization_live_account_label_rejected")
    return blockers


def _request_flag_blockers(args: argparse.Namespace) -> list[str]:
    return [
        f"paper_route_materialization_request_{flag_name}_must_be_false"
        for flag_name in (
            "promotion_allowed",
            "final_promotion_allowed",
            "final_authority_ok",
            "capital_promotion_allowed",
        )
        if bool(getattr(args, flag_name))
    ]


def _target_summary_safety_blockers(
    summary: Mapping[str, Any],
    max_notional: Decimal,
) -> list[str]:
    index = int(summary.get("target_index", 0))
    blockers = _target_account_blockers(summary, index)
    blockers.extend(_target_required_field_blockers(summary, index))
    target_notional = _safe_decimal(summary.get("target_notional"))
    blockers.extend(
        _target_notional_blockers(summary, index, target_notional, max_notional)
    )
    blockers.extend(_target_authorization_blockers(summary, index))
    blockers.extend(_target_capacity_blockers(summary, index))
    return blockers


def _target_account_blockers(summary: Mapping[str, Any], index: int) -> list[str]:
    blockers: list[str] = []
    target_account_label = _safe_text(summary.get("account_label"))
    if target_account_label != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL:
        blockers.append(
            f"paper_route_materialization_target_{index}_account_label_must_be_torghut_sim"
        )
    if target_account_label and any(
        marker in target_account_label.upper() for marker in LIVE_LABEL_MARKERS
    ):
        blockers.append(
            f"paper_route_materialization_target_{index}_live_account_label_rejected"
        )
    return blockers


def _target_required_field_blockers(
    summary: Mapping[str, Any],
    index: int,
) -> list[str]:
    return [
        f"paper_route_materialization_target_{index}_{field}_missing"
        for field in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "target_plan_ref",
            "bounded_collection_stage",
        )
        if not _safe_text(summary.get(field))
    ]


def _target_notional_blockers(
    summary: Mapping[str, Any],
    index: int,
    target_notional: Decimal,
    max_notional: Decimal,
) -> list[str]:
    blockers: list[str] = []
    if target_notional <= 0:
        blockers.append(
            f"paper_route_materialization_target_{index}_target_notional_missing"
        )
    elif max_notional > 0 and target_notional > max_notional:
        blockers.append(
            f"paper_route_materialization_target_{index}_target_notional_exceeds_max"
        )
    if _safe_decimal(summary.get("target_quantity")) <= 0 and target_notional <= 0:
        blockers.append(
            f"paper_route_materialization_target_{index}_target_quantity_missing"
        )
    return blockers


def _target_authorization_blockers(
    summary: Mapping[str, Any],
    index: int,
) -> list[str]:
    blockers: list[str] = []
    if not _truthy(summary.get("evidence_collection_ok")):
        blockers.append(
            f"paper_route_materialization_target_{index}_evidence_collection_ok_required"
        )
    if not _truthy(summary.get("bounded_evidence_collection_authorized")):
        blockers.append(
            f"paper_route_materialization_target_{index}_bounded_evidence_collection_authorized_required"
        )
    if not cast(Sequence[object], summary.get("symbols", [])):
        blockers.append(
            f"paper_route_materialization_target_{index}_symbol_actions_missing"
        )
    return blockers


def _target_capacity_blockers(
    summary: Mapping[str, Any],
    index: int,
) -> list[str]:
    return [
        f"paper_route_materialization_target_{index}_{capacity_blocker_text}"
        for capacity_blocker in cast(
            Sequence[object], summary.get("execution_capacity_blockers", [])
        )
        if (capacity_blocker_text := _safe_text(capacity_blocker))
    ]


def _session_factory(dsn: str) -> sessionmaker[Session]:
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    return sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _strategy_names_from_summaries(
    summaries: Sequence[Mapping[str, Any]],
) -> list[str]:
    return _unique_texts([item.get("runtime_strategy_name") for item in summaries])


def _copy_preview_strategies(
    *,
    source_session: Session,
    preview_session: Session,
    strategy_names: Sequence[str],
) -> None:
    if not strategy_names:
        return
    strategies = list(
        source_session.execute(
            select(Strategy).where(Strategy.name.in_(list(strategy_names)))
        )
        .scalars()
        .all()
    )
    for strategy in strategies:
        preview_session.add(
            Strategy(
                name=strategy.name,
                description=strategy.description,
                enabled=strategy.enabled,
                base_timeframe=strategy.base_timeframe,
                universe_type=strategy.universe_type,
                universe_symbols=strategy.universe_symbols,
                max_position_pct_equity=strategy.max_position_pct_equity,
                max_notional_per_trade=strategy.max_notional_per_trade,
            )
        )
    preview_session.commit()


def _run_dry_run_materialization(
    *,
    source_session: Session,
    plan: Mapping[str, Any],
    max_notional: Decimal,
    summaries: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    preview_engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    try:
        Base.metadata.create_all(preview_engine)
        preview_session_factory = sessionmaker(
            bind=preview_engine,
            autoflush=False,
            expire_on_commit=False,
            future=True,
        )
        with preview_session_factory() as preview_session:
            _copy_preview_strategies(
                source_session=source_session,
                preview_session=preview_session,
                strategy_names=_strategy_names_from_summaries(summaries),
            )
            return _run_materialization(
                session=preview_session,
                plan=plan,
                max_notional=max_notional,
                commit=False,
            )
    finally:
        preview_engine.dispose()


def _run_materialization(
    *,
    session: Session,
    plan: Mapping[str, Any],
    max_notional: Decimal,
    commit: bool,
) -> dict[str, Any]:
    result = materialize_bounded_paper_route_target_plan(
        session,
        plan,
        generated_at=datetime.now(timezone.utc),
        bounded_notional_limit=max_notional,
    )
    if commit and not result.get("blockers"):
        session.commit()
    else:
        session.rollback()
    return result


def build_report(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    dsn_env = _safe_text(args.database_dsn_env) or "DB_DSN"
    dsn = _safe_text(os.environ.get(dsn_env))
    max_notional = _safe_decimal(args.max_notional)
    commit = bool(args.commit)
    dry_run = not commit

    try:
        plan, plan_source = _load_plan(args)
        load_blockers: list[str] = []
    except Exception as exc:
        plan = {}
        plan_source = {"kind": "unavailable"}
        load_blockers = [f"paper_route_materialization_plan_load_failed:{exc}"]

    source_plan = plan
    source_summaries = _target_summaries(source_plan)
    materialization_plan = source_plan
    summaries = source_summaries
    confirmed_dynamic_target_filter = _confirmed_dynamic_target_filters(args)
    confirmed_dynamic_target_filter_applied = False
    active_target_window_filter_applied = False
    target_window_check: dict[str, Any] | None = None
    skip_reason: str | None = None
    if confirmed_dynamic_target_filter:
        confirmed_indexes = _confirmed_dynamic_target_indexes(
            summaries,
            confirmed_dynamic_target_filter,
        )
        materialization_plan = _plan_with_target_indexes(source_plan, confirmed_indexes)
        summaries = _target_summaries(materialization_plan)
        confirmed_dynamic_target_filter_applied = len(confirmed_indexes) != len(
            source_summaries
        )
    if bool(args.skip_unless_active_target_window) or bool(
        args.require_active_target_window
    ):
        target_window_check = _active_target_window_check(
            summaries,
            now=_resolve_now_utc(args),
        )
        active_target_indexes = _target_window_check_active_indexes(target_window_check)
        if active_target_indexes and len(active_target_indexes) < len(summaries):
            materialization_plan = _plan_with_target_indexes(
                materialization_plan,
                active_target_indexes,
            )
            summaries = _target_summaries(materialization_plan)
            active_target_window_filter_applied = True

    if target_window_check is not None and not _target_window_check_active_indexes(
        target_window_check
    ):
        if bool(args.skip_unless_active_target_window) and source_summaries:
            skip_reason = ACTIVE_TARGET_WINDOW_SKIP_REASON
        else:
            load_blockers.append(ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER)

    blockers = list(load_blockers)
    if skip_reason is None:
        blockers.extend(
            _safety_blockers(
                args=args,
                plan=materialization_plan,
                plan_source=plan_source,
                summaries=summaries,
                dsn=dsn,
                dsn_env=dsn_env,
            )
        )

    materialization: dict[str, Any] = {}
    if not blockers and skip_reason is None and dsn is not None:
        try:
            factory = _session_factory(dsn)
            with factory() as session:
                if commit:
                    materialization = _run_materialization(
                        session=session,
                        plan=materialization_plan,
                        max_notional=max_notional,
                        commit=True,
                    )
                else:
                    materialization = _run_dry_run_materialization(
                        source_session=session,
                        plan=materialization_plan,
                        max_notional=max_notional,
                        summaries=summaries,
                    )
            blockers.extend(str(item) for item in materialization.get("blockers", []))
        except Exception as exc:
            blockers.append(f"paper_route_materialization_database_failed:{exc}")

    blockers = sorted(dict.fromkeys(blockers))
    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "commit" if commit else "dry_run",
        "dry_run": dry_run,
        "commit": commit,
        "skipped": skip_reason is not None,
        "skip_reason": skip_reason,
        "materialized": commit and not blockers and skip_reason is None,
        "account_label": _safe_text(args.account_label),
        "required_account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        "database_dsn_env": dsn_env,
        "database_dsn_configured": bool(dsn),
        "plan_source": plan_source,
        "max_notional": _decimal_text(max_notional),
        "capital_mode": _safe_text(args.capital_mode),
        "promotion_allowed": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "capital_promotion_allowed": False,
        "operator_confirmation_required": OPERATOR_CONFIRMATION if commit else None,
        "dynamic_target_plan_confirmation": bool(args.allow_dynamic_target_plan),
        "default_dynamic_selected_plan_source": DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
        "confirmed_dynamic_target_filter": confirmed_dynamic_target_filter or None,
        "confirmed_dynamic_target_filter_applied": confirmed_dynamic_target_filter_applied,
        "target_window_check": target_window_check,
        "active_target_window_filter_applied": active_target_window_filter_applied,
        "source_target_count": len(source_summaries),
        "target_count": len(summaries),
        "hypothesis_ids": _unique_texts(
            [item.get("hypothesis_id") for item in summaries]
        ),
        "candidate_ids": _unique_texts(
            [item.get("candidate_id") for item in summaries]
        ),
        "runtime_strategy_names": _unique_texts(
            [item.get("runtime_strategy_name") for item in summaries]
        ),
        "target_plan_refs": _unique_texts(
            [item.get("target_plan_ref") for item in summaries]
        ),
        "targets": summaries,
        "source_targets": source_summaries
        if confirmed_dynamic_target_filter_applied
        or active_target_window_filter_applied
        else None,
        "materialization": materialization,
        "materialized_decision_count": int(
            materialization.get("materialized_decision_count", 0)
        ),
        "route_submission_count": int(materialization.get("route_submission_count", 0)),
        "blockers": blockers,
        "blocked": bool(blockers),
    }
    return (2 if blockers else 0), report


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Materialize bounded H-PAIRS paper-route target-plan rows for "
            "TORGHUT_SIM evidence collection. Defaults to dry-run and rolls back all "
            "database writes unless --commit and every confirmation are supplied."
        )
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--plan-json", type=Path, default=None)
    source.add_argument("--plan-url", default=None)
    parser.add_argument("--plan-url-timeout-seconds", type=float, default=5.0)
    parser.add_argument("--plan-url-attempts", type=int, default=1)
    parser.add_argument("--database-dsn-env", default="DB_DSN")
    parser.add_argument(
        "--account-label", default=PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL
    )
    parser.add_argument("--max-notional", default=None)
    parser.add_argument("--capital-mode", default="paper")
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--promotion-allowed", action="store_true")
    parser.add_argument("--final-promotion-allowed", action="store_true")
    parser.add_argument("--final-authority-ok", action="store_true")
    parser.add_argument("--capital-promotion-allowed", action="store_true")
    parser.add_argument("--confirm-account-label", default=None)
    parser.add_argument("--confirm-dsn-env", default=None)
    parser.add_argument("--confirm-hypothesis-id", default=None)
    parser.add_argument("--confirm-candidate-id", default=None)
    parser.add_argument("--confirm-runtime-strategy-name", default=None)
    parser.add_argument("--confirm-target-plan-ref", default=None)
    parser.add_argument("--confirm-selected-plan-source", default=None)
    parser.add_argument("--confirm-target-count-min", type=int, default=None)
    parser.add_argument("--confirm-max-notional", default=None)
    parser.add_argument("--allow-dynamic-target-plan", action="store_true")
    target_window = parser.add_mutually_exclusive_group()
    target_window.add_argument(
        "--skip-unless-active-target-window", action="store_true"
    )
    target_window.add_argument("--require-active-target-window", action="store_true")
    parser.add_argument("--now-utc", default=None)
    parser.add_argument("--operator-confirmation", default=None)
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    exit_code, report = build_report(args)
    payload = json.dumps(report, indent=2, sort_keys=True, default=_json_default)
    output_path = cast(Path | None, args.output)
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
