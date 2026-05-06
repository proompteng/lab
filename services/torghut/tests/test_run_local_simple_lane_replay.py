from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import config
from app.models import Base, Execution, Strategy, TradeDecision
from app.trading.models import SignalEnvelope
from scripts import run_local_simple_lane_replay


def test_default_replay_universe_is_live_chip_coverage() -> None:
    assert run_local_simple_lane_replay.DEFAULT_SYMBOLS == [
        "NVDA",
        "TSM",
        "AVGO",
        "AMD",
        "MU",
        "TXN",
        "ADI",
        "LRCX",
        "KLAC",
        "QCOM",
        "AMAT",
        "ASML",
    ]


class _FakeAdapter:
    def __init__(self) -> None:
        self.positions: list[dict[str, str]] = [
            {"market_value": "250"},
            {"market_value": "not-a-number"},
            {},
        ]
        self.cancelled: list[str] = []
        self.cancelled_all = False

    def list_positions(self) -> list[dict[str, str]]:
        return self.positions

    def submit_order(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None,
        stop_price: float | None,
        extra_params: dict[str, object] | None,
    ) -> dict[str, str]:
        _ = (symbol, order_type, time_in_force, limit_price, stop_price, extra_params)
        return {
            "id": f"{side}-order",
            "qty": str(qty),
            "filled_qty": str(qty),
            "filled_avg_price": "10",
        }

    def cancel_order(self, alpaca_order_id: str) -> bool:
        self.cancelled.append(alpaca_order_id)
        return True

    def cancel_all_orders(self) -> list[dict[str, str]]:
        self.cancelled_all = True
        return [{"id": "cancelled"}]

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, str]:
        return {"client_order_id": client_order_id}

    def get_order(self, alpaca_order_id: str) -> dict[str, str]:
        return {"id": alpaca_order_id}

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        return [{"status": status}]


def test_local_simulation_broker_tracks_cash_and_delegates_orders() -> None:
    adapter = _FakeAdapter()
    broker = run_local_simple_lane_replay.LocalSimulationBroker(
        adapter=adapter, initial_cash=Decimal("1000"), allow_shorts=False
    )

    account = broker.get_account()
    assert account["equity"] == "1250"
    assert account["buying_power"] == "1250"
    assert account["shorting_enabled"] is False
    assert broker.get_asset("NVDA") == {
        "symbol": "NVDA",
        "tradable": True,
        "shortable": False,
    }

    broker.submit_order("NVDA", "buy", 2, "limit", "day", limit_price=100)
    assert broker.get_account()["cash"] == "980"

    broker.submit_order("NVDA", "sell", 1, "limit", "day", limit_price=100)
    assert broker.get_account()["cash"] == "990"
    assert broker.cancel_order("order-1") is True
    assert adapter.cancelled == ["order-1"]
    assert broker.cancel_all_orders() == [{"id": "cancelled"}]
    assert broker.get_order_by_client_order_id("client-1") == {
        "client_order_id": "client-1"
    }
    assert broker.get_order("order-2") == {"id": "order-2"}
    assert broker.list_orders(status="open") == [{"status": "open"}]


def test_parse_args_uses_chip_universe_defaults() -> None:
    with patch(
        "sys.argv",
        ["run_local_simple_lane_replay.py", "--clickhouse-password", "secret"],
    ):
        args = run_local_simple_lane_replay.parse_args()

    assert args.symbols == ",".join(run_local_simple_lane_replay.DEFAULT_SYMBOLS)
    assert args.clickhouse_transport == "kubectl"
    assert args.allow_shorts is True


def test_load_enabled_strategies_filters_configmap_catalog(tmp_path) -> None:
    path = tmp_path / "strategy-configmap.yaml"
    path.write_text(
        """
data:
  strategies.yaml: |
    strategies:
      - name: enabled
        enabled: true
      - name: disabled
        enabled: false
      - invalid
""",
        encoding="utf-8",
    )

    strategies = run_local_simple_lane_replay._load_enabled_strategies(path)

    assert [strategy["name"] for strategy in strategies] == ["enabled"]


def test_configure_replay_settings_wires_static_allowlist() -> None:
    originals = {
        "trading_enabled": config.settings.trading_enabled,
        "trading_mode": config.settings.trading_mode,
        "trading_live_enabled": config.settings.trading_live_enabled,
        "trading_pipeline_mode": config.settings.trading_pipeline_mode,
        "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
        "trading_simple_order_feed_telemetry_enabled": (
            config.settings.trading_simple_order_feed_telemetry_enabled
        ),
        "trading_simple_max_notional_per_order": (
            config.settings.trading_simple_max_notional_per_order
        ),
        "trading_simple_max_notional_per_symbol": (
            config.settings.trading_simple_max_notional_per_symbol
        ),
        "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
        "trading_emergency_stop_enabled": config.settings.trading_emergency_stop_enabled,
        "trading_universe_source": config.settings.trading_universe_source,
        "trading_universe_static_fallback_enabled": (
            config.settings.trading_universe_static_fallback_enabled
        ),
        "trading_universe_static_fallback_symbols_raw": (
            config.settings.trading_universe_static_fallback_symbols_raw
        ),
        "trading_allow_shorts": config.settings.trading_allow_shorts,
        "trading_fractional_equities_enabled": (
            config.settings.trading_fractional_equities_enabled
        ),
        "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
        "trading_strategy_scheduler_enabled": (
            config.settings.trading_strategy_scheduler_enabled
        ),
        "trading_strategy_runtime_mode": config.settings.trading_strategy_runtime_mode,
        "llm_enabled": config.settings.llm_enabled,
    }
    try:
        run_local_simple_lane_replay._configure_replay_settings(
            symbols=["NVDA", "AVGO"],
            max_notional_per_order=Decimal("100"),
            max_notional_per_symbol=Decimal("250"),
            allow_shorts=False,
        )

        assert config.settings.trading_enabled is True
        assert config.settings.trading_mode == "paper"
        assert config.settings.trading_pipeline_mode == "simple"
        assert config.settings.trading_universe_source == "jangar"
        assert (
            config.settings.trading_universe_static_fallback_symbols_raw == "NVDA,AVGO"
        )
        assert config.settings.trading_simple_max_notional_per_order == 100.0
        assert config.settings.trading_simple_max_notional_per_symbol == 250.0
        assert config.settings.trading_allow_shorts is False
        assert config.settings.llm_enabled is False
    finally:
        for key, value in originals.items():
            setattr(config.settings, key, value)


def test_fetch_signals_adaptive_splits_failed_window() -> None:
    start = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
    end = datetime(2026, 3, 26, 13, 32, tzinfo=timezone.utc)
    with patch(
        "scripts.run_local_simple_lane_replay._fetch_signals_window",
        side_effect=[RuntimeError("wide"), ["left"], ["right"]],
    ) as fetch_window:
        signals = run_local_simple_lane_replay._fetch_signals_adaptive(
            ingestor=object(),
            symbol="NVDA",
            start=start,
            end=end,
            min_split_seconds=30,
            clickhouse_transport="http",
            clickhouse_namespace="torghut",
            clickhouse_pod="clickhouse-0",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_table="torghut.ta_signals",
        )

    assert signals == ["left", "right"]
    assert fetch_window.call_count == 3


def test_fetch_signals_adaptive_raises_when_min_window_fails() -> None:
    start = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
    end = datetime(2026, 3, 26, 13, 30, 30, tzinfo=timezone.utc)
    with (
        patch(
            "scripts.run_local_simple_lane_replay._fetch_signals_window",
            side_effect=RuntimeError("down"),
        ),
        patch("scripts.run_local_simple_lane_replay.logger.warning") as warning,
    ):
        try:
            run_local_simple_lane_replay._fetch_signals_adaptive(
                ingestor=object(),
                symbol="NVDA",
                start=start,
                end=end,
                min_split_seconds=30,
                clickhouse_transport="http",
                clickhouse_namespace="torghut",
                clickhouse_pod="clickhouse-0",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                clickhouse_table="torghut.ta_signals",
            )
        except RuntimeError as exc:
            assert "Failed to fetch NVDA signals" in str(exc)
        else:
            raise AssertionError("expected RuntimeError")

    warning.assert_not_called()


def test_fetch_signals_window_supports_http_and_kubectl_paths() -> None:
    signal = SignalEnvelope(
        event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
        symbol="NVDA",
        seq=1,
    )

    class _Ingestor:
        def fetch_signals_between(
            self, start: datetime, end: datetime, *, symbol: str
        ) -> list[SignalEnvelope]:
            _ = (start, end, symbol)
            return [signal]

        def parse_row(self, row: dict[str, object]) -> SignalEnvelope | None:
            _ = row
            return signal

        def _dedupe_signals(
            self, signals: list[SignalEnvelope]
        ) -> list[SignalEnvelope]:
            return signals

        def _filter_signals(
            self, signals: list[SignalEnvelope]
        ) -> list[SignalEnvelope]:
            return signals

        def _sorted_signals(
            self, signals: list[SignalEnvelope]
        ) -> list[SignalEnvelope]:
            return sorted(signals, key=run_local_simple_lane_replay._signal_sort_key)

    start = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
    end = datetime(2026, 3, 26, 13, 31, tzinfo=timezone.utc)
    assert run_local_simple_lane_replay._fetch_signals_window(
        ingestor=_Ingestor(),
        symbol="NVDA",
        start=start,
        end=end,
        clickhouse_transport="http",
        clickhouse_namespace="torghut",
        clickhouse_pod="clickhouse-0",
        clickhouse_username="torghut",
        clickhouse_password="secret",
        clickhouse_table="torghut.ta_signals",
    ) == [signal]

    with patch(
        "scripts.run_local_simple_lane_replay._fetch_rows_via_kubectl",
        return_value=[{"symbol": "NVDA"}],
    ):
        assert run_local_simple_lane_replay._fetch_signals_window(
            ingestor=_Ingestor(),
            symbol="NVDA",
            start=start,
            end=end,
            clickhouse_transport="kubectl",
            clickhouse_namespace="torghut",
            clickhouse_pod="clickhouse-0",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_table="torghut.ta_signals",
        ) == [signal]


def test_fetch_rows_via_kubectl_parses_json_each_row() -> None:
    completed = SimpleNamespace(
        returncode=0,
        stdout='{"symbol":"NVDA"}\n\n{"symbol":"AVGO"}\n',
        stderr="",
    )
    with patch(
        "scripts.run_local_simple_lane_replay.subprocess.run",
        return_value=completed,
    ) as run:
        rows = run_local_simple_lane_replay._fetch_rows_via_kubectl(
            symbol="NVDA",
            start=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            end=datetime(2026, 3, 26, 13, 31, tzinfo=timezone.utc),
            clickhouse_namespace="torghut",
            clickhouse_pod="clickhouse-0",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_table="torghut.ta_signals",
        )

    assert rows == [{"symbol": "NVDA"}, {"symbol": "AVGO"}]
    query = run.call_args.args[0][-1]
    assert "SELECT event_ts, ingest_ts, symbol" in query
    assert "WHERE symbol = 'NVDA'" in query


def test_fetch_rows_via_kubectl_raises_trimmed_error() -> None:
    completed = SimpleNamespace(returncode=1, stdout="", stderr="x" * 500)
    with patch(
        "scripts.run_local_simple_lane_replay.subprocess.run",
        return_value=completed,
    ):
        try:
            run_local_simple_lane_replay._fetch_rows_via_kubectl(
                symbol="NVDA",
                start=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
                end=datetime(2026, 3, 26, 13, 31, tzinfo=timezone.utc),
                clickhouse_namespace="torghut",
                clickhouse_pod="clickhouse-0",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                clickhouse_table="torghut.ta_signals",
            )
        except RuntimeError as exc:
            assert str(exc) == "x" * 400
        else:
            raise AssertionError("expected RuntimeError")


def test_bucket_helpers_group_and_sort_signals() -> None:
    early = SignalEnvelope(
        event_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
        symbol="AVGO",
        seq=2,
    )
    later = SignalEnvelope(
        event_ts=datetime(2026, 3, 26, 13, 31, 5, tzinfo=timezone.utc),
        symbol="NVDA",
        seq=1,
    )

    assert run_local_simple_lane_replay._parse_timestamp("2026-03-26T13:30:00Z") == (
        datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
    )
    assert run_local_simple_lane_replay._to_ch_datetime64(early.event_ts) == (
        "toDateTime64('2026-03-26 13:30:05.000', 3, 'UTC')"
    )
    assert run_local_simple_lane_replay._bucket_signals(
        [later, early], bucket_seconds=60
    ) == [[later], [early]]
    assert run_local_simple_lane_replay._signal_sort_key(early) < (
        run_local_simple_lane_replay._signal_sort_key(later)
    )


def test_build_and_write_artifacts_summarizes_replay_activity(tmp_path) -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with session_local() as session:
        strategy = Strategy(
            name="chip-breakout",
            description="",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["NVDA"],
        )
        session.add(strategy)
        session.flush()
        session.add_all(
            [
                TradeDecision(
                    strategy_id=strategy.id,
                    symbol="NVDA",
                    timeframe="1Sec",
                    status="submitted",
                    decision_json={
                        "params": {
                            "execution_lane": "simple",
                            "submit_path": "direct_alpaca",
                        },
                        "risk_reasons": ["insufficient_buying_power"],
                    },
                ),
                TradeDecision(
                    strategy_id=strategy.id,
                    symbol="AVGO",
                    timeframe="1Sec",
                    status="blocked",
                    decision_json={"submission_block_reason": "capital_stage_shadow"},
                ),
                TradeDecision(
                    strategy_id=strategy.id,
                    symbol="AMD",
                    timeframe="1Sec",
                    status="rejected",
                    decision_json={"risk_reasons": ["unexpected_reason"]},
                ),
                Execution(
                    alpaca_order_id="order-1",
                    client_order_id="client-1",
                    symbol="NVDA",
                    side="buy",
                    order_type="limit",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    status="filled",
                    raw_order={},
                ),
            ]
        )
        session.commit()

    pipeline = SimpleNamespace(
        state=SimpleNamespace(
            metrics=SimpleNamespace(
                orders_submitted_total=1,
                orders_rejected_total=1,
                decisions_total=3,
                reconcile_updates_total=2,
            )
        )
    )
    artifacts = run_local_simple_lane_replay._build_artifacts(
        session_local=session_local,
        pipeline=pipeline,
        output_dir=tmp_path,
        start=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
        end=datetime(2026, 3, 26, 20, 0, tzinfo=timezone.utc),
        symbols=["NVDA", "AVGO"],
        strategies=[{"name": "chip-breakout"}],
        signal_fetch_counts={"NVDA": 10},
        total_signals=10,
        replay_buckets=2,
        reconcile_updates=2,
    )

    assert artifacts.replay_report["orders_submitted_total"] == 1
    assert artifacts.decision_activity["execution_lane_totals"] == {"simple": 1}
    assert artifacts.run_summary["acceptance"]["passed"] is False
    assert artifacts.run_summary["acceptance"]["governance_blockers"] == [
        "capital_stage_shadow"
    ]
    assert artifacts.run_summary["acceptance"]["invalid_reject_reasons"] == [
        "unexpected_reason"
    ]

    run_local_simple_lane_replay._write_artifacts(
        output_dir=tmp_path, artifacts=artifacts
    )
    assert (
        json.loads((tmp_path / "run-summary.json").read_text())["signals_total"] == 10
    )
