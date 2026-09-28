from __future__ import annotations

import importlib
import json
import os
import sys
from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Iterator, Protocol, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.options_lane.alpaca import (
    OptionsContractsQuery,
    normalize_contract_record,
    normalize_snapshot_record,
)
from app.options_lane.catalog_watermark_repository import CatalogCycleSummary
from app.options_lane.options_status import build_status_payload
from app.options_lane.repository import (
    OptionsRepository,
    SubscriptionReconcileResult,
    merge_top_ranked_contract_rows,
    ranked_contract_rows,
    top_ranked_contract_rows,
)
from app.options_lane.settings import OptionsLaneSettings
from app.options_lane.session import session_state


class _FakeScalarResult:
    def __init__(self, value: int) -> None:
        self._value = value

    def scalar_one(self) -> int:
        return self._value


class _FakeBegin:
    def __enter__(self) -> _FakeBegin:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class _FakeCountSession:
    def __init__(self, *, value: int = 0, fail_count: bool = False) -> None:
        self.value = value
        self.fail_count = fail_count
        self.statements: list[str] = []

    def begin(self) -> _FakeBegin:
        return _FakeBegin()

    def execute(self, statement: object) -> _FakeScalarResult:
        sql = str(statement)
        self.statements.append(sql)
        if "SET LOCAL statement_timeout" not in sql and self.fail_count:
            raise SQLAlchemyError("timeout")
        return _FakeScalarResult(self.value)


class _FakeCountRepository(OptionsRepository):
    def __init__(self, session: _FakeCountSession) -> None:
        self.fake_session = session

    @contextmanager
    def session(self) -> Iterator[Session]:
        yield cast(Session, self.fake_session)


class _FakeWriteResult:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount


class _FakeWriteSession:
    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, object]]] = []

    def begin(self) -> _FakeBegin:
        return _FakeBegin()

    def execute(
        self, statement: object, parameters: dict[str, object] | None = None
    ) -> _FakeWriteResult:
        sql = str(statement)
        self.statements.append((sql, parameters or {}))
        return _FakeWriteResult(2 if "INSERT INTO" in sql else 1)


class _FakeWriteRepository(OptionsRepository):
    def __init__(self, session: _FakeWriteSession) -> None:
        self.fake_session = session

    @contextmanager
    def session(self) -> Iterator[Session]:
        yield cast(Session, self.fake_session)


class _NoCountRepository:
    active_count_calls = 0
    hot_count_calls = 0

    def __init__(self, _: str) -> None:
        pass

    def ensure_rate_bucket_defaults(
        self, defaults: dict[str, tuple[float, int]]
    ) -> None:
        self.defaults = defaults

    def count_active_contracts(self) -> int:
        type(self).active_count_calls += 1
        raise AssertionError("heartbeat status must not count active contracts")

    def count_hot_contracts(self) -> int:
        type(self).hot_count_calls += 1
        raise AssertionError("heartbeat status must not count hot contracts")


class _FakeProducer:
    sent: list[tuple[str, str, dict[str, object]]] = []

    def __init__(self, **_: object) -> None:
        pass

    def send(self, topic: str, key: str, payload: dict[str, object]) -> None:
        type(self).sent.append((topic, key, payload))

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass


class _FakeAlpacaClient:
    def __init__(self, **_: object) -> None:
        pass


class _PartialCatalogClient:
    def __init__(self) -> None:
        self.calls = 0

    def list_contracts(self, **_: object) -> tuple[list[dict[str, object]], str]:
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("provider interrupted after first page")
        return (
            [
                {
                    "id": "contract-new",
                    "symbol": "MSFT260717C00400000",
                    "status": "active",
                    "expiration_date": "2026-07-17",
                    "root_symbol": "MSFT",
                    "underlying_symbol": "MSFT",
                    "type": "call",
                    "style": "american",
                    "strike_price": "400",
                    "size": "100",
                    "open_interest": "1",
                }
            ],
            "next-page",
        )


class _CompleteCatalogClient:
    def __init__(self) -> None:
        self.request: dict[str, object] = {}

    def list_contracts(self, **request: object) -> tuple[list[dict[str, object]], None]:
        self.request = request
        return (
            [
                {
                    "id": "contract-aapl",
                    "symbol": "AAPL260717C00200000",
                    "status": "active",
                    "expiration_date": "2026-07-17",
                    "root_symbol": "AAPL",
                    "underlying_symbol": "AAPL",
                    "type": "call",
                    "style": "american",
                    "strike_price": "200",
                    "size": "100",
                    "open_interest": "100",
                }
            ],
            None,
        )


class _SeededCycleRepository:
    def __init__(self) -> None:
        self.reconciliations: list[tuple[list[str], set[str]]] = []
        self.completed_cycles: list[CatalogCycleSummary] = []

    def list_live_subscription_candidates(self, **_: object) -> list[dict[str, object]]:
        return [
            {
                "contract_symbol": "AAPL260717C00200000",
                "status": "active",
                "underlying_symbol": "AAPL",
                "expiration_date": date(2026, 7, 17),
                "strike_price": 200.0,
                "close_price": 200.0,
                "open_interest": 100,
                "ranking_inputs": {},
                "tier": "hot",
            },
            {
                "contract_symbol": "ARCHIVE260717P00100000",
                "status": "active",
                "underlying_symbol": "ARCHIVE",
                "expiration_date": date(2026, 7, 17),
                "strike_price": 100.0,
                "close_price": 100.0,
                "open_interest": 1_000,
                "ranking_inputs": {},
                "tier": "cold",
            },
        ]

    def acquire_rate_bucket(self, *_: object) -> bool:
        return True

    def list_non_off_subscription_symbols(self) -> set[str]:
        return {
            "AAPL260717C00200000",
            "ARCHIVE260717P00100000",
        }

    def list_cold_subscription_symbols(self, **_: object) -> frozenset[str]:
        return frozenset({"ARCHIVE260717P00100000"})

    def sync_contract_catalog_page(
        self, *_: object, **__: object
    ) -> list[dict[str, object]]:
        return []

    def mark_contracts_missing_from_cycle(self, **_: object) -> list[dict[str, object]]:
        return []

    def iter_active_contracts_for_ranking(
        self, **_: object
    ) -> Iterator[dict[str, object]]:
        yield {
            "contract_symbol": "AAPL260717C00200000",
            "status": "active",
            "underlying_symbol": "AAPL",
            "expiration_date": date(2026, 7, 17),
            "strike_price": 200.0,
            "close_price": 200.0,
            "open_interest": 100,
            "ranking_inputs": {},
        }

    def max_active_open_interest(self, **_: object) -> int:
        return 100

    def write_subscription_state(
        self,
        *,
        ranked_rows: list[dict[str, object]],
        deactivate_symbols: set[str],
        observed_at: datetime,
    ) -> SubscriptionReconcileResult:
        del observed_at
        self.reconciliations.append(
            (
                [str(row["contract_symbol"]) for row in ranked_rows],
                set(deactivate_symbols),
            )
        )
        return SubscriptionReconcileResult(
            hot_count=sum(row["tier"] == "hot" for row in ranked_rows),
            warm_count=sum(row["tier"] == "warm" for row in ranked_rows),
            changed_count=len(ranked_rows),
            deactivated_count=len(deactivate_symbols),
        )

    def record_catalog_cycle_success(self, summary: CatalogCycleSummary) -> None:
        self.completed_cycles.append(summary)


class _CatalogStatusServiceModule(Protocol):
    def _publish_status(
        self,
        *,
        status_value: str,
        observed_at: datetime,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> None: ...


class _CatalogDiscoveryState(Protocol):
    def snapshot(self) -> dict[str, object]: ...


class _CatalogDiscoveryServiceModule(Protocol):
    _repository: object
    _client: object
    _state: _CatalogDiscoveryState

    def _run_discovery_cycle(self) -> None: ...


class _EnricherStatusServiceModule(Protocol):
    def _publish_status(
        self,
        *,
        status_value: str,
        observed_at: datetime,
        error_code: str | None = None,
        error_detail: str | None = None,
        backlog: int | None = None,
    ) -> None: ...


class TestOptionsLaneSession(TestCase):
    def test_session_state_classifies_regular_hours(self) -> None:
        now = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(session_state(now), "regular")

    def test_session_state_classifies_weekend(self) -> None:
        now = datetime(2026, 3, 8, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(session_state(now), "weekend")


class TestOptionsLaneSettings(TestCase):
    @patch.dict(
        os.environ,
        {
            "DB_DSN": "postgresql://torghut:torghut@localhost:5432/torghut",
            "ALPACA_OPTIONS_KEY_ID": "key-id",
            "ALPACA_OPTIONS_SECRET_KEY": "secret-key",
            "OPTIONS_MARKET_HOLIDAYS": "",
            "OPTIONS_LIVE_UNDERLYING_SYMBOLS": "nvda,AMD,nvda",
            "OPTIONS_UNDERLYING_PRIORITY_SYMBOLS": "",
        },
        clear=True,
    )
    def test_settings_accept_blank_csv_lists(self) -> None:
        settings = OptionsLaneSettings()

        self.assertEqual(
            settings.sqlalchemy_dsn,
            "postgresql+psycopg://torghut:torghut@localhost:5432/torghut",
        )
        self.assertEqual(settings.options_contract_discovery_page_limit, 10000)
        self.assertEqual(settings.options_contract_expiration_horizon_days, 120)
        self.assertEqual(
            settings.options_live_underlying_symbols, ["NVDA", "AMD", "NVDA"]
        )
        self.assertEqual(settings.options_market_holidays, [])
        self.assertEqual(settings.options_underlying_priority_symbols, [])

    @patch.dict(
        os.environ,
        {
            "DB_DSN": "postgresql://torghut:torghut@localhost:5432/torghut",
            "ALPACA_OPTIONS_KEY_ID": "key-id",
            "ALPACA_OPTIONS_SECRET_KEY": "secret-key",
            "OPTIONS_CONTRACT_ARCHIVE_STATEMENT_TIMEOUT_MS": "5000",
            "OPTIONS_CONTRACT_ARCHIVE_LOCK_TIMEOUT_MS": "5000",
        },
        clear=True,
    )
    def test_settings_reject_archive_lock_timeout_at_statement_timeout(self) -> None:
        with self.assertRaisesRegex(ValueError, "lock timeout must be below"):
            OptionsLaneSettings()


class TestOptionsRepositoryStatusCounts(TestCase):
    def test_count_active_contracts_uses_bounded_statement_timeout(self) -> None:
        session = _FakeCountSession(value=42)
        repo = _FakeCountRepository(session)

        self.assertEqual(repo.count_active_contracts(), 42)

        self.assertTrue(
            any(
                "SET LOCAL statement_timeout = 500" in sql for sql in session.statements
            )
        )
        self.assertTrue(
            any(
                "torghut_options_active_contract_catalog" in sql
                for sql in session.statements
            )
        )

    def test_count_hot_contracts_returns_none_when_telemetry_count_times_out(
        self,
    ) -> None:
        session = _FakeCountSession(fail_count=True)
        repo = _FakeCountRepository(session)

        self.assertIsNone(repo.count_hot_contracts())

        self.assertTrue(
            any(
                "SET LOCAL statement_timeout = 500" in sql for sql in session.statements
            )
        )
        self.assertTrue(
            any(
                "torghut_options_subscription_state" in sql
                for sql in session.statements
            )
        )


class TestOptionsRepositorySubscriptionReconciliation(TestCase):
    def test_reconciliation_uses_one_conditional_upsert_and_explicit_deactivation(
        self,
    ) -> None:
        session = _FakeWriteSession()
        repo = _FakeWriteRepository(session)
        observed_at = datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc)

        result = repo.write_subscription_state(
            ranked_rows=[
                {
                    "contract_symbol": "AAPL260717C00200000",
                    "ranking_score": 0.91,
                    "ranking_inputs": {"liquidity_score": 1.0},
                    "tier": "hot",
                    "desired_channels": ["trades", "quotes"],
                    "provider_cap_generation": 200,
                },
                {
                    "contract_symbol": "MSFT260717P00400000",
                    "ranking_score": 0.72,
                    "ranking_inputs": {"liquidity_score": 0.5},
                    "tier": "warm",
                    "desired_channels": ["trades", "quotes"],
                    "provider_cap_generation": 200,
                },
            ],
            deactivate_symbols={"STALE260717C00100000"},
            observed_at=observed_at,
        )

        self.assertEqual(len(session.statements), 2)
        upsert_sql, upsert_parameters = session.statements[0]
        deactivate_sql, deactivate_parameters = session.statements[1]
        self.assertIn("jsonb_array_elements", upsert_sql)
        self.assertIn("IS DISTINCT FROM", upsert_sql)
        self.assertNotIn("contract_symbol <> ALL", upsert_sql)
        self.assertEqual(
            json.loads(cast(str, upsert_parameters["ranked_rows"]))[0][
                "contract_symbol"
            ],
            "AAPL260717C00200000",
        )
        self.assertIn("contract_symbol = ANY", deactivate_sql)
        self.assertIn("tier IS DISTINCT FROM 'off'", deactivate_sql)
        self.assertNotIn("contract_symbol <> ALL", deactivate_sql)
        self.assertEqual(deactivate_parameters["symbols"], ["STALE260717C00100000"])
        self.assertEqual(result.hot_count, 1)
        self.assertEqual(result.warm_count, 1)
        self.assertEqual(result.changed_count, 2)
        self.assertEqual(result.deactivated_count, 1)

    def test_reconciliation_skips_deactivation_statement_without_displacements(
        self,
    ) -> None:
        session = _FakeWriteSession()
        repo = _FakeWriteRepository(session)

        repo.write_subscription_state(
            ranked_rows=[
                {
                    "contract_symbol": "AAPL260717C00200000",
                    "ranking_score": 0.91,
                    "ranking_inputs": {},
                    "tier": "hot",
                    "desired_channels": ["trades", "quotes"],
                    "provider_cap_generation": 200,
                }
            ],
            deactivate_symbols=set(),
            observed_at=datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(len(session.statements), 1)
        self.assertNotIn(
            "UPDATE torghut_options_subscription_state", session.statements[0][0]
        )


class TestOptionsServiceStatusHeartbeat(TestCase):
    def setUp(self) -> None:
        _NoCountRepository.active_count_calls = 0
        _NoCountRepository.hot_count_calls = 0
        _FakeProducer.sent = []
        for module_name in (
            "app.options_lane.catalog_service",
            "app.options_lane.enricher_service",
        ):
            sys.modules.pop(module_name, None)

    def _import_service(self, module_name: str) -> object:
        from app.options_lane.settings import get_options_lane_settings

        get_options_lane_settings.cache_clear()
        env = {
            "DB_DSN": "postgresql://torghut:torghut@localhost:5432/torghut",
            "ALPACA_OPTIONS_KEY_ID": "key-id",
            "ALPACA_OPTIONS_SECRET_KEY": "secret-key",
            "OPTIONS_MARKET_HOLIDAYS": "",
            "OPTIONS_LIVE_UNDERLYING_SYMBOLS": "AAPL,MSFT",
            "OPTIONS_UNDERLYING_PRIORITY_SYMBOLS": "",
        }
        with (
            patch.dict(os.environ, env, clear=True),
            patch("app.options_lane.repository.OptionsRepository", _NoCountRepository),
            patch("app.options_lane.kafka.OptionsKafkaProducer", _FakeProducer),
            patch("app.options_lane.alpaca.AlpacaOptionsClient", _FakeAlpacaClient),
        ):
            return importlib.import_module(module_name)

    def test_catalog_status_heartbeat_skips_contract_table_counts(self) -> None:
        service = cast(
            _CatalogStatusServiceModule,
            self._import_service("app.options_lane.catalog_service"),
        )

        service._publish_status(
            status_value="ok",
            observed_at=datetime(2026, 3, 9, 15, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(_NoCountRepository.active_count_calls, 0)
        self.assertEqual(_NoCountRepository.hot_count_calls, 0)
        self.assertEqual(len(_FakeProducer.sent), 1)
        payload = _FakeProducer.sent[0][2]["payload"]
        self.assertIsInstance(payload, dict)
        self.assertIsNone(payload["active_contracts"])
        self.assertIsNone(payload["hot_contracts"])

    def test_enricher_status_heartbeat_skips_contract_table_counts(self) -> None:
        service = cast(
            _EnricherStatusServiceModule,
            self._import_service("app.options_lane.enricher_service"),
        )

        service._publish_status(
            status_value="ok",
            observed_at=datetime(2026, 3, 9, 15, 0, tzinfo=timezone.utc),
            backlog=11,
        )

        self.assertEqual(_NoCountRepository.active_count_calls, 0)
        self.assertEqual(_NoCountRepository.hot_count_calls, 0)
        self.assertEqual(len(_FakeProducer.sent), 1)
        payload = _FakeProducer.sent[0][2]["payload"]
        self.assertIsInstance(payload, dict)
        self.assertIsNone(payload["active_contracts"])
        self.assertIsNone(payload["hot_contracts"])
        self.assertEqual(payload["rest_backlog"], 11)

    def test_partial_catalog_cycle_protects_unseen_persisted_candidate(self) -> None:
        service = cast(
            _CatalogDiscoveryServiceModule,
            self._import_service("app.options_lane.catalog_service"),
        )
        repository = _SeededCycleRepository()
        service._repository = repository
        service._client = _PartialCatalogClient()

        with patch.object(
            service,
            "utc_now",
            return_value=datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "provider interrupted after first page"
            ):
                service._run_discovery_cycle()

        self.assertEqual(len(repository.reconciliations), 1)
        desired_symbols, deactivate_symbols = repository.reconciliations[0]
        self.assertEqual(desired_symbols, ["MSFT260717C00400000"])
        self.assertNotIn("ARCHIVE260717P00100000", desired_symbols)
        self.assertNotIn("AAPL260717C00200000", deactivate_symbols)
        self.assertEqual(deactivate_symbols, set())
        snapshot = service._state.snapshot()
        self.assertEqual(snapshot["subscription_reconciliations_total"], 1)
        self.assertEqual(snapshot["subscription_rows_changed_total"], 1)
        self.assertEqual(snapshot["subscription_rows_deactivated_total"], 0)
        self.assertEqual(repository.completed_cycles, [])

    def test_complete_catalog_cycle_deactivates_cold_rows_only_at_final_cleanup(
        self,
    ) -> None:
        service = cast(
            _CatalogDiscoveryServiceModule,
            self._import_service("app.options_lane.catalog_service"),
        )
        repository = _SeededCycleRepository()
        service._repository = repository
        client = _CompleteCatalogClient()
        service._client = client

        with patch.object(
            service,
            "utc_now",
            return_value=datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc),
        ):
            service._run_discovery_cycle()

        self.assertEqual(len(repository.reconciliations), 1)
        final_symbols, final_deactivations = repository.reconciliations[0]
        self.assertEqual(final_symbols, ["AAPL260717C00200000"])
        self.assertEqual(final_deactivations, {"ARCHIVE260717P00100000"})
        self.assertEqual(len(repository.completed_cycles), 1)
        self.assertEqual(repository.completed_cycles[0].contract_count, 1)
        self.assertEqual(repository.completed_cycles[0].hot_count, 1)
        self.assertEqual(client.request["underlying_symbols"], ["AAPL", "MSFT"])
        query = cast(OptionsContractsQuery, client.request["query"])
        self.assertEqual(query.limit, 10000)


class TestOptionsLaneNormalization(TestCase):
    def test_normalize_contract_record_maps_required_fields(self) -> None:
        observed_at = datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc)
        payload = normalize_contract_record(
            {
                "id": "contract-1",
                "symbol": "AAPL260320C00100000",
                "status": "active",
                "expiration_date": "2026-03-20",
                "root_symbol": "AAPL",
                "underlying_symbol": "AAPL",
                "type": "call",
                "style": "american",
                "strike_price": "100",
                "size": "100",
                "open_interest": "42",
            },
            observed_at=observed_at,
        )

        self.assertEqual(payload["contract_symbol"], "AAPL260320C00100000")
        self.assertEqual(payload["underlying_symbol"], "AAPL")
        self.assertEqual(payload["option_type"], "call")
        self.assertEqual(payload["open_interest"], 42)
        self.assertEqual(payload["expiration_date"], date(2026, 3, 20))

    def test_normalize_snapshot_record_computes_mid_price(self) -> None:
        payload = normalize_snapshot_record(
            "AAPL260320C00100000",
            {
                "latestTrade": {"p": 2.15, "s": 5, "t": "2026-03-08T18:00:00Z"},
                "latestQuote": {
                    "bp": 2.1,
                    "bs": 10,
                    "ap": 2.2,
                    "as": 8,
                    "t": "2026-03-08T18:00:01Z",
                },
                "greeks": {"delta": 0.5, "gamma": 0.1, "theta": -0.02, "vega": 0.15},
                "impliedVolatility": 0.34,
                "openInterest": 81,
                "markPrice": 2.18,
            },
            underlying_symbol="AAPL",
            snapshot_class="hot",
        )

        self.assertAlmostEqual(payload["mid_price"], 2.15)
        self.assertEqual(payload["snapshot_class"], "hot")
        self.assertEqual(payload["open_interest"], 81)
        self.assertAlmostEqual(payload["delta"], 0.5)

    def test_normalize_snapshot_record_normalizes_timestamps_to_utc(self) -> None:
        payload = normalize_snapshot_record(
            "AAPL260320C00100000",
            {
                "latestTrade": {"p": 2.15, "s": 5, "t": "2026-03-08T13:00:00-05:00"},
                "latestQuote": {
                    "bp": 2.1,
                    "bs": 10,
                    "ap": 2.2,
                    "as": 8,
                    "t": "2026-03-08T13:00:01-05:00",
                },
            },
            underlying_symbol="AAPL",
            snapshot_class="hot",
        )

        self.assertEqual(
            payload["latest_trade_ts"], datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            payload["latest_quote_ts"],
            datetime(2026, 3, 8, 18, 0, 1, tzinfo=timezone.utc),
        )


class TestOptionsLaneRanking(TestCase):
    def test_ranked_contract_rows_assigns_hot_and_warm_tiers(self) -> None:
        observed_at = datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc)
        contracts = [
            {
                "contract_symbol": "AAPL260320C00100000",
                "status": "active",
                "underlying_symbol": "AAPL",
                "expiration_date": date(2026, 3, 20),
                "strike_price": 100.0,
                "close_price": 100.0,
                "open_interest": 100,
                "ranking_inputs": {},
            },
            {
                "contract_symbol": "AAPL260320P00100000",
                "status": "active",
                "underlying_symbol": "AAPL",
                "expiration_date": date(2026, 3, 20),
                "strike_price": 100.0,
                "close_price": 100.0,
                "open_interest": 80,
                "ranking_inputs": {},
            },
            {
                "contract_symbol": "MSFT260320C00300000",
                "status": "active",
                "underlying_symbol": "MSFT",
                "expiration_date": date(2026, 6, 19),
                "strike_price": 300.0,
                "close_price": 280.0,
                "open_interest": 20,
                "ranking_inputs": {},
            },
        ]

        ranked = ranked_contract_rows(
            contracts,
            observed_at=observed_at,
            hot_cap=1,
            warm_cap=1,
            provider_cap_bootstrap=2,
            underlying_priority={"AAPL"},
        )

        self.assertEqual(ranked[0]["tier"], "hot")
        self.assertEqual(ranked[1]["tier"], "warm")
        self.assertEqual(ranked[2]["tier"], "cold")
        self.assertGreater(ranked[0]["ranking_score"], ranked[2]["ranking_score"])

    def test_top_ranked_contract_rows_returns_only_hot_and_warm_candidates(
        self,
    ) -> None:
        observed_at = datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc)
        ranked = top_ranked_contract_rows(
            iter(
                [
                    {
                        "contract_symbol": "AAPL260320C00100000",
                        "status": "active",
                        "underlying_symbol": "AAPL",
                        "expiration_date": date(2026, 3, 20),
                        "strike_price": 100.0,
                        "close_price": 100.0,
                        "open_interest": 100,
                        "ranking_inputs": {},
                    },
                    {
                        "contract_symbol": "AAPL260320P00100000",
                        "status": "active",
                        "underlying_symbol": "AAPL",
                        "expiration_date": date(2026, 3, 20),
                        "strike_price": 100.0,
                        "close_price": 100.0,
                        "open_interest": 80,
                        "ranking_inputs": {},
                    },
                    {
                        "contract_symbol": "MSFT260320C00300000",
                        "status": "active",
                        "underlying_symbol": "MSFT",
                        "expiration_date": date(2026, 6, 19),
                        "strike_price": 300.0,
                        "close_price": 280.0,
                        "open_interest": 20,
                        "ranking_inputs": {},
                    },
                ]
            ),
            observed_at=observed_at,
            hot_cap=1,
            warm_cap=1,
            max_open_interest=100,
            provider_cap_bootstrap=2,
            underlying_priority={"AAPL"},
        )

        self.assertEqual(
            [row["contract_symbol"] for row in ranked],
            ["AAPL260320C00100000", "AAPL260320P00100000"],
        )
        self.assertEqual([row["tier"] for row in ranked], ["hot", "warm"])

    def test_merge_top_ranked_contract_rows_promotes_better_later_page_candidates(
        self,
    ) -> None:
        observed_at = datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc)
        first_page_ranked = top_ranked_contract_rows(
            iter(
                [
                    {
                        "contract_symbol": "AAPL260320P00100000",
                        "status": "active",
                        "underlying_symbol": "AAPL",
                        "expiration_date": date(2026, 3, 20),
                        "strike_price": 100.0,
                        "close_price": 100.0,
                        "open_interest": 80,
                        "ranking_inputs": {},
                    }
                ]
            ),
            observed_at=observed_at,
            hot_cap=1,
            warm_cap=1,
            max_open_interest=80,
            provider_cap_bootstrap=2,
            underlying_priority={"AAPL"},
        )
        ranked = merge_top_ranked_contract_rows(
            first_page_ranked,
            [
                {
                    "contract_symbol": "AAPL260320C00100000",
                    "status": "active",
                    "underlying_symbol": "AAPL",
                    "expiration_date": date(2026, 3, 20),
                    "strike_price": 100.0,
                    "close_price": 100.0,
                    "open_interest": 100,
                    "ranking_inputs": {},
                }
            ],
            observed_at=observed_at,
            hot_cap=1,
            warm_cap=1,
            max_open_interest=100,
            provider_cap_bootstrap=2,
            underlying_priority={"AAPL"},
        )

        self.assertEqual(
            [row["contract_symbol"] for row in ranked],
            ["AAPL260320C00100000", "AAPL260320P00100000"],
        )
        self.assertEqual([row["tier"] for row in ranked], ["hot", "warm"])

    def test_merge_top_ranked_contract_rows_replaces_duplicate_symbols(self) -> None:
        observed_at = datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc)
        existing = {
            "contract_symbol": "AAPL260717C00200000",
            "status": "active",
            "underlying_symbol": "AAPL",
            "expiration_date": date(2026, 7, 17),
            "strike_price": 200.0,
            "close_price": 200.0,
            "open_interest": 10,
            "ranking_inputs": {},
        }
        refreshed = {**existing, "open_interest": 100}

        ranked = merge_top_ranked_contract_rows(
            [existing],
            [refreshed],
            observed_at=observed_at,
            hot_cap=1,
            warm_cap=1,
            max_open_interest=100,
            provider_cap_bootstrap=2,
            underlying_priority={"AAPL"},
        )

        self.assertEqual(len(ranked), 1)
        self.assertEqual(ranked[0]["contract_symbol"], existing["contract_symbol"])
        self.assertEqual(ranked[0]["open_interest"], 100)


class TestOptionsStatusPayload(TestCase):
    def test_build_status_payload_matches_contract(self) -> None:
        payload = build_status_payload(
            component="catalog",
            status="ok",
            session_value="regular",
            last_success_ts="2026-03-08T18:00:00+00:00",
            active_contracts=123,
            hot_contracts=45,
            rest_backlog=0,
            error_code=None,
            error_detail=None,
        )

        self.assertEqual(payload["component"], "catalog")
        self.assertEqual(payload["session_state"], "regular")
        self.assertEqual(payload["schema_version"], 1)
        self.assertTrue(payload["heartbeat"])
