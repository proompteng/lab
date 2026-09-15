from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_retired_trading_routes_are_not_public() -> None:
    with TestClient(app) as client:
        retired_routes = (
            "/db-check",
            "/trading/autonomy",
            "/trading/consumer-evidence",
            "/trading/decisions",
            "/trading/executions",
            "/trading/health",
            "/trading/metrics",
            "/trading/profitability/runtime",
            "/trading/proofs",
            "/trading/revenue-repair",
            "/trading/tca",
        )
        assert {route: client.get(route).status_code for route in retired_routes} == {
            route: 404 for route in retired_routes
        }
