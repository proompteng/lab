from __future__ import annotations

from dataclasses import dataclass

from aiohttp import web
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest


@dataclass
class RuntimeState:
    producer_ready: bool = False
    subscribed: bool = False


class HealthServer:
    def __init__(self, host: str, port: int, state: RuntimeState):
        self.host = host
        self.port = port
        self.state = state
        self._runner: web.AppRunner | None = None

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get("/healthz", self.healthz)
        app.router.add_get("/metrics", self.metrics)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    async def healthz(self, _request: web.Request) -> web.Response:
        ready = self.state.producer_ready and self.state.subscribed
        status = 200 if ready else 503
        return web.json_response({"ready": bool(ready)}, status=status)

    async def metrics(self, _request: web.Request) -> web.Response:  # pragma: no cover - Prometheus endpoint
        data = generate_latest()
        return web.Response(body=data, headers={"Content-Type": CONTENT_TYPE_LATEST})
