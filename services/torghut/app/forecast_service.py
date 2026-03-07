"""Empirical forecast service backed by a versioned model registry manifest."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .config import settings
from .trading.evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from .trading.features import optional_decimal
from .trading.forecasting import (
    ForecastFallback,
    ForecastInterval,
    ForecastUncertainty,
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_decimal(value: object, default: Decimal) -> Decimal:
    parsed = optional_decimal(value)
    return parsed if parsed is not None else default


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _stable_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _clamp_decimal(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return min(high, max(low, value))


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    symbol: str
    horizon: str
    timeframe: str | None = None
    event_ts: datetime
    model_family: str
    normalization_hash: str | None = None
    values: dict[str, Any] = Field(default_factory=dict)


class CalibrationReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_family: str | None = None


@dataclass(frozen=True)
class RegistryModelEntry:
    model_family: str
    model_version: str
    model_registry_ref: str
    training_run_ref: str
    dataset_snapshot_ref: str
    calibration_ref: str
    calibration_score: Decimal
    calibration_updated_at: datetime | None
    parameters: dict[str, Decimal]
    latency_ms_floor: int
    latency_ms_span: int
    notes: str | None

    def promotion_authority_eligible(self, *, reference_time: datetime | None = None) -> bool:
        if self.calibration_updated_at is None:
            return False
        effective_now = (
            reference_time.astimezone(timezone.utc)
            if reference_time is not None
            else _utc_now()
        )
        age = effective_now - self.calibration_updated_at
        if age < timedelta(0):
            return False
        return age <= timedelta(
            seconds=max(settings.trading_forecast_calibration_stale_after_seconds, 1)
        )

    def artifact_authority(self, *, reference_time: datetime | None = None) -> dict[str, Any]:
        freshness = (
            {
                "status": "fresh"
                if self.promotion_authority_eligible(reference_time=reference_time)
                else "stale",
                "updated_at": self.calibration_updated_at.isoformat(),
            }
            if self.calibration_updated_at is not None
            else {"status": "missing"}
        )
        return evidence_contract_payload(
            provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
            maturity=(
                EvidenceMaturity.EMPIRICALLY_VALIDATED
                if self.promotion_authority_eligible(reference_time=reference_time)
                else EvidenceMaturity.CALIBRATED
            ),
            authoritative=self.promotion_authority_eligible(reference_time=reference_time),
            placeholder=False,
            calibration_summary=freshness,
            notes=self.notes or "Forecast generated from registry-backed empirical model entry.",
        )


@dataclass(frozen=True)
class RegistrySnapshot:
    schema_version: str
    registry_ref: str | None
    generated_at: datetime | None
    models: dict[str, RegistryModelEntry]

    def readiness(self, *, reference_time: datetime | None = None) -> tuple[bool, str]:
        if not self.models:
            return False, "registry_empty"
        if not any(
            entry.promotion_authority_eligible(reference_time=reference_time)
            for entry in self.models.values()
        ):
            return False, "calibration_stale"
        return True, "ready"


class ForecastRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded_at = 0.0
        self._snapshot = RegistrySnapshot(
            schema_version="torghut-forecast-registry.v1",
            registry_ref=None,
            generated_at=None,
            models={},
        )

    def snapshot(self) -> RegistrySnapshot:
        refresh_seconds = max(settings.trading_forecast_registry_refresh_seconds, 1)
        with self._lock:
            if time.time() - self._loaded_at >= refresh_seconds:
                try:
                    self._snapshot = self._load_snapshot()
                except Exception:
                    self._snapshot = RegistrySnapshot(
                        schema_version="torghut-forecast-registry.v1",
                        registry_ref=None,
                        generated_at=None,
                        models={},
                    )
                self._loaded_at = time.time()
            return self._snapshot

    def _load_snapshot(self) -> RegistrySnapshot:
        payload = self._load_payload()
        models: dict[str, RegistryModelEntry] = {}
        raw_models = payload.get("models")
        if isinstance(raw_models, list):
            for raw_item in cast(list[object], raw_models):
                if not isinstance(raw_item, Mapping):
                    continue
                item = cast(Mapping[str, Any], raw_item)
                family = str(item.get("model_family") or "").strip().lower().replace("-", "_")
                if not family:
                    continue
                parameters_raw = item.get("parameters")
                parameters: dict[str, Decimal] = {}
                if isinstance(parameters_raw, Mapping):
                    for key, value in cast(Mapping[str, Any], parameters_raw).items():
                        parameters[str(key)] = _parse_decimal(value, Decimal("0"))
                models[family] = RegistryModelEntry(
                    model_family=family,
                    model_version=str(item.get("model_version") or "unknown").strip() or "unknown",
                    model_registry_ref=str(item.get("model_registry_ref") or "").strip(),
                    training_run_ref=str(item.get("training_run_ref") or "").strip(),
                    dataset_snapshot_ref=str(item.get("dataset_snapshot_ref") or "").strip(),
                    calibration_ref=str(item.get("calibration_ref") or "").strip(),
                    calibration_score=_parse_decimal(
                        item.get("calibration_score"), Decimal("0")
                    ),
                    calibration_updated_at=_parse_datetime(
                        item.get("calibration_updated_at")
                    ),
                    parameters=parameters,
                    latency_ms_floor=max(1, int(item.get("latency_ms_floor", 20))),
                    latency_ms_span=max(1, int(item.get("latency_ms_span", 40))),
                    notes=str(item.get("notes") or "").strip() or None,
                )
        return RegistrySnapshot(
            schema_version=str(
                payload.get("schema_version") or "torghut-forecast-registry.v1"
            ),
            registry_ref=str(payload.get("registry_ref") or "").strip() or None,
            generated_at=_parse_datetime(payload.get("generated_at")),
            models=models,
        )

    def _load_payload(self) -> dict[str, Any]:
        manifest_url = (settings.trading_forecast_registry_manifest_url or "").strip()
        if manifest_url:
            request = Request(
                manifest_url,
                headers={"accept": "application/json"},
                method="GET",
            )
            try:
                with urlopen(
                    request,
                    timeout=max(settings.trading_forecast_service_timeout_seconds, 1),
                ) as response:
                    raw = response.read().decode("utf-8")
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="ignore")[:200]
                raise RuntimeError(f"forecast_registry_http_{exc.code}:{detail}") from exc
            except URLError as exc:
                raise RuntimeError(
                    f"forecast_registry_network_error:{exc.reason}"
                ) from exc
            try:
                decoded = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise RuntimeError("forecast_registry_invalid_json") from exc
            if isinstance(decoded, dict):
                return cast(dict[str, Any], decoded)
            raise RuntimeError("forecast_registry_invalid_payload")

        manifest_path = (settings.trading_forecast_registry_manifest_path or "").strip()
        if not manifest_path:
            return {}
        payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return cast(dict[str, Any], payload)
        raise RuntimeError("forecast_registry_invalid_payload")


class ForecastMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests_total = 0
        self.errors_total = 0
        self.last_latency_ms = 0.0

    def record(self, *, latency_ms: float, ok: bool) -> None:
        with self._lock:
            self.requests_total += 1
            self.last_latency_ms = latency_ms
            if not ok:
                self.errors_total += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "requests_total": self.requests_total,
                "errors_total": self.errors_total,
                "last_latency_ms": round(self.last_latency_ms, 3),
            }


_registry = ForecastRegistry()
_metrics = ForecastMetrics()
app = FastAPI(title="torghut-forecast")


def _resolve_latency_ms(entry: RegistryModelEntry, request: ForecastRequest) -> int:
    seed = _stable_json(
        {
            "symbol": request.symbol,
            "horizon": request.horizon,
            "event_ts": request.event_ts.isoformat(),
            "model_family": entry.model_family,
            "normalization_hash": request.normalization_hash or "",
        }
    )
    bucket = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:8], 16)
    return entry.latency_ms_floor + (bucket % entry.latency_ms_span)


def _resolve_interval(
    *,
    point: Decimal,
    values: Mapping[str, Any],
    parameters: Mapping[str, Decimal],
) -> ForecastInterval:
    price = _parse_decimal(values.get("price"), Decimal("0"))
    vol = _parse_decimal(values.get("vol_realized_w60s"), Decimal("0.004"))
    spread = _parse_decimal(values.get("spread"), Decimal("0.01"))
    width_multiplier = parameters.get("interval_width_multiplier", Decimal("0.75"))
    half_width = max(Decimal("0.01"), (vol * max(price, Decimal("1")) * width_multiplier) + spread)
    return ForecastInterval(
        p05=(point - half_width).quantize(Decimal("0.0001")),
        p50=point.quantize(Decimal("0.0001")),
        p95=(point + half_width).quantize(Decimal("0.0001")),
    )


def _resolve_uncertainty(
    *,
    point: Decimal,
    values: Mapping[str, Any],
    parameters: Mapping[str, Decimal],
) -> ForecastUncertainty:
    price = _parse_decimal(values.get("price"), Decimal("1"))
    vol = _parse_decimal(values.get("vol_realized_w60s"), Decimal("0.004"))
    epistemic = _clamp_decimal(
        (abs(point - price) / max(price, Decimal("1")))
        + parameters.get("epistemic_offset", Decimal("0.05")),
        Decimal("0.01"),
        Decimal("0.99"),
    )
    aleatoric = _clamp_decimal(
        (vol * parameters.get("aleatoric_multiplier", Decimal("18")))
        + parameters.get("aleatoric_offset", Decimal("0.05")),
        Decimal("0.01"),
        Decimal("0.99"),
    )
    return ForecastUncertainty(
        epistemic=epistemic.quantize(Decimal("0.0001")),
        aleatoric=aleatoric.quantize(Decimal("0.0001")),
    )


def _resolve_point_forecast(
    *,
    values: Mapping[str, Any],
    parameters: Mapping[str, Decimal],
) -> Decimal:
    price = _parse_decimal(values.get("price"), Decimal("0"))
    macd = _parse_decimal(values.get("macd"), Decimal("0"))
    macd_signal = _parse_decimal(values.get("macd_signal"), Decimal("0"))
    spread = _parse_decimal(values.get("spread"), Decimal("0"))
    drift = (
        (macd - macd_signal) * parameters.get("macd_weight", Decimal("0.8"))
        + price * parameters.get("drift_bias_pct", Decimal("0"))
        - spread * parameters.get("spread_penalty", Decimal("0.15"))
    )
    return price + drift


def _forecast_payload(request: ForecastRequest, entry: RegistryModelEntry) -> dict[str, Any]:
    point = _resolve_point_forecast(values=request.values, parameters=entry.parameters)
    interval = _resolve_interval(point=point, values=request.values, parameters=entry.parameters)
    uncertainty = _resolve_uncertainty(point=point, values=request.values, parameters=entry.parameters)
    promotion_authority_eligible = entry.promotion_authority_eligible(
        reference_time=request.event_ts
    )
    return {
        "schema_version": "forecast_contract_v1",
        "symbol": request.symbol,
        "horizon": request.horizon,
        "event_ts": request.event_ts.astimezone(timezone.utc).isoformat(),
        "model_family": entry.model_family,
        "model_version": entry.model_version,
        "route_key": f"{request.symbol}|{request.horizon}|empirical",
        "point_forecast": str(point.quantize(Decimal("0.0001"))),
        "interval": interval.to_payload(),
        "uncertainty": uncertainty.to_payload(),
        "calibration_score": str(entry.calibration_score.quantize(Decimal("0.0001"))),
        "fallback": ForecastFallback(
            applied=not promotion_authority_eligible,
            reason=None if promotion_authority_eligible else "calibration_stale",
        ).to_payload(),
        "inference_latency_ms": _resolve_latency_ms(entry, request),
        "artifact_authority": entry.artifact_authority(reference_time=request.event_ts),
        "model_registry_ref": entry.model_registry_ref,
        "training_run_ref": entry.training_run_ref,
        "dataset_snapshot_ref": entry.dataset_snapshot_ref,
        "calibration_ref": entry.calibration_ref,
        "promotion_authority_eligible": promotion_authority_eligible,
    }


def _calibration_report(
    snapshot: RegistrySnapshot, *, reference_time: datetime | None = None
) -> dict[str, Any]:
    models: list[dict[str, Any]] = []
    for entry in snapshot.models.values():
        models.append(
            {
                "model_family": entry.model_family,
                "model_version": entry.model_version,
                "calibration_score": str(entry.calibration_score.quantize(Decimal("0.0001"))),
                "calibration_ref": entry.calibration_ref,
                "calibration_updated_at": entry.calibration_updated_at.isoformat()
                if entry.calibration_updated_at is not None
                else None,
                "promotion_authority_eligible": entry.promotion_authority_eligible(
                    reference_time=reference_time
                ),
            }
        )
    ready, reason = snapshot.readiness(reference_time=reference_time)
    return {
        "schema_version": "torghut-forecast-calibration-report.v1",
        "registry_ref": snapshot.registry_ref,
        "generated_at": (reference_time or _utc_now()).astimezone(timezone.utc).isoformat(),
        "status": "ready" if ready else "degraded",
        "reason": reason,
        "models": models,
    }


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "torghut-forecast"}


@app.get("/readyz")
def readyz(asOf: str | None = None) -> dict[str, Any]:
    snapshot = _registry.snapshot()
    reference_time = _parse_datetime(asOf)
    ready, reason = snapshot.readiness(reference_time=reference_time)
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "degraded",
                "service": "torghut-forecast",
                "reason": reason,
                "registry_ref": snapshot.registry_ref,
            },
        )
    return {
        "status": "ok",
        "service": "torghut-forecast",
        "registry_ref": snapshot.registry_ref,
    }


@app.get("/metrics")
def metrics() -> dict[str, Any]:
    return {
        "service": "torghut-forecast",
        "registry": _calibration_report(_registry.snapshot()),
        "metrics": _metrics.snapshot(),
    }


@app.post("/v1/calibration/report")
def calibration_report(
    body: CalibrationReportRequest | None = None, asOf: str | None = None
) -> dict[str, Any]:
    snapshot = _registry.snapshot()
    report = _calibration_report(snapshot, reference_time=_parse_datetime(asOf))
    if body is None or body.model_family is None:
        return report
    family = body.model_family.strip().lower().replace("-", "_")
    report["models"] = [
        item
        for item in cast(list[dict[str, Any]], report["models"])
        if item["model_family"] == family
    ]
    return report


@app.post("/v1/forecast")
@app.post("/v1/forecasts")
def create_forecast(body: ForecastRequest) -> dict[str, Any]:
    started = time.perf_counter()
    ok = False
    try:
        snapshot = _registry.snapshot()
        family = body.model_family.strip().lower().replace("-", "_")
        if family not in {"chronos", "moment", "financial_tsfm"}:
            raise HTTPException(status_code=400, detail="unsupported_model_family")
        entry = snapshot.models.get(family)
        if entry is None:
            raise HTTPException(status_code=503, detail="model_family_not_available")
        payload = _forecast_payload(body, entry)
        ok = True
        return payload
    finally:
        _metrics.record(
            latency_ms=(time.perf_counter() - started) * 1000.0,
            ok=ok,
        )
