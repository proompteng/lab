from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0063_options_archive_finalization_index.py"


def _postgres_bind(*, index_valid: bool | None) -> MagicMock:
    bind = MagicMock()
    bind.dialect = SimpleNamespace(name="postgresql")
    bind.execute.return_value.scalar_one_or_none.return_value = index_valid
    return bind


def test_archive_finalization_index_is_concurrent_partial_and_extends_head() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    bind = _postgres_bind(index_valid=None)
    context = MagicMock()
    context.autocommit_block.return_value = nullcontext()

    assert module.revision == "0063_options_archive_final_idx"
    assert module.down_revision == "0062_options_archive_members"
    assert len(module.revision) <= 32

    with (
        patch.object(module.op, "get_bind", return_value=bind),
        patch.object(module.op, "get_context", return_value=context),
        patch.object(module.op, "execute") as execute,
    ):
        module.upgrade()

    sql = str(execute.call_args.args[0])
    assert "CREATE INDEX CONCURRENTLY" in sql
    assert "(expiration_date, contract_symbol)" in sql
    assert "WHERE status = 'active'" in sql


def test_archive_finalization_index_repairs_invalid_concurrent_build() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    bind = _postgres_bind(index_valid=False)
    context = MagicMock()
    context.autocommit_block.return_value = nullcontext()

    with (
        patch.object(module.op, "get_bind", return_value=bind),
        patch.object(module.op, "get_context", return_value=context),
        patch.object(module.op, "execute") as execute,
    ):
        module.upgrade()

    statements = [str(call.args[0]) for call in execute.call_args_list]
    assert statements[0].startswith("DROP INDEX CONCURRENTLY IF EXISTS")
    assert "CREATE INDEX CONCURRENTLY" in statements[1]
