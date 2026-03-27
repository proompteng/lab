"""In-process forecast registry and authority helpers."""

from __future__ import annotations

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

from ..config import settings
from .evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from .features import optional_decimal

_DEFAULT_REGISTRY_TIMEOUT_SECONDS = 5


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

    def to_status_payload(self, *, reference_time: datetime | None = None) -> dict[str, Any]:
        return {
            "model_family": self.model_family,
            "model_version": self.model_version,
            "model_registry_ref": self.model_registry_ref,
            "training_run_ref": self.training_run_ref,
            "dataset_snapshot_ref": self.dataset_snapshot_ref,
            "calibration_ref": self.calibration_ref,
            "calibration_score": str(self.calibration_score),
            "calibration_updated_at": (
                self.calibration_updated_at.isoformat()
                if self.calibration_updated_at is not None
                else None
            ),
            "promotion_authority_eligible": self.promotion_authority_eligible(
                reference_time=reference_time
            ),
            "artifact_authority": self.artifact_authority(reference_time=reference_time),
        }


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

    def reset(self) -> None:
        with self._lock:
            self._loaded_at = 0.0
            self._snapshot = RegistrySnapshot(
                schema_version="torghut-forecast-registry.v1",
                registry_ref=None,
                generated_at=None,
                models={},
            )

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
                    calibration_score=_parse_decimal(item.get("calibration_score"), Decimal("0")),
                    calibration_updated_at=_parse_datetime(item.get("calibration_updated_at")),
                    parameters=parameters,
                    latency_ms_floor=max(1, int(item.get("latency_ms_floor", 20))),
                    latency_ms_span=max(1, int(item.get("latency_ms_span", 40))),
                    notes=str(item.get("notes") or "").strip() or None,
                )
        return RegistrySnapshot(
            schema_version=str(payload.get("schema_version") or "torghut-forecast-registry.v1"),
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
                with urlopen(request, timeout=_DEFAULT_REGISTRY_TIMEOUT_SECONDS) as response:
                    raw = response.read().decode("utf-8")
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="ignore")[:200]
                raise RuntimeError(f"forecast_registry_http_{exc.code}:{detail}") from exc
            except URLError as exc:
                raise RuntimeError(f"forecast_registry_network_error:{exc.reason}") from exc
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
        path = Path(manifest_path)
        if not path.exists():
            raise RuntimeError("forecast_registry_manifest_missing")
        raw = path.read_text(encoding="utf-8")
        decoded = json.loads(raw)
        if isinstance(decoded, dict):
            return cast(dict[str, Any], decoded)
        raise RuntimeError("forecast_registry_invalid_payload")


forecast_registry = ForecastRegistry()


def _reference_time(as_of: str | None = None) -> datetime | None:
    if as_of is None:
        return None
    parsed = _parse_datetime(as_of)
    return parsed


def forecast_calibration_report(
    *,
    model_family: str | None = None,
    as_of: str | None = None,
) -> dict[str, Any]:
    reference_time = _reference_time(as_of)
    snapshot = forecast_registry.snapshot()
    models = [
        entry.to_status_payload(reference_time=reference_time)
        for _, entry in sorted(snapshot.models.items())
        if model_family is None or entry.model_family == model_family.strip().lower().replace("-", "_")
    ]
    ready, reason = snapshot.readiness(reference_time=reference_time)
    return {
        "status": "ready" if ready else "degraded",
        "reason": reason,
        "schema_version": snapshot.schema_version,
        "registry_ref": snapshot.registry_ref,
        "generated_at": (
            snapshot.generated_at.isoformat()
            if snapshot.generated_at is not None
            else None
        ),
        "models": models,
    }


def forecast_status(*, as_of: str | None = None) -> dict[str, Any]:
    reference_time = _reference_time(as_of)
    snapshot = forecast_registry.snapshot()
    ready, reason = snapshot.readiness(reference_time=reference_time)
    report = forecast_calibration_report(as_of=as_of)
    eligible_models = sorted(
        str(item.get("model_family") or "").strip()
        for item in cast(list[dict[str, Any]], report.get("models") or [])
        if bool(item.get("promotion_authority_eligible"))
    )
    return {
        "configured": bool(snapshot.models),
        "endpoint": None,
        "status": "healthy" if ready else "degraded",
        "authority": "empirical" if ready and eligible_models else "blocked",
        "message": "ok" if ready else reason,
        "calibration_status": str(report.get("status") or "unknown"),
        "registry_ref": report.get("registry_ref"),
        "promotion_authority_eligible_models": eligible_models,
        "allowed_model_families": sorted(settings.trading_forecast_service_allowed_model_families),
        "require_healthy": False,
        "fail_mode": "allow_operational_fallback",
    }


__all__ = [
    "ForecastRegistry",
    "RegistryModelEntry",
    "RegistrySnapshot",
    "forecast_calibration_report",
    "forecast_registry",
    "forecast_status",
]
