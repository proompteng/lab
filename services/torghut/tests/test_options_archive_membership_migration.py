from __future__ import annotations

from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0062_options_archive_membership.py"


def test_archive_membership_is_unlogged_and_extends_current_head() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0062_options_archive_members"
    assert module.down_revision == "0061_linked_submission_terminal"
    assert len(module.revision) <= 32

    with patch.object(module.op, "create_table") as create_table:
        module.upgrade()

    assert create_table.call_args.kwargs["prefixes"] == ["UNLOGGED"]
    assert create_table.call_args.args[0] == "torghut_options_archive_membership"


def test_archive_membership_downgrade_drops_only_staging_table() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with patch.object(module.op, "drop_table") as drop_table:
        module.downgrade()

    drop_table.assert_called_once_with("torghut_options_archive_membership")
