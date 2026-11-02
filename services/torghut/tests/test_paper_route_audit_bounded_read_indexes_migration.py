from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0045_paper_route_audit_bounded_read_indexes.py"


class TestPaperRouteAuditBoundedReadIndexesMigration(TestCase):
    def test_index_names_fit_postgres_identifier_limit(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        for index_name, _table_name, _columns in module._INDEXES:
            self.assertLessEqual(len(index_name), 63, index_name)

    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(
            module.revision,
            "0045_paper_route_audit_bounded_read_indexes",
        )
        self.assertEqual(
            module.down_revision,
            "0044_order_feed_source_window_consumer_scope_index",
        )

    def test_upgrade_adds_source_proof_read_indexes(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = []

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "create_index") as create_index,
        ):
            module.upgrade()

        created_names = [call.args[0] for call in create_index.call_args_list]
        self.assertIn(
            "ix_trade_decisions_account_created_strategy_symbol",
            created_names,
        )
        self.assertIn(
            "ix_execution_tca_metrics_trade_decision_id",
            created_names,
        )
        self.assertIn(
            "ix_strategy_runtime_ledger_buckets_hyp_run_cand_stage_ended",
            created_names,
        )

    def test_downgrade_drops_source_proof_read_indexes(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.side_effect = [
            [{"name": index_name}]
            for index_name, _table_name, _columns in module._INDEXES
        ][::-1]

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "drop_index") as drop_index,
        ):
            module.downgrade()

        dropped_names = [call.args[0] for call in drop_index.call_args_list]
        self.assertIn(
            "ix_trade_decisions_account_created_strategy_symbol",
            dropped_names,
        )
        self.assertIn(
            "ix_execution_tca_metrics_trade_decision_id",
            dropped_names,
        )
