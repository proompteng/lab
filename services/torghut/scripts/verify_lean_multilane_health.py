"""Verify Torghut LEAN multi-lane runtime and data-path health checks.

This script is intended for operational validation in stage/prod clusters.
"""

from __future__ import annotations

import argparse
import http.client
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SUPPORTED_NAMESPACE = "torghut"
FLINK_DEPLOYMENTS = (
    "torghut-ta",
    "torghut-options-ta",
    "torghut-ta-sim",
)


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str


def _http_json(url: str, timeout: int = 5) -> dict[str, Any]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"unsupported URL: {url!r}")

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    connection_cls = (
        http.client.HTTPSConnection
        if parsed.scheme == "https"
        else http.client.HTTPConnection
    )
    connection = connection_cls(parsed.netloc, timeout=timeout)
    try:
        connection.request("GET", path, headers={"accept": "application/json"})
        response = connection.getresponse()
        raw = response.read().decode("utf-8").strip()
    finally:
        connection.close()

    if not raw:
        return {}
    payload = json.loads(raw)
    if isinstance(payload, dict):
        return payload
    return {}


def _kubectl_path() -> str | None:
    for candidate in (
        "/usr/bin/kubectl",
        "/usr/local/bin/kubectl",
        "/opt/homebrew/bin/kubectl",
    ):
        if Path(candidate).exists():
            return candidate
    return None


def _kubectl_get(
    *,
    namespace: str,
    resource: str,
    name: str,
    context: str | None = None,
    output: str | None = None,
) -> subprocess.CompletedProcess[str]:
    kubectl = _kubectl_path()
    if kubectl is None:
        return subprocess.CompletedProcess(
            args=["kubectl"], returncode=127, stdout="", stderr="kubectl not found"
        )
    args = [kubectl]
    if context:
        args.extend(["--context", context])
    args.extend(["-n", namespace, "get", resource, name])
    if output:
        args.extend(["-o", output])
    return subprocess.run(args, check=False, text=True, capture_output=True)


def check_http(base_url: str) -> list[CheckResult]:
    checks: list[CheckResult] = []
    endpoints = [
        ("torghut_healthz", "/healthz", lambda payload: payload.get("status") == "ok"),
        (
            "trading_status",
            "/trading/status",
            lambda payload: bool(payload.get("running") in {True, False}),
        ),
        (
            "lean_shadow_parity",
            "/trading/lean/shadow/parity",
            lambda payload: "events_total" in payload,
        ),
    ]
    for name, path, predicate in endpoints:
        url = f"{base_url.rstrip('/')}{path}"
        try:
            payload = _http_json(url)
            passed = predicate(payload)
            checks.append(
                CheckResult(name=name, passed=passed, detail=json.dumps(payload)[:300])
            )
        except Exception as exc:
            checks.append(CheckResult(name=name, passed=False, detail=str(exc)))
    return checks


def _flink_deployment_status_detail(payload: dict[str, Any]) -> tuple[bool, str]:
    status = payload.get("status", {})
    if not isinstance(status, dict):
        return False, "status=missing"
    lifecycle = str(status.get("lifecycleState") or "").strip().upper()
    job_manager = str(status.get("jobManagerDeploymentStatus") or "").strip().upper()
    job_status = status.get("jobStatus", {})
    job_state = (
        str(job_status.get("state") or "").strip().upper()
        if isinstance(job_status, dict)
        else ""
    )
    error = str(status.get("error") or "").strip().replace("\n", " ")[:240]
    passed = lifecycle == "STABLE" and job_manager == "READY" and job_state == "RUNNING"
    detail = (
        f"lifecycleState={lifecycle or 'UNKNOWN'} "
        f"jobManagerDeploymentStatus={job_manager or 'UNKNOWN'} "
        f"jobState={job_state or 'UNKNOWN'}"
    )
    if error:
        detail = f"{detail} error={error}"
    return passed, detail


def check_kafka_flink_clickhouse(
    namespace: str,
    *,
    context: str | None = None,
) -> list[CheckResult]:
    checks: list[CheckResult] = []
    if namespace != SUPPORTED_NAMESPACE:
        checks.append(
            CheckResult(
                name="namespace_supported",
                passed=False,
                detail=f"namespace must be {SUPPORTED_NAMESPACE!r}, got {namespace!r}",
            )
        )
        return checks

    topic_result = _kubectl_get(
        context=context,
        namespace="kafka",
        resource="kafkatopic",
        name="torghut.ta.signals.v1",
    )
    checks.append(
        CheckResult(
            name="kafka_topic_torghut_ta_signals",
            passed=topic_result.returncode == 0,
            detail=(topic_result.stdout or topic_result.stderr).strip()[:300],
        )
    )

    for deployment in FLINK_DEPLOYMENTS:
        flink_result = _kubectl_get(
            context=context,
            namespace=namespace,
            resource="flinkdeployment",
            name=deployment,
            output="json",
        )
        if flink_result.returncode != 0:
            checks.append(
                CheckResult(
                    name=f"flink_deployment_{deployment}",
                    passed=False,
                    detail=(flink_result.stderr or flink_result.stdout).strip()[:300],
                )
            )
            continue
        try:
            payload = json.loads(flink_result.stdout)
            passed, detail = _flink_deployment_status_detail(payload)
        except Exception as exc:
            passed = False
            detail = f"invalid flinkdeployment json: {exc}"
        checks.append(
            CheckResult(
                name=f"flink_deployment_{deployment}", passed=passed, detail=detail
            )
        )

    clickhouse_result = _kubectl_get(
        context=context,
        namespace=namespace,
        resource="clickhouseinstallation",
        name="torghut-clickhouse",
    )
    checks.append(
        CheckResult(
            name="clickhouse_installation",
            passed=clickhouse_result.returncode == 0,
            detail=(clickhouse_result.stdout or clickhouse_result.stderr).strip()[:300],
        )
    )

    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--torghut-url", default="http://torghut.torghut.svc.cluster.local:8181"
    )
    parser.add_argument("--namespace", default="torghut")
    parser.add_argument("--context", default="")
    parser.add_argument("--skip-http", action="store_true")
    parser.add_argument("--skip-k8s", action="store_true")
    args = parser.parse_args()

    results: list[CheckResult] = []
    if not args.skip_http:
        results.extend(check_http(args.torghut_url))
    if not args.skip_k8s:
        results.extend(
            check_kafka_flink_clickhouse(args.namespace, context=args.context or None)
        )

    failed = [check for check in results if not check.passed]
    for check in results:
        status = "PASS" if check.passed else "FAIL"
        print(f"[{status}] {check.name}: {check.detail}")

    if failed:
        print(
            f"Lean multi-lane verification failed ({len(failed)} check(s)).",
            file=sys.stderr,
        )
        return 1
    print("Lean multi-lane verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
