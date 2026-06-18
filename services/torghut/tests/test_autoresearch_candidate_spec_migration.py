from __future__ import annotations

from unittest import TestCase

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0031_autoresearch_candidate_spec_epoch_uniqueness.py"


class _FakeOp:
    def __init__(self) -> None:
        self.drop_constraint_calls: list[tuple[str, str, str | None]] = []
        self.drop_index_calls: list[tuple[str, str]] = []
        self.create_index_calls: list[tuple[str, str, list[str], bool]] = []
        self.create_unique_constraint_calls: list[tuple[str, str, list[str]]] = []

    def drop_constraint(
        self, name: str, table_name: str, *, type_: str | None = None
    ) -> None:
        self.drop_constraint_calls.append((name, table_name, type_))

    def drop_index(self, name: str, *, table_name: str) -> None:
        self.drop_index_calls.append((name, table_name))

    def create_index(
        self, name: str, table_name: str, columns: list[str], *, unique: bool = False
    ) -> None:
        self.create_index_calls.append((name, table_name, columns, unique))

    def create_unique_constraint(
        self, name: str, table_name: str, columns: list[str]
    ) -> None:
        self.create_unique_constraint_calls.append((name, table_name, columns))


class TestAutoresearchCandidateSpecMigration(TestCase):
    def test_upgrade_drops_existing_unique_constraint_before_epoch_scoped_index(
        self,
    ) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        fake_op = _FakeOp()
        original_op = module.op
        try:
            module.op = fake_op
            module.upgrade()
        finally:
            module.op = original_op

        self.assertEqual(
            fake_op.drop_constraint_calls,
            [
                (
                    "uq_autoresearch_candidate_specs_candidate_spec_id",
                    "autoresearch_candidate_specs",
                    "unique",
                )
            ],
        )
        self.assertEqual(fake_op.drop_index_calls, [])
        self.assertEqual(
            fake_op.create_index_calls,
            [
                (
                    "uq_autoresearch_candidate_specs_epoch_candidate_spec",
                    "autoresearch_candidate_specs",
                    ["epoch_id", "candidate_spec_id"],
                    True,
                )
            ],
        )

    def test_downgrade_restores_candidate_spec_unique_constraint(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        fake_op = _FakeOp()
        original_op = module.op
        try:
            module.op = fake_op
            module.downgrade()
        finally:
            module.op = original_op

        self.assertEqual(
            fake_op.drop_index_calls,
            [
                (
                    "uq_autoresearch_candidate_specs_epoch_candidate_spec",
                    "autoresearch_candidate_specs",
                )
            ],
        )
        self.assertEqual(
            fake_op.create_unique_constraint_calls,
            [
                (
                    "uq_autoresearch_candidate_specs_candidate_spec_id",
                    "autoresearch_candidate_specs",
                    ["candidate_spec_id"],
                )
            ],
        )
