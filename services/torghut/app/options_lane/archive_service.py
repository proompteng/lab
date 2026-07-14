"""HTTP lifecycle and health surface for the options archive worker."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
import threading

from fastapi import FastAPI, HTTPException

from .alpaca import AlpacaOptionsClient
from .archive_repository import OptionsArchiveRepository
from .archive_state import ArchiveRuntimeState, archive_is_ready
from .archive_worker import OptionsArchiveWorker
from .repository import OptionsRepository
from .settings import get_options_lane_settings


settings = get_options_lane_settings()
state = ArchiveRuntimeState()
stop_event = threading.Event()
archive_repository = OptionsArchiveRepository(settings.sqlalchemy_dsn)
catalog_repository = OptionsRepository(settings.sqlalchemy_dsn)
client = AlpacaOptionsClient(
    key_id=settings.alpaca_key_id,
    secret_key=settings.alpaca_secret_key,
    contracts_base_url=settings.alpaca_contracts_base_url,
    data_base_url=settings.alpaca_data_base_url,
    feed=settings.alpaca_feed,
)
worker = OptionsArchiveWorker(
    settings=settings,
    archive_repository=archive_repository,
    catalog_repository=catalog_repository,
    client=client,
    state=state,
    stop_event=stop_event,
)
worker_thread: threading.Thread | None = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global worker_thread
    stop_event.clear()
    worker_thread = threading.Thread(
        target=worker.run_forever,
        name="options-catalog-archive",
        daemon=True,
    )
    worker_thread.start()
    try:
        yield
    finally:
        stop_event.set()
        worker_thread.join(timeout=35)
        archive_repository.close()
        catalog_repository.close()


app = FastAPI(title="torghut-options-archive", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> Mapping[str, object]:
    if worker_thread is None or not worker_thread.is_alive():
        raise HTTPException(status_code=500, detail=state.snapshot())
    return {"status": "ok", **state.snapshot()}


@app.get("/readyz")
def readyz() -> Mapping[str, object]:
    snapshot = state.snapshot()
    if not archive_is_ready(snapshot):
        raise HTTPException(status_code=503, detail=snapshot)
    return {"status": "ready", **snapshot}
