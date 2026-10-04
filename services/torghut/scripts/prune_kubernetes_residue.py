from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, cast


SCHEMA_VERSION = "torghut.kubernetes-residue-prune.v1"
DEFAULT_ANALYSIS_RUN_PREFIXES = ("torghut-sim-",)
DEFAULT_OWNERLESS_JOB_PREFIXES = ("torghut-tigerbeetle-journal-",)
FINAL_ANALYSIS_RUN_PHASES = frozenset({"Successful", "Failed", "Error", "Inconclusive"})
SERVICE_ACCOUNT_ROOT = "/var/run/secrets/kubernetes.io/serviceaccount"


@dataclass(frozen=True)
class PruneConfig:
    namespace: str
    analysis_run_max_age_hours: int
    ownerless_job_max_age_hours: int
    analysis_run_prefixes: tuple[str, ...]
    ownerless_job_prefixes: tuple[str, ...]
    apply: bool


@dataclass(frozen=True)
class ResidueCandidate:
    resource: str
    name: str
    created_at: str
    reason: str
    delete_path: str


class KubernetesApiClient:
    def __init__(
        self,
        *,
        api_server: str,
        token: str,
        ca_cert_path: str,
        timeout_seconds: float,
    ) -> None:
        self._api_server = api_server.rstrip("/")
        self._timeout_seconds = timeout_seconds
        tls_context = ssl.create_default_context(cafile=ca_cert_path)
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=tls_context)
        )
        self._headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    @classmethod
    def from_service_account(cls, *, timeout_seconds: float) -> "KubernetesApiClient":
        host = os.environ.get("KUBERNETES_SERVICE_HOST", "").strip()
        port = os.environ.get("KUBERNETES_SERVICE_PORT", "443").strip()
        if not host:
            raise RuntimeError("KUBERNETES_SERVICE_HOST is required")
        token_path = os.path.join(SERVICE_ACCOUNT_ROOT, "token")
        ca_cert_path = os.path.join(SERVICE_ACCOUNT_ROOT, "ca.crt")
        with open(token_path, encoding="utf-8") as token_file:
            token = token_file.read().strip()
        return cls(
            api_server=f"https://{host}:{port}",
            token=token,
            ca_cert_path=ca_cert_path,
            timeout_seconds=timeout_seconds,
        )

    def get_json(self, path: str) -> dict[str, Any]:
        request = urllib.request.Request(
            self._url(path), headers=self._headers, method="GET"
        )
        with self._opener.open(request, timeout=self._timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError(f"kubernetes_response_not_object:{path}")
        return cast(dict[str, Any], payload)

    def delete(self, path: str) -> None:
        body = json.dumps(
            {
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "propagationPolicy": "Background",
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self._url(path), data=body, headers=self._headers, method="DELETE"
        )
        try:
            with self._opener.open(request, timeout=self._timeout_seconds):
                return
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return
            raise

    def _url(self, path: str) -> str:
        return f"{self._api_server}{path}"


def _parse_timestamp(value: object) -> datetime | None:
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
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _metadata(item: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = item.get("metadata")
    return metadata if isinstance(metadata, Mapping) else {}


def _status(item: Mapping[str, Any]) -> Mapping[str, Any]:
    status = item.get("status")
    return status if isinstance(status, Mapping) else {}


def _items(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return []
    return [item for item in raw_items if isinstance(item, Mapping)]


def _name(metadata: Mapping[str, Any]) -> str:
    name = metadata.get("name")
    return str(name) if isinstance(name, str) else ""


def _created_at(metadata: Mapping[str, Any]) -> str:
    created_at = metadata.get("creationTimestamp")
    return str(created_at) if isinstance(created_at, str) else ""


def _has_prefix(name: str, prefixes: Sequence[str]) -> bool:
    return any(name.startswith(prefix) for prefix in prefixes)


def _is_older_than(created_at: str, *, now: datetime, max_age_hours: int) -> bool:
    parsed = _parse_timestamp(created_at)
    if parsed is None:
        return False
    return parsed <= now - timedelta(hours=max_age_hours)


def _owner_references(metadata: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    refs = metadata.get("ownerReferences")
    if not isinstance(refs, list):
        return []
    return [ref for ref in refs if isinstance(ref, Mapping)]


def _job_is_finished(status: Mapping[str, Any]) -> bool:
    if int(status.get("succeeded") or 0) > 0 or int(status.get("failed") or 0) > 0:
        return True
    conditions = status.get("conditions")
    if not isinstance(conditions, list):
        return False
    for condition in conditions:
        if not isinstance(condition, Mapping):
            continue
        if condition.get("status") == "True" and condition.get("type") in {
            "Complete",
            "Failed",
        }:
            return True
    return False


def _safe_name(name: str) -> str:
    return urllib.parse.quote(name, safe="")


def _analysis_run_candidate(
    item: Mapping[str, Any],
    *,
    config: PruneConfig,
    now: datetime,
) -> ResidueCandidate | None:
    metadata = _metadata(item)
    status = _status(item)
    name = _name(metadata)
    created_at = _created_at(metadata)
    phase = status.get("phase")
    if not name or phase not in FINAL_ANALYSIS_RUN_PHASES:
        return None
    if not _has_prefix(name, config.analysis_run_prefixes):
        return None
    if not _is_older_than(
        created_at, now=now, max_age_hours=config.analysis_run_max_age_hours
    ):
        return None
    return ResidueCandidate(
        resource="analysisrun.argoproj.io",
        name=name,
        created_at=created_at,
        reason=f"terminal_phase_{phase}_older_than_{config.analysis_run_max_age_hours}h",
        delete_path=f"/apis/argoproj.io/v1alpha1/namespaces/{config.namespace}/analysisruns/{_safe_name(name)}",
    )


def _ownerless_job_candidate(
    item: Mapping[str, Any],
    *,
    config: PruneConfig,
    now: datetime,
) -> ResidueCandidate | None:
    metadata = _metadata(item)
    status = _status(item)
    name = _name(metadata)
    created_at = _created_at(metadata)
    if not name or not _has_prefix(name, config.ownerless_job_prefixes):
        return None
    if _owner_references(metadata):
        return None
    if not _job_is_finished(status):
        return None
    if not _is_older_than(
        created_at, now=now, max_age_hours=config.ownerless_job_max_age_hours
    ):
        return None
    return ResidueCandidate(
        resource="job.batch",
        name=name,
        created_at=created_at,
        reason=f"ownerless_finished_job_older_than_{config.ownerless_job_max_age_hours}h",
        delete_path=f"/apis/batch/v1/namespaces/{config.namespace}/jobs/{_safe_name(name)}",
    )


def plan_prune(
    analysis_runs_payload: Mapping[str, Any],
    jobs_payload: Mapping[str, Any],
    *,
    config: PruneConfig,
    now: datetime,
) -> list[ResidueCandidate]:
    candidates: list[ResidueCandidate] = []
    for item in _items(analysis_runs_payload):
        candidate = _analysis_run_candidate(item, config=config, now=now)
        if candidate is not None:
            candidates.append(candidate)
    for item in _items(jobs_payload):
        candidate = _ownerless_job_candidate(item, config=config, now=now)
        if candidate is not None:
            candidates.append(candidate)
    return sorted(
        candidates,
        key=lambda candidate: (
            candidate.resource,
            candidate.created_at,
            candidate.name,
        ),
    )


def _read_namespace(default: str) -> str:
    namespace_path = os.path.join(SERVICE_ACCOUNT_ROOT, "namespace")
    try:
        with open(namespace_path, encoding="utf-8") as namespace_file:
            namespace = namespace_file.read().strip()
    except FileNotFoundError:
        namespace = ""
    return namespace or default


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prune stale Torghut generated Kubernetes residue."
    )
    parser.add_argument("--namespace", default=None)
    parser.add_argument("--analysis-run-max-age-hours", type=int, default=168)
    parser.add_argument("--ownerless-job-max-age-hours", type=int, default=168)
    parser.add_argument("--analysis-run-prefix", action="append", default=None)
    parser.add_argument("--ownerless-job-prefix", action="append", default=None)
    parser.add_argument("--request-timeout-seconds", type=float, default=20.0)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def _config_from_args(args: argparse.Namespace) -> PruneConfig:
    namespace = str(args.namespace or _read_namespace("torghut"))
    analysis_run_prefixes = tuple(
        args.analysis_run_prefix or DEFAULT_ANALYSIS_RUN_PREFIXES
    )
    ownerless_job_prefixes = tuple(
        args.ownerless_job_prefix or DEFAULT_OWNERLESS_JOB_PREFIXES
    )
    if args.analysis_run_max_age_hours < 1 or args.ownerless_job_max_age_hours < 1:
        raise RuntimeError("max age values must be positive hours")
    return PruneConfig(
        namespace=namespace,
        analysis_run_max_age_hours=int(args.analysis_run_max_age_hours),
        ownerless_job_max_age_hours=int(args.ownerless_job_max_age_hours),
        analysis_run_prefixes=analysis_run_prefixes,
        ownerless_job_prefixes=ownerless_job_prefixes,
        apply=bool(args.apply),
    )


def _candidate_json(candidate: ResidueCandidate) -> dict[str, str]:
    return {
        "resource": candidate.resource,
        "name": candidate.name,
        "created_at": candidate.created_at,
        "reason": candidate.reason,
    }


def _print_summary(
    *, config: PruneConfig, candidates: Sequence[ResidueCandidate], json_output: bool
) -> None:
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "namespace": config.namespace,
        "dry_run": not config.apply,
        "candidate_count": len(candidates),
        "candidates": [_candidate_json(candidate) for candidate in candidates],
    }
    if json_output:
        print(json.dumps(payload, sort_keys=True))
        return
    print(
        f"schema_version={SCHEMA_VERSION} namespace={config.namespace} "
        f"dry_run={str(not config.apply).lower()} candidate_count={len(candidates)}"
    )
    for candidate in candidates:
        print(
            f"resource={candidate.resource} name={candidate.name} "
            f"created_at={candidate.created_at} reason={candidate.reason}"
        )


def run(argv: Sequence[str]) -> int:
    args = _parse_args(argv)
    config = _config_from_args(args)
    client = KubernetesApiClient.from_service_account(
        timeout_seconds=max(float(args.request_timeout_seconds), 1.0)
    )
    analysis_runs = client.get_json(
        f"/apis/argoproj.io/v1alpha1/namespaces/{config.namespace}/analysisruns"
    )
    jobs = client.get_json(f"/apis/batch/v1/namespaces/{config.namespace}/jobs")
    candidates = plan_prune(
        analysis_runs, jobs, config=config, now=datetime.now(timezone.utc)
    )
    _print_summary(config=config, candidates=candidates, json_output=bool(args.json))
    if config.apply:
        for candidate in candidates:
            client.delete(candidate.delete_path)
    return 0


def main() -> None:
    try:
        raise SystemExit(run(sys.argv[1:]))
    except Exception as exc:
        print(f"torghut_kubernetes_residue_prune_error={exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
