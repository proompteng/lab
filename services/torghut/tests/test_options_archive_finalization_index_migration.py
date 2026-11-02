from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0063_options_archive_finalization_index.py"


def _postgres_bind() -> MagicMock:
    bind = MagicMock()
    bind.dialect = SimpleNamespace(name="postgresql")
    return bind


def test_archive_finalization_index_is_concurrent_partial_and_extends_head() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    bind = _postgres_bind()
    context = MagicMock()
    context.autocommit_block.return_value = nullcontext()

    assert module.revision == "0063_options_archive_final_idx"
    assert module.down_revision == "0062_options_archive_members"
    assert len(module.revision) <= 32

    with (
        patch.object(module.op, "get_bind", return_value=bind),
        patch.object(module.op, "get_context", return_value=context),
        patch.object(module.op, "execute") as execute,
        patch.object(module, "_index_is_current", side_effect=(None, True)),
    ):
        module.upgrade()

    context.autocommit_block.assert_called_once_with()
    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "SET lock_timeout = '5s'" in sql
    assert "SET statement_timeout = '45min'" in sql
    assert "CREATE INDEX CONCURRENTLY" in sql
    assert "IF NOT EXISTS" in sql
    assert "(expiration_date, contract_symbol)" in sql
    assert "WHERE status = 'active'" in sql
    assert "RESET statement_timeout" in sql
    assert "RESET lock_timeout" in sql


def test_archive_finalization_index_repairs_invalid_concurrent_build() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    bind = _postgres_bind()
    context = MagicMock()
    context.autocommit_block.return_value = nullcontext()

    with (
        patch.object(module.op, "get_bind", return_value=bind),
        patch.object(module.op, "get_context", return_value=context),
        patch.object(module.op, "execute") as execute,
        patch.object(module, "_index_is_current", side_effect=(False, True)),
    ):
        module.upgrade()

    statements = [str(call.args[0]) for call in execute.call_args_list]
    assert any(
        statement.startswith("DROP INDEX CONCURRENTLY IF EXISTS")
        for statement in statements
    )
    assert any("CREATE INDEX CONCURRENTLY" in statement for statement in statements)
