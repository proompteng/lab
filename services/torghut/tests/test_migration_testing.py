from __future__ import annotations

import pytest

from tests.migration_testing import migration_path


def test_migration_path_resolves_known_migration() -> None:
    path = migration_path("0057_generic_multifactor_machine.py")

    assert path.name == "0057_generic_multifactor_machine.py"
    assert path.parent.name == "versions"


def test_migration_path_reports_expected_location() -> None:
    filename = "9999_missing_test_migration.py"

    with pytest.raises(AssertionError) as exc_info:
        migration_path(filename)

    message = str(exc_info.value)
    assert message.startswith(f"migration_not_found:{filename}:expected_path=")
    assert message.endswith(f"/migrations/versions/{filename}")


@pytest.mark.parametrize(
    "filename",
    ("../0057_generic_multifactor_machine.py", "nested/migration.py"),
)
def test_migration_path_rejects_non_basename(filename: str) -> None:
    with pytest.raises(
        AssertionError,
        match=f"^migration_filename_must_be_basename:{filename}$",
    ):
        migration_path(filename)
