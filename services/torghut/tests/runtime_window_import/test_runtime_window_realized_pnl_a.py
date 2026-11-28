from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from scripts import import_hypothesis_runtime_windows as runtime_import_cli
from scripts.hypothesis_runtime_window_import import cli_parsing as runtime_import_args
from scripts.import_hypothesis_runtime_windows import (
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    _build_realized_strategy_pnl_rows,
    _execution_signed_qty,
    _first_lineage_digest,
    _load_json_artifact,
    _nonnegative_int,
    _row_payloads,
    _runtime_ledger_bucket_profit_proof_present,
    _stable_payload_digest,
    _strategy_name_candidates,
    main,
)
from tests.runtime_window_import.ledger_fixtures import (
    execution_fill,
    march_6_market_hour,
    paper_import_args,
    paper_order_event,
    paper_order_fill,
    strategy_decision_row,
)
from tests.runtime_window_import.runtime_window_import_support import _FakeSession


class TestRuntimeWindowImportRealizedPnlA(TestCase):
    def test_main_requires_source_dsn_or_durable_runtime_ledger_bucket(self) -> None:
        args = paper_import_args(
            run_id="run-missing-source",
            candidate_id="cand-missing-source",
            hypothesis_id="H-CONT-01",
            strategy_family="",
            source_dsn="",
            source_dsn_env="TORGHUT_TEST_MISSING_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            source_manifest_ref="",
            source_kind="",
            delay_adjusted_depth_stress_report_ref="",
            dataset_snapshot_ref="",
            target_metadata_json="",
        )
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v2@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch.object(runtime_import_cli, "_parse_args", return_value=args),
            patch.object(
                runtime_import_cli,
                "resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch.object(
                runtime_import_cli,
                "_runtime_ledger_tca_rows_from_durable_buckets",
                return_value=(
                    [],
                    {
                        "runtime_ledger_durable_bucket_count": 0,
                        "runtime_ledger_durable_bucket_run_ids": [],
                        "runtime_ledger_durable_bucket_fill_count": 0,
                        "runtime_ledger_durable_bucket_tca_row_count": 0,
                        "runtime_ledger_durable_bucket_profit_proof_count": 0,
                    },
                ),
            ),
            patch.object(
                runtime_import_args, "SessionLocal", return_value=_FakeSession()
            ),
            patch.dict("os.environ", {}, clear=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                main()

    def test_json_artifact_and_nonnegative_int_helpers_fail_closed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            invalid_path = Path(temp_dir) / "invalid.json"
            valid_path = Path(temp_dir) / "valid.json"
            invalid_path.write_text("{", encoding="utf-8")
            valid_path.write_text('{"case_count": 2}', encoding="utf-8")

            self.assertEqual(_load_json_artifact(""), {})
            self.assertEqual(_load_json_artifact(str(missing_path)), {})
            self.assertEqual(_load_json_artifact(str(invalid_path)), {})
            self.assertEqual(_load_json_artifact(str(valid_path)), {"case_count": 2})

        self.assertEqual(_nonnegative_int("3.9"), 3)
        self.assertEqual(_nonnegative_int("-2"), 0)
        self.assertEqual(_nonnegative_int("bad"), 0)

    def test_strategy_name_candidates_include_catalog_aliases(self) -> None:
        candidates = _strategy_name_candidates(
            "microbar_volume_continuation_long_top2_chip_v1@paper",
            "microbar-volume-continuation-long-top2-chip-v1",
            "",
            None,
        )

        self.assertEqual(
            candidates,
            [
                "microbar_volume_continuation_long_top2_chip_v1@paper",
                "microbar_volume_continuation_long_top2_chip_v1",
                "microbar-volume-continuation-long-top2-chip-v1@paper",
                "microbar-volume-continuation-long-top2-chip-v1",
            ],
        )

    def test_strategy_name_candidates_drop_blank_values(self) -> None:
        self.assertEqual(_strategy_name_candidates("", "   ", None), [])

    def test_row_payloads_recurses_to_limit_and_ignores_non_mappings(self) -> None:
        self.assertEqual(_row_payloads("not-a-row"), [])

        payloads = _row_payloads(
            {
                "level_1": {
                    "level_2": {
                        "level_3": {
                            "level_4": {
                                "level_5": {"ignored": True},
                            },
                        },
                    },
                },
                "scalar": "ignored",
            }
        )

        self.assertEqual(len(payloads), 5)
        self.assertIn("level_5", payloads[-1])
        self.assertNotIn({"ignored": True}, payloads)

    def test_stable_payload_digest_normalizes_runtime_payload_values(self) -> None:
        class CustomValue:
            def __str__(self) -> str:
                return "custom-value"

        payload = {
            "computed_at": march_6_market_hour(35),
            "notional": Decimal("100.25"),
            "custom": CustomValue(),
        }

        self.assertEqual(
            _stable_payload_digest(payload),
            _stable_payload_digest(
                {
                    "custom": CustomValue(),
                    "notional": Decimal("100.25"),
                    "computed_at": march_6_market_hour(35),
                }
            ),
        )

    def test_first_lineage_digest_prefers_explicit_lineage_payload(self) -> None:
        lineage_payload = {"source": "runtime-ledger", "snapshot": "sim-run-1"}

        self.assertEqual(
            _first_lineage_digest(
                {
                    "source_lineage": lineage_payload,
                    "simulation_context": {"simulation_run_id": "ignored-context"},
                }
            ),
            _stable_payload_digest(lineage_payload),
        )

    def test_execution_signed_qty_accepts_short_and_cover_sides(self) -> None:
        self.assertEqual(
            _execution_signed_qty(side="sell_short", qty=Decimal("3")),
            Decimal("-3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="SELL-SHORT", qty=Decimal("3")),
            Decimal("-3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="buy_to_cover", qty=Decimal("3")),
            Decimal("3"),
        )
        self.assertEqual(
            _execution_signed_qty(side="BUY-TO-COVER", qty=Decimal("3")),
            Decimal("3"),
        )

    def test_build_realized_strategy_pnl_rows_requires_costed_round_trip(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                execution_fill(
                    execution_id="execution-buy",
                    computed_at=march_6_market_hour(35),
                    side="buy",
                    avg_fill_price=Decimal("100"),
                    shortfall_notional=Decimal("99"),
                    cost_amount=Decimal("0.20"),
                    decision_hash="decision-buy",
                    alpaca_order_id="order-buy",
                    execution_tca_metric_id="tca-buy",
                    execution_policy_hash="policy-buy",
                ),
                execution_fill(
                    execution_id="execution-sell",
                    computed_at=march_6_market_hour(40),
                    side="sell",
                    avg_fill_price=Decimal("101"),
                    shortfall_notional=Decimal("99"),
                    cost_amount=Decimal("0.10"),
                    decision_hash="decision-sell",
                    alpaca_order_id="order-sell",
                    execution_tca_metric_id="tca-sell",
                    execution_policy_hash="policy-sell",
                ),
            ]
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(
            rows[0]["promotion_blocker"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertEqual(rows[0]["realized_net_pnl"], Decimal("0.70"))
        self.assertIsNone(rows[0]["post_cost_expectancy_bps"])
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        self.assertIn(
            "runtime_decision_lifecycle_missing",
            rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "submitted_order_lifecycle_missing",
            rows[0]["runtime_ledger_blockers"],
        )
        self.assertIn(
            "fill_order_submission_missing",
            rows[0]["runtime_ledger_blockers"],
        )

    def test_build_realized_strategy_pnl_rows_cannot_materialize_source_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                {
                    "computed_at": march_6_market_hour(35),
                    "symbol": "AAPL",
                    "side": "buy",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("100"),
                    "filled_notional_delta": Decimal("100"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.20"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-buy",
                    "alpaca_order_id": "order-buy",
                    "lineage_hash": "lineage-sha",
                },
                {
                    "computed_at": march_6_market_hour(40),
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": Decimal("1"),
                    "filled_qty_delta": Decimal("1"),
                    "avg_fill_price": Decimal("101"),
                    "filled_notional_delta": Decimal("101"),
                    "fill_quantity_basis": "cumulative_to_delta",
                    "cost_amount": Decimal("0.10"),
                    "cost_basis": "broker_reported_commission_and_fees",
                    "decision_hash": "decision-sell",
                    "alpaca_order_id": "order-sell",
                    "lineage_hash": "lineage-sha",
                },
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertEqual(rows[0]["authoritative"], False)
        self.assertEqual(
            rows[0]["authority_reason"],
            "execution_reconstruction_not_runtime_ledger_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_EXECUTION_RECONSTRUCTION)
        self.assertEqual(bucket["authoritative"], False)
        self.assertNotIn("source_materialization", bucket)
        self.assertIn("runtime_decision_lifecycle_missing", bucket["blockers"])
        self.assertIn("submitted_order_lifecycle_missing", bucket["blockers"])
        self.assertIn("fill_order_submission_missing", bucket["blockers"])
        self.assertIn(
            "execution_reconstruction_not_runtime_ledger_proof",
            bucket["blockers"],
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_build_realized_strategy_pnl_rows_authorizes_event_sourced_lifecycle(
        self,
    ) -> None:
        rows = _build_realized_strategy_pnl_rows(
            [
                execution_fill(
                    computed_at=march_6_market_hour(35),
                    side="buy",
                    filled_qty_delta=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    filled_notional_delta=Decimal("100"),
                    fill_quantity_basis="cumulative_to_delta",
                    cost_amount=Decimal("0.20"),
                    decision_hash="decision-buy",
                    alpaca_order_id="order-buy",
                    execution_tca_metric_id="tca-buy",
                    execution_policy_hash="policy-buy",
                ),
                execution_fill(
                    computed_at=march_6_market_hour(40),
                    side="sell",
                    filled_qty_delta=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    filled_notional_delta=Decimal("101"),
                    fill_quantity_basis="cumulative_to_delta",
                    cost_amount=Decimal("0.10"),
                    decision_hash="decision-sell",
                    alpaca_order_id="order-sell",
                    execution_tca_metric_id="tca-sell",
                    execution_policy_hash="policy-sell",
                ),
            ],
            decision_lifecycle_rows=[
                strategy_decision_row(
                    trade_decision_id="decision-buy-id",
                    computed_at=march_6_market_hour(34),
                    decision_hash="decision-buy",
                    decision_json={"account": {"equity": "10000"}},
                    profit_proof_eligible=True,
                ),
                strategy_decision_row(
                    trade_decision_id="decision-sell-id",
                    computed_at=march_6_market_hour(39),
                    decision_hash="decision-sell",
                    decision_json={"account": {"equity": "10000"}},
                    profit_proof_eligible=True,
                ),
            ],
            order_lifecycle_rows=[
                paper_order_event(
                    execution_order_event_id="event-new-buy",
                    trade_decision_id="decision-buy-id",
                    event_ts=march_6_market_hour(34, 1),
                    event_type="new",
                    decision_hash="decision-buy",
                    alpaca_order_id="order-buy",
                    execution_policy_hash="policy-buy",
                    source_offset=100,
                    source_window_id="source-window-new-buy",
                ),
                paper_order_event(
                    execution_order_event_id="event-new-sell",
                    trade_decision_id="decision-sell-id",
                    event_ts=march_6_market_hour(39, 1),
                    event_type="new",
                    decision_hash="decision-sell",
                    alpaca_order_id="order-sell",
                    execution_policy_hash="policy-sell",
                    source_offset=101,
                    source_window_id="source-window-new-sell",
                ),
                paper_order_fill(
                    execution_order_event_id="event-fill-buy",
                    trade_decision_id="decision-buy-id",
                    execution_id="execution-buy",
                    event_ts=march_6_market_hour(35, 1),
                    event_type="filled",
                    side="buy",
                    avg_fill_price=Decimal("100"),
                    filled_notional_delta=Decimal("100"),
                    cost_amount=Decimal("0.20"),
                    decision_hash="decision-buy",
                    alpaca_order_id="order-buy",
                    execution_policy_hash="policy-buy",
                    source_offset=102,
                    source_window_id="source-window-fill-buy",
                ),
                paper_order_fill(
                    execution_order_event_id="event-fill-sell",
                    trade_decision_id="decision-sell-id",
                    execution_id="execution-sell",
                    event_ts=march_6_market_hour(40, 1),
                    event_type="filled",
                    side="sell",
                    avg_fill_price=Decimal("101"),
                    filled_notional_delta=Decimal("101"),
                    cost_amount=Decimal("0.10"),
                    decision_hash="decision-sell",
                    alpaca_order_id="order-sell",
                    execution_policy_hash="policy-sell",
                    source_offset=103,
                    source_window_id="source-window-fill-sell",
                ),
            ],
            allow_authoritative_runtime_ledger_materialization=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"], POST_COST_BASIS_RUNTIME_LEDGER
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(rows[0]["authoritative"], True)
        self.assertEqual(
            rows[0]["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["blockers"], [])
        self.assertEqual(bucket["pnl_basis"], POST_COST_BASIS_RUNTIME_LEDGER)
        self.assertEqual(bucket["cost_amount"], "0.30")
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(bucket["cost_model_hash_counts"], {"cost-sha": 2})
        self.assertEqual(
            bucket["execution_policy_hash_counts"],
            {"policy-buy": 2, "policy-sell": 2},
        )
        self.assertEqual(bucket["source_materialization"], "execution_order_events")
        self.assertEqual(bucket["account_equity"], "10000")
        self.assertEqual(bucket["account_equity_source"], "equity")
        self.assertEqual(bucket["source_window_start"], "2026-03-06T14:34:01+00:00")
        self.assertEqual(
            bucket["source_window_end"], "2026-03-06T14:40:01.000001+00:00"
        )
        self.assertEqual(
            bucket["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_tca_metrics",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {
                "executions": 2,
                "execution_tca_metrics": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
                "trade_decisions": 2,
            },
        )
        self.assertEqual(
            bucket["source_window_ids"],
            [
                "source-window-new-buy",
                "source-window-new-sell",
                "source-window-fill-buy",
                "source-window-fill-sell",
            ],
        )
        self.assertEqual(
            bucket["execution_order_event_ids"],
            [
                "event-new-buy",
                "event-new-sell",
                "event-fill-buy",
                "event-fill-sell",
            ],
        )
        self.assertEqual(bucket["execution_tca_metric_ids"], ["tca-buy", "tca-sell"])
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(bucket))
