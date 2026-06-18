"""torghut FastAPI application entrypoint."""

from __future__ import annotations

from . import bootstrap as app_bootstrap
from .api import common as common_api
from .api import health_checks as health_checks_api
from .api import maintenance as maintenance_api
from .api import proof_floor_payloads as proof_floor_payloads_api
from .api import proofs as proofs_api
from .api import readiness as readiness_api
from .api import readiness_helpers as readiness_helpers_api
from .api import runtime_profitability as runtime_profitability_api
from .api import runtime_profitability_helpers as runtime_profitability_helpers_api
from .api import status_helpers as status_helpers_api
from .api import trading_health as trading_health_api
from .api import trading_misc as trading_misc_api
from .api import trading_status as trading_status_api
from .api import vnext_helpers as vnext_helpers_api
from .api import whitepaper as whitepaper_api
from .api.application import register_app

create_app = app_bootstrap.create_app

app = register_app(create_app())

ROUTER_PROVIDERS = (
    common_api,
    status_helpers_api,
    readiness_helpers_api,
    readiness_api,
    whitepaper_api,
    trading_status_api,
    maintenance_api,
    trading_misc_api,
    runtime_profitability_api,
    proofs_api,
    trading_health_api,
    health_checks_api,
    proof_floor_payloads_api,
    runtime_profitability_helpers_api,
    vnext_helpers_api,
)

for api_module in ROUTER_PROVIDERS:
    router = getattr(api_module, "router", None)
    if router is not None:
        app.include_router(router)

app_bootstrap.register_whitepaper_inngest_routes(app)

__all__ = ("app", "create_app")
