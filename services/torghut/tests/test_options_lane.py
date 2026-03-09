from __future__ import annotations

from datetime import date, datetime, timezone
from unittest import TestCase

from app.options_lane.alpaca import normalize_contract_record, normalize_snapshot_record
from app.options_lane.options_status import build_status_payload
from app.options_lane.repository import ranked_contract_rows
from app.options_lane.session import session_state


class TestOptionsLaneSession(TestCase):
    def test_session_state_classifies_regular_hours(self) -> None:
        now = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(session_state(now), "regular")

    def test_session_state_classifies_weekend(self) -> None:
        now = datetime(2026, 3, 8, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(session_state(now), "weekend")


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
                "latestQuote": {"bp": 2.1, "bs": 10, "ap": 2.2, "as": 8, "t": "2026-03-08T18:00:01Z"},
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
                "latestQuote": {"bp": 2.1, "bs": 10, "ap": 2.2, "as": 8, "t": "2026-03-08T13:00:01-05:00"},
            },
            underlying_symbol="AAPL",
            snapshot_class="hot",
        )

        self.assertEqual(payload["latest_trade_ts"], datetime(2026, 3, 8, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(payload["latest_quote_ts"], datetime(2026, 3, 8, 18, 0, 1, tzinfo=timezone.utc))


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
