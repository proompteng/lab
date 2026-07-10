from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

from app.trading.scheduler.pipeline import TradingPipeline


def _pipeline() -> tuple[TradingPipeline, MagicMock]:
    pipeline = TradingPipeline.__new__(TradingPipeline)
    session = MagicMock()
    session_scope = MagicMock()
    session_scope.__enter__.return_value = session
    pipeline.session_factory = Mock(return_value=session_scope)
    pipeline.state = SimpleNamespace(
        emergency_stop_active=False,
        metrics=SimpleNamespace(planned_decision_age_seconds=0),
    )
    pipeline.capital_safety = Mock()
    pipeline._label_mature_rejected_signal_outcome_events = Mock()
    pipeline._prepare_run_once = Mock()
    pipeline._get_account_snapshot = Mock(return_value=object())
    return pipeline, session


def test_capital_safety_runs_when_no_strategy_is_enabled() -> None:
    pipeline, session = _pipeline()
    pipeline._load_strategies = Mock(return_value=[])

    pipeline.run_once()

    pipeline.capital_safety.evaluate.assert_called_once_with(
        session, pipeline._get_account_snapshot.return_value
    )
    session.commit.assert_called_once_with()


def test_capital_safety_runs_before_empty_signal_exit() -> None:
    pipeline, session = _pipeline()
    events: list[str] = []
    pipeline.capital_safety.evaluate.side_effect = lambda *_args: events.append(
        "capital_safety"
    )
    session.commit.side_effect = lambda: events.append("capital_safety_commit")
    pipeline._load_strategies = Mock(return_value=[object()])
    pipeline._warm_session_context_from_open = Mock()
    pipeline.ingestor = Mock()
    pipeline.ingestor.fetch_signals.side_effect = lambda _session: (
        events.append("fetch_signals") or SimpleNamespace(signals=[])
    )
    pipeline._record_ingest_window = Mock()
    pipeline._prepare_batch_for_decisions = Mock(return_value=False)

    pipeline.run_once()

    assert events == ["capital_safety", "capital_safety_commit", "fetch_signals"]
