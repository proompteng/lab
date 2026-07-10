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


def test_build_registered_app_mounts_operational_routes(
    monkeypatch: MonkeyPatch,
) -> None:
    app = FastAPI(title="torghut-system-contract-test")
    events: list[tuple[str, bool]] = []

    def api_routers() -> tuple[APIRouter, ...]:
        events.append(("api_routers", application.get_app() is app))
        return (_contract_router(),)

    monkeypatch.setattr(application, "_current_app", None)
    monkeypatch.setattr(application, "api_routers", api_routers)

    registered_app = application.build_registered_app(app)

    assert registered_app is app
    assert application.get_app() is app
    assert events == [("api_routers", True)]

    client = TestClient(registered_app)
    try:
        core_response = client.get("/system/core-contract")
    finally:
        client.close()

    assert core_response.status_code == 200
    assert core_response.json() == {"surface": "core"}
