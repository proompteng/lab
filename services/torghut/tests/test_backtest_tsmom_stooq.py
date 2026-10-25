from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.trading.alpha.tsmom import TSMOMConfig
from scripts import backtest_tsmom_stooq as cli


def test_main_serializes_config_from_dataclass_payload(
    monkeypatch: Any, tmp_path: Path
) -> None:
    output_path = tmp_path / "summary.json"
    index = pd.to_datetime(["2026-01-01", "2026-01-02"])

    monkeypatch.setattr(
        cli,
        "parse_args",
        lambda: argparse.Namespace(
            symbols="spy.us",
            start="2026-01-01",
            end="2026-01-02",
            lookback=3,
            vol_lookback=2,
            target_vol=0.02,
            max_gross=1.5,
            allow_shorts=True,
            cost_bps=7.5,
            json=str(output_path),
            csv=None,
        ),
    )
    monkeypatch.setattr(
        cli,
        "fetch_stooq_daily",
        lambda *_args, **_kwargs: argparse.Namespace(
            close=pd.Series([100.0, 101.0], index=index)
        ),
    )

    def fake_backtest(
        prices: pd.DataFrame, config: TSMOMConfig
    ) -> tuple[pd.Series, pd.DataFrame]:
        assert list(prices.columns) == ["spy.us"]
        assert config.start is not None
        assert config.end is not None
        return (
            pd.Series([1.0, 1.1], index=index, name="equity"),
            pd.DataFrame(index=index),
        )

    monkeypatch.setattr(cli, "backtest_tsmom", fake_backtest)
    monkeypatch.setattr(cli, "summarize_equity_curve", lambda _equity: {"sharpe": 1})
    monkeypatch.setattr(cli, "to_jsonable", lambda summary: summary)

    assert cli.main() == 0

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["config"] == {
        "cost_bps_per_turnover": 7.5,
        "end": "2026-01-02",
        "long_only": False,
        "lookback_days": 3,
        "max_gross_leverage": 1.5,
        "start": "2026-01-01",
        "target_daily_vol": 0.02,
        "vol_lookback_days": 2,
    }
    assert payload["summary"] == {"sharpe": 1}
