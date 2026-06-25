"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


from .shared_context import (
    Mapping,
    SQLAlchemyError,
    Sequence,
    SessionLocal,
    TradingScheduler,
    ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS as _ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS,
    bindparam,
    cast,
    check_schema_current,
    datetime,
    settings,
    text,
    timezone,
)


@dataclass(frozen=True)
class _AccountScopeCatalogSnapshot:
    columns_by_table: dict[str, set[str]]
    unique_indexes_by_table: dict[str, list[tuple[str, set[str]]]]
    index_names_by_table: dict[str, list[str]]
    legacy_constraints_by_table: dict[str, set[str]]

    def has_columns(self, table: str, columns: Sequence[str]) -> bool:
        available = self.columns_by_table.get(table, set())
        return all(str(column).strip().lower() in available for column in columns)

    def has_unique_index(self, table: str, columns: Sequence[str]) -> bool:
        expected = {str(column).strip().lower() for column in columns}
        return any(
            index_columns == expected
            for _index_name, index_columns in self.unique_indexes_by_table.get(
                table, []
            )
        )

    def named_unique_constraint_present(self, table: str, names: set[str]) -> bool:
        normalized_names = {name.strip().lower() for name in names}
        return bool(
            self.legacy_constraints_by_table.get(table, set()).intersection(
                normalized_names
            )
        )


@dataclass(frozen=True)
class _SchemaGraphLineageStatus:
    roots: list[str]
    parent_forks: dict[str, list[str]]
    duplicate_revisions: dict[str, list[str]]
    orphan_parents: list[str]
    branch_count: int
    branch_tolerance: int
    allow_divergence_roots: bool
    errors: list[str]
    warnings: list[str]

    @property
    def ready(self) -> bool:
        return not self.errors


class _ReadinessAccountScopeSession(Protocol):
    def execute(
        self,
        statement: Any,
        params: Mapping[str, object] | None = None,
    ) -> Any: ...


class _ReadinessDatabaseSession(_ReadinessAccountScopeSession, Protocol):
    def connection(self) -> Any: ...


def _refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return
    try:
        resolution = resolver.get_resolution()
    except Exception as exc:  # pragma: no cover - defensive readiness surface
        setattr(state, "universe_source_status", "error")
        setattr(
            state,
            "universe_source_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        setattr(state, "universe_symbols_count", 0)
        setattr(state, "universe_cache_age_seconds", None)
        setattr(state, "universe_fail_safe_blocked", True)
        setattr(
            state,
            "universe_fail_safe_block_reason",
            f"jangar_readiness_probe_failed:{type(exc).__name__}",
        )
        return

    symbols_count = len(resolution.symbols)
    setattr(state, "universe_source_status", resolution.status)
    setattr(state, "universe_source_reason", resolution.reason)
    setattr(state, "universe_symbols_count", symbols_count)
    setattr(state, "universe_cache_age_seconds", resolution.cache_age_seconds)
    fail_safe_blocked = symbols_count == 0 and (
        settings.trading_universe_source == "static"
        or (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
        )
    )
    setattr(state, "universe_fail_safe_blocked", fail_safe_blocked)
    setattr(
        state,
        "universe_fail_safe_block_reason",
        resolution.reason if fail_safe_blocked else None,
    )
    metrics = getattr(state, "metrics", None)
    if metrics is not None:
        metrics.record_universe_resolution(
            status=resolution.status,
            reason=resolution.reason,
            symbols_count=symbols_count,
            cache_age_seconds=resolution.cache_age_seconds,
        )


def _resolve_universe_resolver_for_readiness(scheduler: TradingScheduler) -> Any | None:
    pipeline = getattr(scheduler, "_pipeline", None)
    pipeline_resolver = getattr(pipeline, "universe_resolver", None)
    if callable(getattr(pipeline_resolver, "get_resolution", None)):
        return pipeline_resolver

    return None


def _execute_readiness_account_scope_query(
    session: _ReadinessAccountScopeSession,
    sql: str,
    *,
    table_names: Sequence[str] | None = None,
) -> list[Mapping[str, object]]:
    statement = text(sql)
    params: dict[str, object] = {}
    if table_names is not None:
        statement = statement.bindparams(bindparam("table_names", expanding=True))
        params["table_names"] = list(table_names)
    return [
        cast(Mapping[str, object], row)
        for row in session.execute(statement, params).mappings().all()
    ]


def _check_account_scope_invariants_bounded(
    session: _ReadinessAccountScopeSession,
) -> dict[str, object]:
    """Validate account-scope invariants using bounded catalog reads only.

    SQLAlchemy's generic inspector can reflect PostgreSQL domains while reading
    unique constraints. In production that path can exceed the readiness
    statement timeout before /readyz reaches the actual accounting blockers. This
    helper keeps the same account-scope truth table but queries only the narrow
    pg_catalog/information_schema rows required by the readiness contract.
    """

    session.execute(
        text(f"SET LOCAL statement_timeout = {_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS}")
    )
    required_columns = _account_scope_required_columns()
    snapshot = _account_scope_catalog_snapshot(
        session,
        table_names=_account_scope_table_names(required_columns),
    )
    checks, errors = _account_scope_required_column_checks(snapshot, required_columns)
    _add_account_scope_required_unique_checks(checks, errors, snapshot)
    _add_account_scope_legacy_unique_checks(checks, errors, snapshot)
    return _finalize_account_scope_checks(checks, errors, snapshot)


def _account_scope_required_columns() -> dict[str, tuple[str, list[str]]]:
    return {
        "executions_have_account_label": ("executions", ["alpaca_account_label"]),
        "trade_decisions_have_account_label": (
            "trade_decisions",
            ["alpaca_account_label"],
        ),
        "trade_cursor_has_account_label": ("trade_cursor", ["account_label"]),
        "execution_order_events_have_account_label": (
            "execution_order_events",
            ["alpaca_account_label"],
        ),
    }


def _account_scope_table_names(
    required_columns: Mapping[str, tuple[str, list[str]]],
) -> list[str]:
    return sorted(
        {table for table, _columns in required_columns.values()}
        | {"executions", "trade_decisions", "trade_cursor"}
    )


def _account_scope_catalog_snapshot(
    session: _ReadinessAccountScopeSession,
    *,
    table_names: Sequence[str],
) -> _AccountScopeCatalogSnapshot:
    return _AccountScopeCatalogSnapshot(
        columns_by_table=_account_scope_columns_by_table(session, table_names),
        unique_indexes_by_table=_account_scope_unique_indexes_by_table(
            session, table_names
        ),
        index_names_by_table=_account_scope_index_names_by_table(session, table_names),
        legacy_constraints_by_table=_account_scope_legacy_constraints_by_table(
            session, table_names
        ),
    )


def _account_scope_columns_by_table(
    session: _ReadinessAccountScopeSession,
    table_names: Sequence[str],
) -> dict[str, set[str]]:
    column_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, att.attname AS column_name
        FROM pg_catalog.pg_class tbl
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        JOIN pg_catalog.pg_attribute att ON att.attrelid = tbl.oid
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND tbl.relkind IN ('r', 'p')
          AND att.attnum > 0
          AND NOT att.attisdropped
        """,
        table_names=table_names,
    )
    columns_by_table: dict[str, set[str]] = {}
    for row in column_rows:
        table = str(row["table_name"]).strip().lower()
        column = str(row["column_name"]).strip().lower()
        columns_by_table.setdefault(table, set()).add(column)
    return columns_by_table


def _account_scope_unique_indexes_by_table(
    session: _ReadinessAccountScopeSession,
    table_names: Sequence[str],
) -> dict[str, list[tuple[str, set[str]]]]:
    unique_index_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT
          tbl.relname AS table_name,
          idx.relname AS index_name,
          array_agg(att.attname ORDER BY ord.ordinality) AS column_names
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_catalog.pg_class tbl ON tbl.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
        JOIN pg_catalog.pg_attribute att
          ON att.attrelid = tbl.oid
         AND att.attnum = ord.attnum
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND ix.indisunique
          AND ix.indpred IS NULL
        GROUP BY tbl.relname, idx.relname
        """,
        table_names=table_names,
    )
    unique_indexes_by_table: dict[str, list[tuple[str, set[str]]]] = {}
    for row in unique_index_rows:
        table = str(row["table_name"]).strip().lower()
        index_name = str(row["index_name"]).strip().lower()
        raw_columns = cast(Sequence[object], row["column_names"] or [])
        column_names = {str(column).strip().lower() for column in raw_columns}
        unique_indexes_by_table.setdefault(table, []).append((index_name, column_names))
    return unique_indexes_by_table


def _account_scope_index_names_by_table(
    session: _ReadinessAccountScopeSession,
    table_names: Sequence[str],
) -> dict[str, list[str]]:
    all_index_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, idx.relname AS index_name
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_catalog.pg_class tbl ON tbl.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND tbl.relkind IN ('r', 'p')
          AND idx.relkind IN ('i', 'I')
        """,
        table_names=table_names,
    )
    index_names_by_table: dict[str, list[str]] = {}
    for row in all_index_rows:
        table = str(row["table_name"]).strip().lower()
        index_name = str(row["index_name"]).strip().lower()
        index_names_by_table.setdefault(table, []).append(index_name)
    return index_names_by_table


def _account_scope_legacy_constraints_by_table(
    session: _ReadinessAccountScopeSession,
    table_names: Sequence[str],
) -> dict[str, set[str]]:
    legacy_constraint_rows = _execute_readiness_account_scope_query(
        session,
        """
        SELECT tbl.relname AS table_name, con.conname AS constraint_name
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class tbl ON tbl.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        WHERE ns.nspname = current_schema()
          AND tbl.relname IN :table_names
          AND con.contype = 'u'
        """,
        table_names=table_names,
    )
    legacy_constraints_by_table: dict[str, set[str]] = {}
    for row in legacy_constraint_rows:
        table = str(row["table_name"]).strip().lower()
        constraint_name = str(row["constraint_name"]).strip().lower()
        legacy_constraints_by_table.setdefault(table, set()).add(constraint_name)
    return legacy_constraints_by_table


def _account_scope_required_column_checks(
    snapshot: _AccountScopeCatalogSnapshot,
    required_columns: Mapping[str, tuple[str, list[str]]],
) -> tuple[dict[str, object], list[str]]:
    checks: dict[str, object] = {}
    errors: list[str] = []
    for key, (table, columns) in required_columns.items():
        ok = snapshot.has_columns(table, columns)
        checks[key] = ok
        if not ok:
            errors.append(f"{table} missing required columns: {columns}")
    return checks, errors


def _add_account_scope_required_unique_checks(
    checks: dict[str, object],
    errors: list[str],
    snapshot: _AccountScopeCatalogSnapshot,
) -> None:
    checks["execution_has_account_scoped_unique_order_id"] = snapshot.has_unique_index(
        "executions",
        ["alpaca_account_label", "alpaca_order_id"],
    )
    if not checks["execution_has_account_scoped_unique_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, alpaca_order_id)"
        )

    checks["execution_has_account_scoped_unique_client_order_id"] = (
        snapshot.has_unique_index(
            "executions",
            ["alpaca_account_label", "client_order_id"],
        )
    )
    if not checks["execution_has_account_scoped_unique_client_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, client_order_id)"
        )

    checks["trade_decision_has_account_scoped_unique_decision_hash"] = (
        snapshot.has_unique_index(
            "trade_decisions",
            ["alpaca_account_label", "decision_hash"],
        )
    )
    if not checks["trade_decision_has_account_scoped_unique_decision_hash"]:
        errors.append(
            "trade_decisions missing unique index on "
            "(alpaca_account_label, decision_hash)"
        )

    checks["trade_cursor_has_account_scoped_source_index"] = snapshot.has_unique_index(
        "trade_cursor",
        ["source", "account_label"],
    )
    if not checks["trade_cursor_has_account_scoped_source_index"]:
        errors.append("trade_cursor missing unique index on (source, account_label)")


def _add_account_scope_legacy_unique_checks(
    checks: dict[str, object],
    errors: list[str],
    snapshot: _AccountScopeCatalogSnapshot,
) -> None:
    checks["legacy_executions_single_account_order_id_index_detected"] = (
        snapshot.has_unique_index("executions", ["alpaca_order_id"])
        or snapshot.named_unique_constraint_present(
            "executions",
            {"executions_alpaca_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.alpaca_order_id"
        )

    checks["legacy_executions_single_account_client_order_id_index_detected"] = (
        snapshot.has_unique_index("executions", ["client_order_id"])
        or snapshot.named_unique_constraint_present(
            "executions",
            {"executions_client_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_client_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.client_order_id"
        )

    checks["legacy_trade_cursor_source_only_source_index_detected"] = (
        snapshot.has_unique_index("trade_cursor", ["source"])
        or snapshot.named_unique_constraint_present(
            "trade_cursor",
            {"trade_cursor_source_key"},
        )
    )
    if checks["legacy_trade_cursor_source_only_source_index_detected"]:
        errors.append("legacy unique constraint/index detected for trade_cursor.source")

    checks["legacy_executions_single_account_indexes_present"] = (
        checks["legacy_executions_single_account_order_id_index_detected"]
        or checks["legacy_executions_single_account_client_order_id_index_detected"]
    )
    checks["legacy_trade_cursor_source_only_index_present"] = checks[
        "legacy_trade_cursor_source_only_source_index_detected"
    ]


def _finalize_account_scope_checks(
    checks: dict[str, object],
    errors: list[str],
    snapshot: _AccountScopeCatalogSnapshot,
) -> dict[str, object]:
    checks["account_scope_ready"] = not errors
    checks["account_scope_index_names"] = {
        "execution_indexes": sorted(
            snapshot.index_names_by_table.get("executions", [])
        ),
        "trade_decision_indexes": sorted(
            snapshot.index_names_by_table.get("trade_decisions", [])
        ),
        "trade_cursor_indexes": sorted(
            snapshot.index_names_by_table.get("trade_cursor", [])
        ),
    }
    checks["account_scope_errors"] = errors
    checks["account_scope_check_mode"] = "bounded_catalog"

    if errors and not settings.trading_multi_account_enabled:
        checks["account_scope_ready"] = True
        checks["account_scope_errors"] = []
    return checks


def _evaluate_database_contract(
    session: _ReadinessDatabaseSession,
) -> dict[str, object]:
    """Collect schema and account-scope readiness checks used by /readyz and /db-check."""
    checked_at = datetime.now(timezone.utc).isoformat()

    try:
        schema_status = check_schema_current(session)
    except SQLAlchemyError as exc:
        return _database_contract_error(
            checked_at=checked_at,
            error=f"database unavailable: {exc}",
            account_scope_errors=[str(exc)],
        )
    except RuntimeError as exc:
        return _database_contract_error(
            checked_at=checked_at,
            error=str(exc),
            account_scope_errors=[str(exc)],
        )

    account_scope_checks, account_scope_warnings = _database_contract_account_scope(
        session
    )
    schema_current = bool(schema_status.get("schema_current"))
    account_scope_ready = bool(account_scope_checks.get("account_scope_ready"))
    schema_graph = _schema_graph_lineage_status(schema_status)
    return {
        "ok": schema_current and account_scope_ready and schema_graph.ready,
        "schema_current": schema_current,
        "schema_current_heads": schema_status.get("current_heads", []),
        "expected_heads": schema_status.get("expected_heads", []),
        "schema_missing_heads": schema_status.get("schema_missing_heads", []),
        "schema_unexpected_heads": schema_status.get("schema_unexpected_heads", []),
        "schema_head_count_expected": schema_status.get("schema_head_count_expected"),
        "schema_head_count_current": schema_status.get("schema_head_count_current"),
        "schema_head_delta_count": schema_status.get("schema_head_delta_count"),
        "schema_head_signature": schema_status.get(
            "expected_heads_signature",
            schema_status.get("schema_head_signature"),
        ),
        "schema_graph_signature": schema_status.get("schema_graph_signature"),
        "schema_graph_roots": schema_graph.roots,
        "schema_graph_branch_count": schema_graph.branch_count,
        "schema_graph_parent_forks": schema_graph.parent_forks,
        "schema_graph_duplicate_revisions": schema_graph.duplicate_revisions,
        "schema_graph_orphan_parents": schema_graph.orphan_parents,
        "schema_graph_branch_tolerance": schema_graph.branch_tolerance,
        "schema_graph_allow_divergence_roots": schema_graph.allow_divergence_roots,
        "schema_graph_lineage_ready": schema_graph.ready,
        "schema_graph_lineage_errors": schema_graph.errors,
        "schema_graph_lineage_warnings": schema_graph.warnings,
        "checked_at": checked_at,
        "account_scope_ready": account_scope_ready,
        "account_scope_errors": account_scope_checks.get("account_scope_errors", []),
        "account_scope_warnings": account_scope_warnings,
    }


def _database_contract_error(
    *,
    checked_at: str,
    error: str,
    account_scope_errors: list[str],
) -> dict[str, object]:
    return {
        "ok": False,
        "error": error,
        "schema_current": False,
        "schema_current_heads": [],
        "expected_heads": [],
        "schema_head_signature": None,
        "checked_at": checked_at,
        "account_scope_ready": False,
        "account_scope_errors": account_scope_errors,
    }


def _database_contract_account_scope(
    session: _ReadinessDatabaseSession,
) -> tuple[dict[str, object], list[str]]:
    try:
        account_scope_checks = dict(check_account_scope_invariants_bounded(session))
    except (SQLAlchemyError, RuntimeError) as exc:
        account_scope_checks = {
            "account_scope_ready": False,
            "account_scope_errors": [str(exc)],
            "account_scope_check_mode": "bounded_catalog",
            "account_scope_check_failed": True,
        }
    return _apply_account_scope_bypass(cast(dict[str, object], account_scope_checks))


def _apply_account_scope_bypass(
    account_scope_checks: dict[str, object],
) -> tuple[dict[str, object], list[str]]:
    warnings: list[str] = []
    if settings.trading_multi_account_enabled:
        return account_scope_checks, warnings
    raw_errors = [
        str(error)
        for error in cast(
            list[object], account_scope_checks.get("account_scope_errors", [])
        )
    ]
    account_scope_checks["account_scope_ready"] = True
    account_scope_checks["account_scope_errors"] = []
    warnings.append(
        "account scope checks are bypassed when trading_multi_account_enabled is false"
    )
    if account_scope_checks.get("account_scope_check_failed"):
        account_scope_checks["account_scope_bypassed_errors"] = raw_errors
        warnings.append(
            "account scope catalog check failed but is non-blocking while trading_multi_account_enabled is false"
        )
    return account_scope_checks, warnings


def _schema_graph_lineage_status(
    schema_status: Mapping[str, object],
) -> _SchemaGraphLineageStatus:
    lineage = _SchemaGraphLineageStatus(
        roots=[
            str(root)
            for root in cast(list[object], schema_status.get("schema_graph_roots", []))
        ],
        parent_forks=_schema_graph_parent_forks(schema_status),
        duplicate_revisions=_schema_graph_duplicate_revisions(schema_status),
        orphan_parents=[
            str(parent)
            for parent in cast(
                list[object], schema_status.get("schema_graph_orphan_parents", [])
            )
        ],
        branch_count=_schema_graph_branch_count(
            schema_status.get("schema_graph_branch_count")
        ),
        branch_tolerance=max(0, int(settings.trading_db_schema_graph_branch_tolerance)),
        allow_divergence_roots=bool(
            settings.trading_db_schema_graph_allow_divergence_roots
        ),
        errors=[],
        warnings=[],
    )
    errors, warnings = _schema_graph_lineage_messages(lineage)
    return _SchemaGraphLineageStatus(
        roots=lineage.roots,
        parent_forks=lineage.parent_forks,
        duplicate_revisions=lineage.duplicate_revisions,
        orphan_parents=lineage.orphan_parents,
        branch_count=lineage.branch_count,
        branch_tolerance=lineage.branch_tolerance,
        allow_divergence_roots=lineage.allow_divergence_roots,
        errors=errors,
        warnings=warnings,
    )


def _schema_graph_parent_forks(
    schema_status: Mapping[str, object],
) -> dict[str, list[str]]:
    return {
        str(parent): sorted(str(child) for child in cast(list[object], children))
        for parent, children in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_parent_forks", {}),
        ).items()
        if isinstance(children, list)
    }


def _schema_graph_duplicate_revisions(
    schema_status: Mapping[str, object],
) -> dict[str, list[str]]:
    return {
        str(revision): sorted(str(path) for path in cast(list[object], files))
        for revision, files in cast(
            Mapping[object, object],
            schema_status.get("schema_graph_duplicate_revisions", {}),
        ).items()
        if isinstance(files, list)
    }


def _schema_graph_branch_count(raw_branch_count: object) -> int:
    if isinstance(raw_branch_count, bool):
        return int(raw_branch_count)
    if isinstance(raw_branch_count, int):
        return raw_branch_count
    if isinstance(raw_branch_count, str):
        try:
            return int(raw_branch_count)
        except ValueError:
            return 0
    return 0


def _schema_graph_lineage_messages(
    lineage: _SchemaGraphLineageStatus,
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if lineage.duplicate_revisions:
        duplicate_summary = ", ".join(sorted(lineage.duplicate_revisions))
        errors.append(
            f"duplicate migration revision identifiers detected: {duplicate_summary}"
        )
    if lineage.orphan_parents:
        errors.append(
            "orphan migration parents detected: " + ", ".join(lineage.orphan_parents)
        )
    if lineage.parent_forks:
        parent_summary = ", ".join(
            f"{parent} -> [{', '.join(children)}]"
            for parent, children in sorted(lineage.parent_forks.items())
        )
        warnings.append(f"migration parent forks detected: {parent_summary}")
    _append_schema_graph_branch_count_message(lineage, errors, warnings)
    return errors, warnings


def _append_schema_graph_branch_count_message(
    lineage: _SchemaGraphLineageStatus,
    errors: list[str],
    warnings: list[str],
) -> None:
    if lineage.branch_count <= lineage.branch_tolerance:
        return
    divergence_message = (
        "migration graph branch count "
        f"{lineage.branch_count} exceeds tolerance {lineage.branch_tolerance}"
    )
    if lineage.allow_divergence_roots:
        warnings.append(
            divergence_message
            + "; allowed by TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
        )
    else:
        errors.append(
            divergence_message
            + "; set TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true for temporary override"
        )


def refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    _refresh_universe_state_for_readiness(scheduler=scheduler, state=state)


def resolve_universe_resolver_for_readiness(
    scheduler: TradingScheduler,
) -> Any | None:
    return _resolve_universe_resolver_for_readiness(scheduler)


def execute_readiness_account_scope_query(
    session: _ReadinessAccountScopeSession,
    sql: str,
    *,
    table_names: Sequence[str] | None = None,
) -> list[Mapping[str, object]]:
    return _execute_readiness_account_scope_query(
        session,
        sql,
        table_names=table_names,
    )


def check_account_scope_invariants_bounded(
    session: _ReadinessAccountScopeSession,
) -> dict[str, object]:
    return _check_account_scope_invariants_bounded(session)


def evaluate_database_contract(
    session: _ReadinessDatabaseSession,
) -> dict[str, object]:
    return _evaluate_database_contract(session)


__all__ = (
    "SessionLocal",
    "refresh_universe_state_for_readiness",
    "resolve_universe_resolver_for_readiness",
    "execute_readiness_account_scope_query",
    "check_account_scope_invariants_bounded",
    "evaluate_database_contract",
)
