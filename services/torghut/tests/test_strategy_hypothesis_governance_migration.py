from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest import TestCase


def _load_migration_module() -> ModuleType:
    path = (
        Path(__file__).resolve().parents[1]
        / 'migrations'
        / 'versions'
        / '0021_strategy_hypothesis_governance.py'
    )
    spec = importlib.util.spec_from_file_location('torghut_migration_0021', path)
    if spec is None or spec.loader is None:  # pragma: no cover - importlib guard
        raise AssertionError('failed_to_load_migration_0021')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeInspector:
    def __init__(self, tables: dict[str, list[str]]) -> None:
        self._tables = tables

    def has_table(self, table_name: str) -> bool:
        return table_name in self._tables

    def get_indexes(self, table_name: str) -> list[dict[str, str]]:
        return [{'name': name} for name in self._tables.get(table_name, [])]


class _FakeOp:
    def __init__(self) -> None:
        self.create_table_calls: list[str] = []
        self.create_index_calls: list[tuple[str, str]] = []
        self.drop_index_calls: list[tuple[str, str]] = []
        self.drop_table_calls: list[str] = []

    def get_bind(self) -> object:
        return object()

    def create_table(self, table_name: str, *args: object, **kwargs: object) -> None:
        del args, kwargs
        self.create_table_calls.append(table_name)

    def create_index(
        self,
        name: str,
        table_name: str,
        columns: list[str],
        *,
        unique: bool = False,
    ) -> None:
        del columns, unique
        self.create_index_calls.append((name, table_name))

    def drop_index(self, name: str, *, table_name: str) -> None:
        self.drop_index_calls.append((name, table_name))

    def drop_table(self, table_name: str) -> None:
        self.drop_table_calls.append(table_name)


class TestStrategyHypothesisGovernanceMigration(TestCase):
    def test_upgrade_skips_existing_tables_and_indexes(self) -> None:
        module = _load_migration_module()
        fake_op = _FakeOp()
        fake_inspector = _FakeInspector(
            {
                'strategy_hypotheses': [
                    'ix_strategy_hypotheses_hypothesis_id',
                    'ix_strategy_hypotheses_strategy_family',
                ],
                'strategy_hypothesis_versions': [
                    'ix_strategy_hypothesis_versions_hypothesis_id',
                    'uq_strategy_hypothesis_versions_hypothesis_version',
                ],
                'strategy_hypothesis_metric_windows': [
                    'ix_strategy_hypothesis_metric_windows_run_id',
                    'ix_strategy_hypothesis_metric_windows_candidate_id',
                    'ix_strategy_hypothesis_metric_windows_hypothesis_id',
                    'ix_strategy_hypothesis_metric_windows_observed_stage',
                ],
                'strategy_capital_allocations': [
                    'ix_strategy_capital_allocations_run_id',
                    'ix_strategy_capital_allocations_candidate_id',
                    'ix_strategy_capital_allocations_hypothesis_id',
                ],
                'strategy_promotion_decisions': [
                    'ix_strategy_promotion_decisions_run_id',
                    'ix_strategy_promotion_decisions_candidate_id',
                    'ix_strategy_promotion_decisions_hypothesis_id',
                    'uq_strategy_promotion_decisions_run_hypothesis_target',
                ],
            }
        )
        original_op = module.op
        original_inspect = module.inspect
        try:
            module.op = fake_op
            module.inspect = lambda bind: fake_inspector
            module.upgrade()
        finally:
            module.op = original_op
            module.inspect = original_inspect

        self.assertEqual(fake_op.create_table_calls, [])
        self.assertEqual(fake_op.create_index_calls, [])

    def test_downgrade_skips_absent_tables_and_indexes(self) -> None:
        module = _load_migration_module()
        fake_op = _FakeOp()
        fake_inspector = _FakeInspector({})
        original_op = module.op
        original_inspect = module.inspect
        try:
            module.op = fake_op
            module.inspect = lambda bind: fake_inspector
            module.downgrade()
        finally:
            module.op = original_op
            module.inspect = original_inspect

        self.assertEqual(fake_op.drop_index_calls, [])
        self.assertEqual(fake_op.drop_table_calls, [])
