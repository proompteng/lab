from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.api import application


def _contract_router() -> APIRouter:
    router = APIRouter()

    @router.get("/system/core-contract")
    def core_contract() -> dict[str, str]:
        return {"surface": "core"}

    return router


def test_build_registered_app_mounts_core_and_workflow_routes(
    monkeypatch: MonkeyPatch,
) -> None:
    app = FastAPI(title="torghut-system-contract-test")
    events: list[tuple[str, bool]] = []

    def api_routers() -> tuple[APIRouter, ...]:
        events.append(("api_routers", application.get_app() is app))
        return (_contract_router(),)

    def register_whitepaper_inngest_routes(registered_app: FastAPI) -> None:
        events.append(("whitepaper", registered_app is app))

        @registered_app.get("/system/whitepaper-contract")
        def whitepaper_contract() -> dict[str, str]:
            return {"surface": "whitepaper"}

    monkeypatch.setattr(application, "_current_app", None)
    monkeypatch.setattr(application, "api_routers", api_routers)

    registered_app = application.build_registered_app(
        app,
        register_whitepaper_inngest_routes=register_whitepaper_inngest_routes,
    )

    assert registered_app is app
    assert application.get_app() is app
    assert events == [("api_routers", True), ("whitepaper", True)]

    client = TestClient(registered_app)
    try:
        core_response = client.get("/system/core-contract")
        whitepaper_response = client.get("/system/whitepaper-contract")
    finally:
        client.close()

    assert core_response.status_code == 200
    assert core_response.json() == {"surface": "core"}
    assert whitepaper_response.status_code == 200
    assert whitepaper_response.json() == {"surface": "whitepaper"}
