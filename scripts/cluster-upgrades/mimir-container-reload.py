#!/usr/bin/env python3
"""Safely restart one Mimir process in its existing container.

This helper is intentionally narrower than a workload restart controller.  The
default mode only reads the five Mimir StatefulSets, their Pods, the target
PDB, the authoritative ConfigMap, and the backing PVC/PV identities.  The
``--execute`` path appends one ephemeral helper through the Kubernetes
ephemeral-containers subresource.  That helper verifies the Mimir command,
projected configuration hash, kernel boot ID, and process start ticks before
it sends exactly one SIGTERM to PID 1.

The script is for a GitOps-prepared Mimir 3.1.2 / mimir-distributed 6.1.0
installation.  StatefulSets must already use ``OnDelete``.  It never changes a
StatefulSet, ConfigMap, PVC, or PV; it never deletes a Pod and has no forced
kill or automatic retry path.  Direct SIGTERM is intentionally different from
the kubelet Pod grace-period mechanism: this helper signals the process in the
existing container and waits for Kubernetes to report the resulting container
restart.

Execute mode is intended for one operator host at a time.  It holds a local,
non-blocking POSIX flock keyed by context, namespace, and local UID for the
whole workflow.  That local lock cannot reserve a Kubernetes PDB budget across
hosts; the live PDB and identity gates remain authoritative.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import signal
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ReloadError(RuntimeError):
    """A safety precondition or bounded postcondition was not met."""


class ReadinessTransportError(ReloadError):
    """The existing readiness forward is not accepting connections yet."""


class PortForwardCleanupError(ReloadError):
    """A readiness port-forward could not be cleaned up with SIGTERM."""


Runner = Callable[[Sequence[str], str | None, float], tuple[int, str, str]]
Clock = Callable[[], float]
Sleeper = Callable[[float], None]
ReadinessReader = Callable[["Config", str], int | bool]


CONTEXT = "galactic-lan"
NAMESPACE = "observability"
CONFIGMAP = "observability-mimir-config"
CONFIG_KEY = "mimir.yaml"
KAFKA_POD = "observability-mimir-kafka-0"
KAFKA_CONTAINER = "kafka"
MIMIR_VERSION = "3.1.2"
MIMIR_CHART = "mimir-distributed-6.1.0"
MIMIR_IMAGE = "docker.io/grafana/mimir:3.1.2"
KAFKA_IMAGE = "docker.io/apache/kafka-native:4.1.0"
RBD_DRIVER = "rook-ceph.rbd.csi.ceph.com"
IMAGE_ID_RE = re.compile(r"@sha256:[0-9a-f]{64}$")
OPERATOR_LOCK_PREFIX = "mimir-container-reload-"
DEFAULT_TIMEOUT_SECONDS = 300.0
DEFAULT_POLL_SECONDS = 5.0
DEFAULT_COMMAND_TIMEOUT_SECONDS = 20.0
TARGET_PORT = 8080
TARGET_PATH = "/ready"
TARGET_UID = 10001
TARGET_GID = 10001
HELPER_PREFIX = "mimir-process-term-"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST_RE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[^\s]+://[^\s]+$")
PROCESS_START_TICKS_RE = re.compile(r"^[0-9]+$")
BOOT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
APPROVED_UTILITY_IMAGE = (
    "mirror.gcr.io/library/busybox:1.37.0@"
    "sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0"
)


@dataclass(frozen=True)
class TargetSpec:
    pod: str
    statefulset: str
    component: str
    pdb: str


TARGETS: dict[str, TargetSpec] = {
    "observability-mimir-ingester-0": TargetSpec(
        "observability-mimir-ingester-0",
        "observability-mimir-ingester",
        "ingester",
        "observability-mimir-ingester",
    ),
    "observability-mimir-ingester-1": TargetSpec(
        "observability-mimir-ingester-1",
        "observability-mimir-ingester",
        "ingester",
        "observability-mimir-ingester",
    ),
    "observability-mimir-ingester-2": TargetSpec(
        "observability-mimir-ingester-2",
        "observability-mimir-ingester",
        "ingester",
        "observability-mimir-ingester",
    ),
    "observability-mimir-store-gateway-0": TargetSpec(
        "observability-mimir-store-gateway-0",
        "observability-mimir-store-gateway",
        "store-gateway",
        "observability-mimir-store-gateway",
    ),
    "observability-mimir-compactor-0": TargetSpec(
        "observability-mimir-compactor-0",
        "observability-mimir-compactor",
        "compactor",
        "observability-mimir-compactor",
    ),
    "observability-mimir-alertmanager-0": TargetSpec(
        "observability-mimir-alertmanager-0",
        "observability-mimir-alertmanager",
        "alertmanager",
        "observability-mimir-alertmanager",
    ),
}

STATEFULSETS: dict[str, int] = {
    "observability-mimir-ingester": 3,
    "observability-mimir-store-gateway": 1,
    "observability-mimir-compactor": 1,
    "observability-mimir-alertmanager": 1,
    "observability-mimir-kafka": 1,
}

MIMIR_PODS = tuple(
    [f"observability-mimir-ingester-{index}" for index in range(3)]
    + [
        "observability-mimir-store-gateway-0",
        "observability-mimir-compactor-0",
        "observability-mimir-alertmanager-0",
        KAFKA_POD,
    ]
)
SINGLETON_PODS = (
    "observability-mimir-store-gateway-0",
    "observability-mimir-compactor-0",
    "observability-mimir-alertmanager-0",
)
INGESTER_PODS = tuple(f"observability-mimir-ingester-{index}" for index in range(3))


@dataclass(frozen=True)
class Config:
    context: str = CONTEXT
    namespace: str = NAMESPACE
    pod: str = INGESTER_PODS[0]
    expected_pod_uid: str | None = None
    expected_container_id: str | None = None
    expected_config_sha256: str | None = None
    expected_process_start_ticks: str | None = None
    expected_boot_id: str | None = None
    utility_image: str | None = None
    execute: bool = False
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    poll: float = DEFAULT_POLL_SECONDS
    command_timeout: float = DEFAULT_COMMAND_TIMEOUT_SECONDS
    audit_path: Path | None = None


def operator_lock_path(config: Config) -> Path:
    key = f"{config.context}\x00{config.namespace}\x00{os.getuid()}".encode("utf-8")
    digest = hashlib.sha256(key).hexdigest()[:32]
    return Path("/tmp") / f"{OPERATOR_LOCK_PREFIX}{digest}.lock"


class OperatorLock:
    """One local execute owner; it does not coordinate PDBs across hosts."""

    def __init__(self, config: Config) -> None:
        self.path = operator_lock_path(config)
        self.fd: int | None = None

    def __enter__(self) -> "OperatorLock":
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        try:
            self.fd = os.open(self.path, flags, 0o600)
            file_stat = os.fstat(self.fd)
            if not stat.S_ISREG(file_stat.st_mode):
                raise ReloadError("operator lock is not a regular file")
            if file_stat.st_uid != os.getuid():
                raise ReloadError("operator lock is not owned by the current UID")
            if stat.S_IMODE(file_stat.st_mode) != 0o600:
                raise ReloadError("operator lock must have mode 0600")
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ReloadError(
                    "another Mimir execute workflow owns the local operator lock"
                ) from exc
            return self
        except OSError as exc:
            self._close()
            raise ReloadError("unable to open the local Mimir operator lock") from exc
        except BaseException:
            self._close()
            raise

    def _close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        del exc_type, exc_value, traceback
        self._close()


def subprocess_runner(
    argv: Sequence[str], input_text: str | None, timeout: float
) -> tuple[int, str, str]:
    """Run one argv vector without a shell or inherited credential output."""

    try:
        completed = subprocess.run(
            list(argv),
            input=input_text,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ReloadError(f"command timed out: {argv[0]}") from exc
    except OSError as exc:
        raise ReloadError(f"unable to run {argv[0]}") from exc
    return completed.returncode, completed.stdout, completed.stderr


def redact_text(value: str, *, limit: int = 500) -> str:
    """Keep useful operational evidence while removing likely credentials."""

    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value).replace("\x00", "")
    clean = re.sub(r"(?i)\bBearer\s+[^\s,;}\"']+", "Bearer [REDACTED]", clean)
    clean = re.sub(
        r"(?i)(password|passwd|secret[_-]?key|secret|access[_-]?key|token|authorization|bearer)"
        r"([\"']?\s*[=:]\s*[\"']?|\s+)([^\s,;}\"']+)",
        r"\1=[REDACTED]",
        clean,
    )
    clean = re.sub(r"(?i)(://)([^/@\s]+)@", r"\1[REDACTED]@", clean)
    return clean[:limit]


def _safe_audit(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {str(key): _safe_audit(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_audit(item) for item in value]
    return value


def kubectl(
    config: Config,
    args: Sequence[str],
    runner: Runner,
    *,
    input_text: str | None = None,
) -> str:
    """Run kubectl with an explicit context on every invocation."""

    argv = ("kubectl", "--context", config.context, *args)
    code, stdout, stderr = runner(argv, input_text, config.command_timeout)
    if code != 0:
        detail = redact_text(stderr.strip() or stdout.strip(), limit=300)
        operation = args[0] if args else "command"
        raise ReloadError(f"kubectl failed ({code}) for {operation}: {detail}")
    return stdout


def get_json(config: Config, args: Sequence[str], runner: Runner) -> Mapping[str, Any]:
    try:
        value = json.loads(kubectl(config, args, runner))
    except json.JSONDecodeError as exc:
        operation = args[0] if args else "command"
        raise ReloadError(f"kubectl returned invalid JSON for {operation}") from exc
    if not isinstance(value, Mapping):
        operation = args[0] if args else "command"
        raise ReloadError(f"kubectl returned a non-object for {operation}")
    return value


def read_pod(config: Config, pod: str, runner: Runner) -> Mapping[str, Any]:
    if pod not in MIMIR_PODS:
        raise ReloadError(f"Pod {pod!r} is outside the Mimir allowlist")
    return get_json(
        config,
        ("-n", config.namespace, "get", "pod", pod, "-o", "json"),
        runner,
    )


def read_configmap(config: Config, runner: Runner) -> tuple[str, str]:
    payload = get_json(
        config,
        ("-n", config.namespace, "get", "configmap", CONFIGMAP, "-o", "json"),
        runner,
    )
    metadata = payload.get("metadata")
    if isinstance(metadata, Mapping) and metadata.get("namespace") not in (
        None,
        NAMESPACE,
    ):
        raise ReloadError(f"ConfigMap {CONFIGMAP} is outside namespace {NAMESPACE}")
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise ReloadError(f"ConfigMap {CONFIGMAP} has no data map")
    value = data.get(CONFIG_KEY)
    if not isinstance(value, str):
        raise ReloadError(f"ConfigMap {CONFIGMAP} has no {CONFIG_KEY} key")
    return hashlib.sha256(value.encode("utf-8")).hexdigest(), value


def read_configmap_hash(config: Config, runner: Runner) -> str:
    return read_configmap(config, runner)[0]


def target_container_for_pod(pod: str) -> str:
    """Return the live Mimir container name for one explicitly allowed Pod."""

    target = TARGETS.get(pod)
    if target is None:
        raise ReloadError(f"Pod {pod!r} is outside the Mimir allowlist")
    return target.component


def statefulset_container_name(name: str) -> str:
    if name == "observability-mimir-kafka":
        return KAFKA_CONTAINER
    for target in TARGETS.values():
        if target.statefulset == name:
            return target.component
    raise ReloadError(f"StatefulSet {name!r} is outside the Mimir allowlist")


def _yaml_bool_entries(value: str) -> list[tuple[tuple[str, ...], str]]:
    """Parse the simple mapping subset needed by the Mimir safety gate.

    The ConfigMap is still hashed as opaque bytes.  This parser intentionally
    only accepts key/value lines and is used to reject unsafe explicit values;
    it is not a general YAML parser and never rewrites the configuration.
    """

    stack: list[tuple[int, str]] = []
    entries: list[tuple[tuple[str, ...], str]] = []
    key_re = re.compile(
        r"^(?P<indent>\s*)(?P<key>[A-Za-z0-9_.-]+):(?:\s*(?P<value>.*))?$"
    )
    for raw in value.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        match = key_re.match(raw)
        if match is None:
            continue
        indent = len(match.group("indent").replace("\t", "  "))
        while stack and indent <= stack[-1][0]:
            stack.pop()
        key = match.group("key")
        raw_value = (match.group("value") or "").strip()
        if " #" in raw_value:
            raw_value = raw_value.split(" #", 1)[0].rstrip()
        if (
            len(raw_value) >= 2
            and raw_value[0] == raw_value[-1]
            and raw_value[0] in "\"'"
        ):
            raw_value = raw_value[1:-1]
        path = tuple(item[1] for item in stack) + (key,)
        if raw_value:
            entries.append((path, raw_value.lower()))
        else:
            stack.append((indent, key))
    return entries


def validate_mimir_config(value: str) -> None:
    entries = _yaml_bool_entries(value)
    values_by_path: dict[tuple[str, ...], list[str]] = {}
    for path, raw in entries:
        values_by_path.setdefault(path, []).append(raw)
    required = {
        ("ingest_storage", "enabled"): "true",
        ("ingester", "ring", "unregister_on_shutdown"): "false",
        ("store_gateway", "sharding_ring", "unregister_on_shutdown"): "false",
    }
    for path, expected in required.items():
        values = values_by_path.get(path, [])
        if len(values) != 1 or values[0] != expected:
            dotted = ".".join(path)
            raise ReloadError(
                f"Mimir {dotted} must appear exactly once with value {expected}"
            )
    flush_values = values_by_path.get(("flush_blocks_on_shutdown",), [])
    if len(flush_values) > 1 or (flush_values and flush_values[0] != "false"):
        raise ReloadError("Mimir flush_blocks_on_shutdown must be absent or false")
    for path, raw in entries:
        if path[-1] == "unregister_on_shutdown" and raw != "false":
            raise ReloadError("Mimir ring unregister_on_shutdown must be false")
        if path[-1] == "flush_blocks_on_shutdown" and raw != "false":
            raise ReloadError("Mimir flush_blocks_on_shutdown must be absent or false")


def condition_true(pod: Mapping[str, Any], condition_type: str) -> bool:
    conditions = pod.get("status", {}).get("conditions", [])
    if not isinstance(conditions, list):
        return False
    return any(
        isinstance(condition, Mapping)
        and condition.get("type") == condition_type
        and condition.get("status") == "True"
        for condition in conditions
    )


def find_container_status(pod: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    statuses = pod.get("status", {}).get("containerStatuses", [])
    if isinstance(statuses, list):
        for status in statuses:
            if isinstance(status, Mapping) and status.get("name") == name:
                return status
    pod_name = pod.get("metadata", {}).get("name", "<unknown>")
    raise ReloadError(f"Pod {pod_name} has no {name} status")


def _metadata(pod: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = pod.get("metadata")
    if not isinstance(metadata, Mapping):
        raise ReloadError("Mimir Pod has no metadata")
    return metadata


def validate_image_id(value: str, label: str = "container imageID") -> None:
    if not isinstance(value, str) or not IMAGE_ID_RE.search(value):
        raise ReloadError(f"{label} must include an immutable sha256 digest")


def observe_pod(
    pod: Mapping[str, Any],
    container: str,
    *,
    require_container_id: bool = True,
    require_ready: bool = False,
    require_image_id: bool = True,
) -> dict[str, Any]:
    """Capture a Pod/container identity without accepting a replacement Pod."""

    metadata = _metadata(pod)
    uid = metadata.get("uid")
    resource_version = metadata.get("resourceVersion")
    if not isinstance(uid, str) or not uid:
        raise ReloadError("Mimir Pod is missing UID")
    if not isinstance(resource_version, str) or not resource_version:
        raise ReloadError("Mimir Pod is missing resourceVersion")
    if metadata.get("deletionTimestamp") is not None:
        raise ReloadError(
            f"Mimir Pod {metadata.get('name', '<unknown>')} is terminating"
        )
    status = find_container_status(pod, container)
    raw_image_id = status.get("imageID")
    image_id: str | None
    if raw_image_id is None:
        image_id = None
    elif isinstance(raw_image_id, str):
        validate_image_id(raw_image_id, f"Mimir {container} imageID")
        image_id = raw_image_id
    else:
        raise ReloadError(f"Mimir {container} imageID is malformed")
    if require_image_id and image_id is None:
        raise ReloadError(f"Mimir {container} imageID is missing")
    raw_id = status.get("containerID")
    container_id: str | None
    if raw_id is None:
        container_id = None
    elif isinstance(raw_id, str) and CONTAINER_ID_RE.fullmatch(raw_id):
        container_id = raw_id
    else:
        raise ReloadError(f"Mimir {container} containerID is malformed")
    if require_container_id and container_id is None:
        raise ReloadError(f"Mimir {container} containerID is missing")
    restart_count = status.get("restartCount", 0)
    if (
        not isinstance(restart_count, int)
        or isinstance(restart_count, bool)
        or restart_count < 0
    ):
        raise ReloadError(f"Mimir {container} restartCount is invalid")
    state = status.get("state")
    running_state = state.get("running") if isinstance(state, Mapping) else None
    running = isinstance(running_state, Mapping)
    started_at = running_state.get("startedAt") if running else None
    if started_at is not None and not isinstance(started_at, str):
        raise ReloadError(f"Mimir {container} startedAt is malformed")
    if (
        (require_container_id or require_ready)
        and running
        and (not isinstance(started_at, str) or not started_at)
    ):
        raise ReloadError(f"Mimir {container} startedAt is missing")
    ready = status.get("ready") is True and condition_true(pod, "Ready")
    if require_ready and (not running or not ready):
        raise ReloadError(f"Mimir Pod {metadata.get('name', '<unknown>')} is not Ready")
    return {
        "podUID": uid,
        "resourceVersion": resource_version,
        "containerID": container_id,
        "imageID": image_id,
        "startedAt": started_at,
        "restartCount": restart_count,
        "running": running,
        "ready": ready,
    }


def validate_ready_pod(pod: Mapping[str, Any], container: str) -> dict[str, Any]:
    if _metadata(pod).get("deletionTimestamp") is not None:
        raise ReloadError(
            f"Mimir Pod {_metadata(pod).get('name', '<unknown>')} is terminating"
        )
    if pod.get("status", {}).get("phase") != "Running":
        raise ReloadError(
            f"Mimir Pod {_metadata(pod).get('name', '<unknown>')} is not Running"
        )
    return observe_pod(pod, container, require_container_id=True, require_ready=True)


def _live_pod_container(pod: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    containers = pod.get("spec", {}).get("containers", [])
    if not isinstance(containers, list):
        raise ReloadError(
            f"Pod {_metadata(pod).get('name', '<unknown>')} has no container list"
        )
    for container in containers:
        if isinstance(container, Mapping) and container.get("name") == name:
            return container
    raise ReloadError(
        f"Pod {_metadata(pod).get('name', '<unknown>')} has no live {name} container"
    )


def validate_live_pod_spec(pod: Mapping[str, Any], pod_name: str) -> None:
    """Fence the running Pod template, which may lag an OnDelete StatefulSet."""

    container_name = (
        KAFKA_CONTAINER if pod_name == KAFKA_POD else target_container_for_pod(pod_name)
    )
    container = _live_pod_container(pod, container_name)
    if pod_name == KAFKA_POD:
        if container.get("image") != KAFKA_IMAGE:
            raise ReloadError(
                f"live Kafka Pod image must be {KAFKA_IMAGE}, observed {container.get('image')!r}"
            )
        return
    if not _mimir_image(container.get("image")):
        raise ReloadError(
            f"live Mimir Pod {pod_name} is not pinned to Mimir {MIMIR_VERSION}"
        )
    args = container.get("args", [])
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise ReloadError(f"live Mimir Pod {pod_name} has malformed args")
    required = {
        f"-target={target_container_for_pod(pod_name)}",
        "-config.file=/etc/mimir/mimir.yaml",
        "-config.expand-env=true",
    }
    if not required.issubset(set(args)):
        raise ReloadError(
            f"live Mimir Pod {pod_name} is missing its target/config arguments"
        )


def _template_container(sts: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    template = sts.get("spec", {}).get("template")
    containers = (
        template.get("spec", {}).get("containers", [])
        if isinstance(template, Mapping)
        else []
    )
    if not isinstance(containers, list):
        raise ReloadError(f"StatefulSet {name} has no container list")
    expected_name = statefulset_container_name(name)
    for container in containers:
        if isinstance(container, Mapping) and container.get("name") == expected_name:
            return container
    raise ReloadError(f"StatefulSet {name} has no required {expected_name} container")


def _mimir_image(image: Any) -> bool:
    if not isinstance(image, str):
        return False
    return bool(re.search(r"(?:^|/)mimir:3\.1\.2(?:@sha256:[0-9a-f]{64})?$", image))


def validate_statefulset(sts: Mapping[str, Any], name: str) -> None:
    metadata = sts.get("metadata")
    spec = sts.get("spec")
    if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping):
        raise ReloadError(f"StatefulSet {name} has no metadata/spec")
    if metadata.get("name") not in (None, name):
        raise ReloadError(f"StatefulSet response name does not match {name}")
    if metadata.get("namespace") not in (None, NAMESPACE):
        raise ReloadError(f"StatefulSet {name} is outside namespace {NAMESPACE}")
    labels = metadata.get("labels", {})
    template_labels = spec.get("template", {}).get("metadata", {}).get("labels", {})
    for label_set in (labels, template_labels):
        if not isinstance(label_set, Mapping):
            raise ReloadError(f"StatefulSet {name} has no Mimir labels")
        if label_set.get("app.kubernetes.io/version") != MIMIR_VERSION:
            raise ReloadError(f"StatefulSet {name} has unexpected Mimir version label")
        if label_set.get("helm.sh/chart") != MIMIR_CHART:
            raise ReloadError(f"StatefulSet {name} has unexpected Mimir chart label")
    if spec.get("replicas") != STATEFULSETS[name]:
        raise ReloadError(
            f"StatefulSet {name} replicas must be {STATEFULSETS[name]}, observed {spec.get('replicas')!r}"
        )
    strategy = spec.get("updateStrategy")
    if not isinstance(strategy, Mapping) or strategy.get("type") != "OnDelete":
        observed = strategy.get("type") if isinstance(strategy, Mapping) else None
        raise ReloadError(
            f"StatefulSet {name} must use OnDelete, observed {observed!r}"
        )
    container = _template_container(sts, name)
    if name == "observability-mimir-kafka":
        if container.get("image") != KAFKA_IMAGE:
            raise ReloadError(
                f"StatefulSet {name} Kafka image must be {KAFKA_IMAGE}, observed {container.get('image')!r}"
            )
    else:
        if not _mimir_image(container.get("image")):
            raise ReloadError(
                f"StatefulSet {name} is not pinned to Mimir {MIMIR_VERSION}"
            )
        args = container.get("args", [])
        if not isinstance(args, list) or not all(
            isinstance(item, str) for item in args
        ):
            raise ReloadError(f"StatefulSet {name} has malformed Mimir args")
        required = {
            f"-target={statefulset_container_name(name)}",
            "-config.file=/etc/mimir/mimir.yaml",
            "-config.expand-env=true",
        }
        if not required.issubset(set(args)):
            raise ReloadError(
                f"StatefulSet {name} is missing required Mimir command args"
            )


def validate_all_statefulsets(
    config: Config, runner: Runner
) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for name in STATEFULSETS:
        result[name] = get_json(
            config,
            ("-n", config.namespace, "get", "statefulset", name, "-o", "json"),
            runner,
        )
        validate_statefulset(result[name], name)
    return result


def _pod_labels(pod: Mapping[str, Any]) -> Mapping[str, Any]:
    labels = pod.get("metadata", {}).get("labels", {})
    if not isinstance(labels, Mapping):
        raise ReloadError(
            f"Pod {_metadata(pod).get('name', '<unknown>')} has no labels"
        )
    return labels


def _selector_matches(selector: Mapping[str, Any], pod: Mapping[str, Any]) -> bool:
    labels = _pod_labels(pod)
    return all(labels.get(key) == value for key, value in selector.items())


def validate_pdb(
    pdb: Mapping[str, Any],
    name: str,
    target_pods: Sequence[Mapping[str, Any]] | None = None,
    all_mimir_pods: Sequence[Mapping[str, Any]] | None = None,
    expected_component: str | None = None,
) -> None:
    metadata = pdb.get("metadata")
    if not isinstance(metadata, Mapping):
        raise ReloadError(f"PDB {name} has no metadata")
    if metadata.get("name") != name:
        raise ReloadError(f"PDB response name does not match {name}")
    if metadata.get("namespace") != NAMESPACE:
        raise ReloadError(f"PDB {name} is outside namespace {NAMESPACE}")
    generation = metadata.get("generation")
    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation <= 0
    ):
        raise ReloadError(f"PDB {name} has no valid metadata.generation")
    spec = pdb.get("spec")
    if not isinstance(spec, Mapping) or spec.get("maxUnavailable") != 1:
        raise ReloadError(f"PDB {name} maxUnavailable must be exactly 1")
    selector = spec.get("selector")
    if not isinstance(selector, Mapping):
        raise ReloadError(f"PDB {name} has no selector")
    match_labels = selector.get("matchLabels")
    if not isinstance(match_labels, Mapping):
        raise ReloadError(f"PDB {name} selector.matchLabels is required")
    if selector.get("matchExpressions") not in (None, []):
        raise ReloadError(f"PDB {name} selector.matchExpressions is unsupported")
    expected_labels = {
        "app.kubernetes.io/component": expected_component,
        "app.kubernetes.io/instance": "observability-mimir",
        "app.kubernetes.io/name": "mimir",
    }
    if expected_component is not None:
        for key, value in expected_labels.items():
            if match_labels.get(key) != value:
                raise ReloadError(f"PDB {name} selector has unexpected {key}")
    status = pdb.get("status")
    if not isinstance(status, Mapping):
        raise ReloadError(f"PDB {name} has no status")
    if status.get("observedGeneration") != generation:
        raise ReloadError(f"PDB {name} status.observedGeneration is stale")
    disrupted = status.get("disruptedPods", {})
    if disrupted is not None and (not isinstance(disrupted, Mapping) or disrupted):
        raise ReloadError(f"PDB {name} has pending disruptions")
    allowed = status.get("disruptionsAllowed")
    if allowed != 1:
        raise ReloadError(
            f"PDB {name} disruptionsAllowed must be 1, observed {allowed!r}"
        )
    if target_pods is None:
        return
    target_names = {
        _metadata(pod).get("name") for pod in target_pods if _metadata(pod).get("name")
    }
    if not target_names:
        raise ReloadError(f"PDB {name} has no target Pods to select")
    for pod in target_pods:
        if not _selector_matches(match_labels, pod):
            raise ReloadError(
                f"PDB {name} selector does not select target Pod {_metadata(pod).get('name', '<unknown>')}"
            )
    if all_mimir_pods is not None:
        selected_names = {
            _metadata(pod).get("name")
            for pod in all_mimir_pods
            if _selector_matches(match_labels, pod)
        }
        if selected_names != target_names:
            raise ReloadError(
                f"PDB {name} selector selects {sorted(selected_names)!r}, expected {sorted(target_names)!r}"
            )
    expected_pods = len(target_pods)
    if status.get("expectedPods") != expected_pods:
        raise ReloadError(f"PDB {name} expectedPods is not current")
    if status.get("currentHealthy") != expected_pods:
        raise ReloadError(f"PDB {name} currentHealthy is not fully healthy")
    if status.get("desiredHealthy") != expected_pods - 1:
        raise ReloadError(
            f"PDB {name} desiredHealthy is inconsistent with maxUnavailable=1"
        )


def read_all_pods(config: Config, runner: Runner) -> dict[str, Mapping[str, Any]]:
    return {pod: read_pod(config, pod, runner) for pod in MIMIR_PODS}


def validate_pod_set(
    pods: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    identities: dict[str, dict[str, Any]] = {}
    for pod_name in INGESTER_PODS:
        observed = pods[pod_name]
        validate_live_pod_spec(observed, pod_name)
        identities[pod_name] = validate_ready_pod(
            observed, target_container_for_pod(pod_name)
        )
    for pod_name in SINGLETON_PODS:
        validate_live_pod_spec(pods[pod_name], pod_name)
        identities[pod_name] = validate_ready_pod(
            pods[pod_name], target_container_for_pod(pod_name)
        )
    validate_live_pod_spec(pods[KAFKA_POD], KAFKA_POD)
    identities[KAFKA_POD] = validate_ready_pod(pods[KAFKA_POD], KAFKA_CONTAINER)
    return identities


def _pvc_claims(pod: Mapping[str, Any]) -> tuple[str, ...]:
    volumes = pod.get("spec", {}).get("volumes", [])
    if not isinstance(volumes, list):
        raise ReloadError(
            f"Pod {_metadata(pod).get('name', '<unknown>')} has malformed volumes"
        )
    claims: list[str] = []
    for volume in volumes:
        if not isinstance(volume, Mapping):
            continue
        claim = volume.get("persistentVolumeClaim")
        if isinstance(claim, Mapping) and isinstance(claim.get("claimName"), str):
            claims.append(claim["claimName"])
    if not claims:
        raise ReloadError(f"Pod {_metadata(pod).get('name', '<unknown>')} has no PVC")
    return tuple(dict.fromkeys(claims))


def storage_snapshot(
    config: Config,
    pods: Mapping[str, Mapping[str, Any]],
    runner: Runner,
) -> tuple[dict[str, Any], ...]:
    records: list[dict[str, Any]] = []
    for pod_name in MIMIR_PODS:
        for claim in _pvc_claims(pods[pod_name]):
            pvc = get_json(
                config,
                ("-n", config.namespace, "get", "pvc", claim, "-o", "json"),
                runner,
            )
            pvc_meta = pvc.get("metadata")
            pvc_uid = pvc_meta.get("uid") if isinstance(pvc_meta, Mapping) else None
            pvc_name = pvc_meta.get("name") if isinstance(pvc_meta, Mapping) else None
            pvc_namespace = (
                pvc_meta.get("namespace") if isinstance(pvc_meta, Mapping) else None
            )
            if (
                not isinstance(pvc_meta, Mapping)
                or pvc_meta.get("deletionTimestamp") is not None
            ):
                raise ReloadError(f"PVC {claim} is missing or terminating")
            if pvc_name != claim:
                raise ReloadError(f"PVC response name does not match {claim}")
            pv_name = pvc.get("spec", {}).get("volumeName")
            if not isinstance(pvc_uid, str) or not pvc_uid:
                raise ReloadError(f"PVC {claim} is missing UID")
            if pvc_namespace != config.namespace:
                raise ReloadError(
                    f"PVC {claim} is outside namespace {config.namespace}"
                )
            if pvc.get("status", {}).get("phase") != "Bound":
                raise ReloadError(f"PVC {claim} is not Bound")
            if not isinstance(pv_name, str) or not pv_name:
                raise ReloadError(f"PVC {claim} is not bound to a PV")
            pv = get_json(config, ("get", "pv", pv_name, "-o", "json"), runner)
            pv_meta = pv.get("metadata")
            pv_uid = pv_meta.get("uid") if isinstance(pv_meta, Mapping) else None
            if (
                not isinstance(pv_meta, Mapping)
                or pv_meta.get("deletionTimestamp") is not None
            ):
                raise ReloadError(f"PV {pv_name} is missing or terminating")
            if pv_meta.get("name") != pv_name:
                raise ReloadError(f"PV response name does not match {pv_name}")
            if not isinstance(pv_uid, str) or not pv_uid:
                raise ReloadError(f"PV {pv_name} is missing UID")
            if pv.get("status", {}).get("phase") != "Bound":
                raise ReloadError(f"PV {pv_name} is not Bound")
            claim_ref = pv.get("spec", {}).get("claimRef")
            if (
                not isinstance(claim_ref, Mapping)
                or claim_ref.get("name") != claim
                or claim_ref.get("namespace") != config.namespace
                or claim_ref.get("uid") != pvc_uid
            ):
                raise ReloadError(f"PV {pv_name} claimRef does not match PVC {claim}")
            csi = pv.get("spec", {}).get("csi", {})
            driver = csi.get("driver") if isinstance(csi, Mapping) else None
            handle = csi.get("volumeHandle") if isinstance(csi, Mapping) else None
            if driver != RBD_DRIVER:
                raise ReloadError(
                    f"PV {pv_name} CSI driver must be {RBD_DRIVER}, observed {driver!r}"
                )
            if not isinstance(handle, str) or not handle:
                raise ReloadError(f"PV {pv_name} has no CSI volumeHandle")
            records.append(
                {
                    "pod": pod_name,
                    "claim": claim,
                    "pvcUID": pvc_uid,
                    "pvName": pv_name,
                    "pvUID": pv_uid,
                    "csiDriver": driver,
                    "volumeHandle": handle,
                }
            )
    return tuple(
        sorted(records, key=lambda item: (str(item["pod"]), str(item["claim"])))
    )


def _same_identity(
    before: Mapping[str, Any], after: Mapping[str, Any], *, include_rv: bool
) -> bool:
    fields = ("podUID", "containerID", "imageID", "startedAt", "restartCount")
    if include_rv:
        fields += ("resourceVersion",)
    return all(before.get(field) == after.get(field) for field in fields)


def validate_sha256(value: str, label: str = "SHA-256") -> None:
    if not SHA256_RE.fullmatch(value):
        raise ReloadError(
            f"{label} must be exactly 64 lowercase hexadecimal characters"
        )


def validate_process_start_ticks(
    value: str, label: str = "process start ticks"
) -> None:
    if not PROCESS_START_TICKS_RE.fullmatch(value):
        raise ReloadError(f"{label} must be a non-negative decimal tick count")


def parse_proc_stat_start_ticks(stat_line: str, *, pid: str = "1") -> str:
    """Read field 22 from /proc/<pid>/stat, preserving comm parentheses/spaces."""

    if not re.match(rf"^{re.escape(pid)} \(.+\) ", stat_line):
        raise ReloadError("target process stat record is malformed")
    fields = stat_line[stat_line.rfind(") ") + 2 :].split()
    # The text after comm starts at field 3, so field 22 is index 19.
    if len(fields) < 20 or not PROCESS_START_TICKS_RE.fullmatch(fields[19]):
        raise ReloadError("target process start ticks are missing or malformed")
    return fields[19]


def validate_boot_id(value: str, label: str = "boot ID") -> None:
    if not BOOT_ID_RE.fullmatch(value):
        raise ReloadError(f"{label} must be a lowercase UUID")


def validate_utility_image(value: str) -> None:
    if not IMAGE_DIGEST_RE.fullmatch(value):
        raise ReloadError("utility image must be an explicit @sha256: digest pin")


def helper_name(uid: str, restart_count: int) -> str:
    return f"{HELPER_PREFIX}{restart_count}-{uid[:8]}"


def _shell_arg(value: str, label: str) -> str:
    if not value or "\x00" in value or "\n" in value:
        raise ReloadError(f"{label} is malformed")
    return shlex.quote(value)


def helper_script(
    component: str,
    expected_sha256: str,
    expected_process_start_ticks: str,
    expected_boot_id: str,
    *,
    proc_root: str = "/proc",
    target_pid: str = "1",
    executable: str = "/bin/mimir",
) -> str:
    """Build the PID-fenced BusyBox shell helper.

    ``proc_root`` and ``target_pid`` are explicit to make the native-shell
    fixture testable without changing the production default of ``/proc/1``.
    """

    if component not in {spec.component for spec in TARGETS.values()}:
        raise ReloadError(f"unsupported Mimir component {component!r}")
    validate_sha256(expected_sha256, "expected config SHA-256")
    validate_process_start_ticks(expected_process_start_ticks)
    validate_boot_id(expected_boot_id)
    if not re.fullmatch(r"[0-9]+", target_pid):
        raise ReloadError("target PID is malformed")
    root = _shell_arg(proc_root.rstrip("/"), "proc root")
    pid = _shell_arg(target_pid, "target PID")
    exe = _shell_arg(executable, "target executable")
    expected_component = _shell_arg(f"-target={component}", "component")
    expected_file = _shell_arg("-config.file=/etc/mimir/mimir.yaml", "config arg")
    expected_expand = _shell_arg("-config.expand-env=true", "expand arg")
    expected_hash = _shell_arg(expected_sha256, "config hash")
    expected_ticks = _shell_arg(expected_process_start_ticks, "start ticks")
    expected_boot = _shell_arg(expected_boot_id, "boot ID")
    cmdline_path = f"{root}/{pid}/cmdline"
    config_path = f"{root}/{pid}/root/etc/mimir/mimir.yaml"
    boot_path = f"{root}/sys/kernel/random/boot_id"
    stat_path = f"{root}/{pid}/stat"
    return f"""set -eu
set -f
cmdline=\"$(tr '\\000' ' ' < {cmdline_path})\"
set -- $cmdline
if [ \"$#\" -lt 1 ] || [ \"$1\" != {exe} ]; then
  printf '%s\\n' 'target PID is not /bin/mimir' >&2
  exit 41
fi
target_ok=false
config_ok=false
expand_ok=false
for argument in \"$@\"; do
  if [ \"$argument\" = {expected_component} ]; then target_ok=true; fi
  if [ \"$argument\" = {expected_file} ]; then config_ok=true; fi
  if [ \"$argument\" = {expected_expand} ]; then expand_ok=true; fi
done
if [ \"$target_ok\" != true ] || [ \"$config_ok\" != true ] || [ \"$expand_ok\" != true ]; then
  printf '%s\\n' 'target PID has unexpected Mimir arguments' >&2
  exit 42
fi
digest_output=\"$(sha256sum {config_path})\"
digest=\"${{digest_output%% *}}\"
if [ \"$digest\" != {expected_hash} ]; then
  printf '%s\\n' 'projected Mimir configuration hash changed' >&2
  exit 43
fi
boot_id=\"$(tr -d '\\n' < {boot_path})\"
if [ \"$boot_id\" != {expected_boot} ]; then
  printf '%s\\n' 'kernel boot ID changed since identity capture' >&2
  exit 44
fi
stat_line=\"$(tr -d '\\n' < {stat_path})\"
case \"$stat_line\" in
  "{pid} ("*) ;;
  *) printf '%s\\n' 'target process stat record is malformed' >&2; exit 45 ;;
esac
stat_fields=\"${{stat_line##*) }}\"
set -- $stat_fields
field=3
start_ticks=\"\"
while [ \"$#\" -gt 0 ]; do
  if [ \"$field\" -eq 22 ]; then start_ticks=\"$1\"; break; fi
  shift
  field=$((field + 1))
done
if [ \"$start_ticks\" != {expected_ticks} ]; then
  printf '%s\\n' 'target process start ticks changed' >&2
  exit 46
fi
kill -0 {pid}
kill -TERM {pid}
"""


def helper_spec(
    name: str,
    image: str,
    component: str,
    expected_sha256: str,
    expected_process_start_ticks: str,
    expected_boot_id: str,
) -> dict[str, Any]:
    validate_utility_image(image)
    return {
        "name": name,
        "image": image,
        "command": [
            "/bin/sh",
            "-ceu",
            helper_script(
                component,
                expected_sha256,
                expected_process_start_ticks,
                expected_boot_id,
            ),
        ],
        "targetContainerName": component,
        "securityContext": {
            "runAsUser": TARGET_UID,
            "runAsGroup": TARGET_GID,
            "runAsNonRoot": True,
            "allowPrivilegeEscalation": False,
            "privileged": False,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
    }


def append_ephemeral_patch(
    pod: Mapping[str, Any], helper: Mapping[str, Any]
) -> list[dict[str, Any]]:
    metadata = pod.get("metadata")
    spec = pod.get("spec")
    if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping):
        raise ReloadError("target Pod is missing metadata or spec")
    uid = metadata.get("uid")
    resource_version = metadata.get("resourceVersion")
    if (
        not isinstance(uid, str)
        or not uid
        or not isinstance(resource_version, str)
        or not resource_version
    ):
        raise ReloadError(
            "target Pod is missing UID or resourceVersion for patch fencing"
        )
    operations: list[dict[str, Any]] = [
        {"op": "test", "path": "/metadata/uid", "value": uid},
        {"op": "test", "path": "/metadata/resourceVersion", "value": resource_version},
    ]
    if "ephemeralContainers" in spec:
        existing = spec.get("ephemeralContainers")
        if not isinstance(existing, list):
            raise ReloadError("target Pod ephemeralContainers is not a list")
        operations.append(
            {"op": "test", "path": "/spec/ephemeralContainers", "value": existing}
        )
        operations.append(
            {"op": "add", "path": "/spec/ephemeralContainers/-", "value": dict(helper)}
        )
    else:
        operations.append(
            {"op": "add", "path": "/spec/ephemeralContainers", "value": [dict(helper)]}
        )
    return operations


def ephemeral_status(pod: Mapping[str, Any], name: str) -> Mapping[str, Any] | None:
    statuses = pod.get("status", {}).get("ephemeralContainerStatuses", [])
    if isinstance(statuses, list):
        for status in statuses:
            if isinstance(status, Mapping) and status.get("name") == name:
                return status
    return None


def unfinished_reload_helpers(pod: Mapping[str, Any]) -> tuple[str, ...]:
    """Return Mimir reload helpers that have not completed successfully."""

    spec_helpers = pod.get("spec", {}).get("ephemeralContainers", [])
    if not isinstance(spec_helpers, list):
        raise ReloadError(
            f"Pod {_metadata(pod).get('name', '<unknown>')} ephemeralContainers is not a list"
        )
    names = {
        str(item.get("name"))
        for item in spec_helpers
        if isinstance(item, Mapping)
        and str(item.get("name", "")).startswith(HELPER_PREFIX)
    }
    pending: list[str] = []
    for name in sorted(names):
        status = ephemeral_status(pod, name)
        terminated = status.get("state", {}).get("terminated") if status else None
        exit_code = (
            terminated.get("exitCode") if isinstance(terminated, Mapping) else None
        )
        if (
            not isinstance(exit_code, int)
            or isinstance(exit_code, bool)
            or exit_code != 0
        ):
            pending.append(name)
    return tuple(pending)


def reject_unfinished_peer_helpers(
    pods: Mapping[str, Mapping[str, Any]], target_pod: str
) -> None:
    for pod_name, pod in pods.items():
        if pod_name == target_pod:
            continue
        pending = unfinished_reload_helpers(pod)
        if pending:
            raise ReloadError(
                f"Mimir peer Pod {pod_name} has failed or unfinished reload helper(s): "
                + ", ".join(pending)
            )


def previous_exit(status: Mapping[str, Any]) -> dict[str, Any]:
    last = status.get("lastState")
    terminated = last.get("terminated") if isinstance(last, Mapping) else None
    if not isinstance(terminated, Mapping):
        raise ReloadError(
            "restarted Mimir container has no previous termination status"
        )
    evidence = {
        key: terminated.get(key)
        for key in ("reason", "exitCode", "signal", "startedAt", "finishedAt")
        if terminated.get(key) is not None
    }
    exit_code = terminated.get("exitCode")
    if (
        terminated.get("reason") == "OOMKilled"
        or terminated.get("signal") == 9
        or exit_code == 137
    ):
        raise ReloadError("Mimir container was force- or OOM-terminated")
    if exit_code != 0 or terminated.get("signal") not in (None, 0):
        raise ReloadError(
            f"Mimir container did not exit gracefully: exitCode={exit_code!r}"
        )
    return evidence


class PortForward:
    """A bounded, TERM-only port-forward used for the target readiness gate."""

    def __init__(
        self, config: Config, pod: str, *, popen: Callable[..., Any] = subprocess.Popen
    ) -> None:
        self.config = config
        self.pod = pod
        self.popen = popen
        self.process: Any | None = None
        self.local_port: int | None = None

    @staticmethod
    def free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def __enter__(self) -> "PortForward":
        try:
            self.local_port = self.free_port()
            argv = [
                "kubectl",
                "--context",
                self.config.context,
                "-n",
                self.config.namespace,
                "port-forward",
                f"pod/{self.pod}",
                f"{self.local_port}:{TARGET_PORT}",
            ]
            try:
                self.process = self.popen(
                    argv,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
            except OSError as exc:
                raise ReloadError(
                    "unable to start Mimir readiness port-forward"
                ) from exc
            if self.process.poll() is not None:
                raise ReloadError("Mimir readiness port-forward exited before use")
            return self
        except BaseException:
            self._stop()
            raise

    def request(self, path: str = TARGET_PATH) -> int:
        if self.local_port is None:
            raise ReloadError("Mimir readiness port-forward is not active")
        request = Request(f"http://127.0.0.1:{self.local_port}{path}", method="GET")
        try:
            with urlopen(
                request, timeout=min(self.config.command_timeout, 10.0)
            ) as response:
                response.read(256)
                return int(response.status)
        except HTTPError as exc:
            return int(exc.code)
        except (OSError, URLError) as exc:
            raise ReadinessTransportError(
                "Mimir readiness endpoint was unreachable"
            ) from exc

    def _stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        try:
            self.process.send_signal(signal.SIGTERM)
        except OSError as exc:
            raise PortForwardCleanupError(
                "Mimir readiness port-forward could not receive SIGTERM"
            ) from exc
        try:
            self.process.wait(timeout=5.0)
        except subprocess.TimeoutExpired as exc:
            raise PortForwardCleanupError(
                "Mimir readiness port-forward did not exit after SIGTERM"
            ) from exc

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        try:
            self._stop()
        except PortForwardCleanupError as exc:
            if exc_type is not None:
                detail = str(exc_value) if exc_value is not None else "unknown error"
                raise PortForwardCleanupError(
                    "Mimir readiness port-forward cleanup failed while handling "
                    f"{detail}: {exc}"
                ) from exc
            raise


def readiness_probe(config: Config, pod: str) -> int:
    deadline = time.monotonic() + min(config.timeout, 30.0)
    last_status: int | None = None
    last_transport_error: ReadinessTransportError | None = None
    with PortForward(config, pod) as port_forward:
        while time.monotonic() <= deadline:
            try:
                status = port_forward.request(TARGET_PATH)
            except ReadinessTransportError as exc:
                last_transport_error = exc
                if time.monotonic() >= deadline:
                    raise ReadinessTransportError(
                        "Mimir readiness endpoint remained unreachable "
                        f"through the bounded probe window: {exc}"
                    ) from exc
                time.sleep(0.25)
                continue
            last_status = status
            if status == 200:
                return status
            time.sleep(0.25)
    if last_transport_error is not None:
        raise ReadinessTransportError(
            "Mimir readiness endpoint remained unreachable through the bounded "
            f"probe window: {last_transport_error}"
        ) from last_transport_error
    raise ReloadError(
        f"Mimir readiness endpoint did not return HTTP 200: {last_status!r}"
    )


class Workflow:
    def __init__(
        self,
        config: Config,
        runner: Runner = subprocess_runner,
        *,
        clock: Clock = time.monotonic,
        sleep: Sleeper = time.sleep,
        readiness_reader: ReadinessReader = readiness_probe,
    ) -> None:
        self.config = config
        self.runner = runner
        self.clock = clock
        self.sleep = sleep
        self.readiness_reader = readiness_reader
        self.audit: dict[str, Any] = {
            "metadata": {
                "mode": "execute" if config.execute else "plan",
                "context": config.context,
                "namespace": config.namespace,
                "pod": config.pod,
                "targetContainer": target_container_for_pod(config.pod),
                "mimirVersion": MIMIR_VERSION,
                "mimirChart": MIMIR_CHART,
            },
            "events": [],
        }

    def event(self, name: str, **values: Any) -> None:
        self.audit["events"].append(_safe_audit({"name": name, **values}))

    def finish(self, outcome: str) -> None:
        self.audit["outcome"] = outcome
        if self.config.audit_path is not None:
            self.config.audit_path.write_text(
                json.dumps(self.audit, indent=2) + "\n", encoding="utf-8"
            )

    def validate_config(self) -> None:
        if not self.config.context.strip() or not self.config.namespace.strip():
            raise ReloadError("--context and --namespace are required")
        if self.config.pod not in TARGETS:
            raise ReloadError(
                f"--pod must be one of the six allowed Mimir targets; observed {self.config.pod!r}"
            )
        if (
            self.config.timeout <= 0
            or self.config.poll < 0
            or self.config.command_timeout <= 0
        ):
            raise ReloadError("timeouts must be positive and poll must be non-negative")
        if self.config.expected_config_sha256 is not None:
            validate_sha256(
                self.config.expected_config_sha256, "expected config SHA-256"
            )
        if (self.config.expected_process_start_ticks is None) != (
            self.config.expected_boot_id is None
        ):
            raise ReloadError(
                "process start ticks and boot ID must be supplied together"
            )
        if self.config.expected_process_start_ticks is not None:
            validate_process_start_ticks(self.config.expected_process_start_ticks)
            validate_boot_id(self.config.expected_boot_id or "")
        if self.config.utility_image is not None:
            validate_utility_image(self.config.utility_image)
        if not self.config.execute:
            return
        if self.config.context != CONTEXT:
            raise ReloadError(f"--execute requires --context {CONTEXT}")
        if self.config.namespace != NAMESPACE:
            raise ReloadError(f"--execute requires --namespace {NAMESPACE}")
        required = [
            ("--expected-pod-uid", self.config.expected_pod_uid),
            ("--expected-container-id", self.config.expected_container_id),
            ("--expected-config-sha256", self.config.expected_config_sha256),
            (
                "--expected-process-start-ticks",
                self.config.expected_process_start_ticks,
            ),
            ("--expected-boot-id", self.config.expected_boot_id),
            ("--utility-image", self.config.utility_image),
        ]
        missing = [flag for flag, value in required if not value]
        if missing:
            raise ReloadError(f"--execute requires explicit {', '.join(missing)}")
        if self.config.utility_image != APPROVED_UTILITY_IMAGE:
            raise ReloadError("--utility-image is not the approved BusyBox digest")
        if not CONTAINER_ID_RE.fullmatch(self.config.expected_container_id or ""):
            raise ReloadError("--expected-container-id is malformed")

    def preflight(self) -> dict[str, Any]:
        statefulsets = validate_all_statefulsets(self.config, self.runner)
        pods = read_all_pods(self.config, self.runner)
        identities = validate_pod_set(pods)
        reject_unfinished_peer_helpers(pods, self.config.pod)
        target_spec = TARGETS[self.config.pod]
        pdb = get_json(
            self.config,
            ("-n", self.config.namespace, "get", "pdb", target_spec.pdb, "-o", "json"),
            self.runner,
        )
        target_pods = [
            pods[pod_name]
            for pod_name, target in TARGETS.items()
            if target.statefulset == target_spec.statefulset
        ]
        validate_pdb(
            pdb,
            target_spec.pdb,
            target_pods,
            list(pods.values()),
            target_spec.component,
        )
        config_hash, config_text = read_configmap(self.config, self.runner)
        validate_mimir_config(config_text)
        target_identity = identities[self.config.pod]
        if (
            self.config.expected_pod_uid is not None
            and target_identity["podUID"] != self.config.expected_pod_uid
        ):
            raise ReloadError("target Pod UID does not match --expected-pod-uid")
        if (
            self.config.expected_container_id is not None
            and target_identity["containerID"] != self.config.expected_container_id
        ):
            raise ReloadError(
                "target containerID does not match --expected-container-id"
            )
        if (
            self.config.expected_config_sha256 is not None
            and config_hash != self.config.expected_config_sha256
        ):
            raise ReloadError(
                "authoritative ConfigMap hash does not match --expected-config-sha256"
            )
        ephemeral = pods[self.config.pod].get("spec", {}).get("ephemeralContainers", [])
        if not isinstance(ephemeral, list):
            raise ReloadError("target Pod ephemeralContainers is not a list")
        if any(
            isinstance(item, Mapping)
            and str(item.get("name", "")).startswith(HELPER_PREFIX)
            for item in ephemeral
        ):
            raise ReloadError("target Pod already has a Mimir reload helper")
        storage = storage_snapshot(self.config, pods, self.runner)
        self.event(
            "preflight-ready",
            statefulSets={
                name: statefulsets[name]
                .get("spec", {})
                .get("updateStrategy", {})
                .get("type")
                for name in STATEFULSETS
            },
            readyPods=list(MIMIR_PODS),
            targetPDB=target_spec.pdb,
            pdbDisruptionsAllowed=1,
            authoritativeConfigSHA256=config_hash,
            targetIdentity=target_identity,
            kafkaIdentity=identities[KAFKA_POD],
            storageRecords=len(storage),
            existingEphemeralCount=len(ephemeral),
        )
        return {
            "statefulsets": statefulsets,
            "pods": pods,
            "identities": identities,
            "storage": storage,
            "configSha256": config_hash,
            "target": pods[self.config.pod],
            "targetIdentity": target_identity,
            "restartCount": target_identity["restartCount"],
            "podUID": target_identity["podUID"],
        }

    def refresh_before_patch(self, state: Mapping[str, Any]) -> Mapping[str, Any]:
        validate_all_statefulsets(self.config, self.runner)
        current_hash, current_config = read_configmap(self.config, self.runner)
        validate_mimir_config(current_config)
        if current_hash != state["configSha256"]:
            raise ReloadError("authoritative ConfigMap changed during preflight")
        target_spec = TARGETS[self.config.pod]
        pdb = get_json(
            self.config,
            ("-n", self.config.namespace, "get", "pdb", target_spec.pdb, "-o", "json"),
            self.runner,
        )
        pods = read_all_pods(self.config, self.runner)
        identities = validate_pod_set(pods)
        reject_unfinished_peer_helpers(pods, self.config.pod)
        target_pods = [
            pods[pod_name]
            for pod_name, target in TARGETS.items()
            if target.statefulset == target_spec.statefulset
        ]
        validate_pdb(
            pdb,
            target_spec.pdb,
            target_pods,
            list(pods.values()),
            target_spec.component,
        )
        for pod_name, before in state["identities"].items():
            if not _same_identity(
                before, identities[pod_name], include_rv=pod_name == self.config.pod
            ):
                raise ReloadError(
                    f"Mimir Pod/container identity changed before patch: {pod_name}"
                )
        storage = storage_snapshot(self.config, pods, self.runner)
        if storage != state["storage"]:
            raise ReloadError("Mimir PVC/PV identity changed before patch")
        ephemeral = pods[self.config.pod].get("spec", {}).get("ephemeralContainers", [])
        if not isinstance(ephemeral, list):
            raise ReloadError("target Pod ephemeralContainers is not a list")
        if any(
            isinstance(item, Mapping)
            and str(item.get("name", "")).startswith(HELPER_PREFIX)
            for item in ephemeral
        ):
            raise ReloadError("target Pod gained a Mimir reload helper before patch")
        self.event(
            "identity-fenced",
            targetIdentity=identities[self.config.pod],
            kafkaIdentity=identities[KAFKA_POD],
        )
        return pods[self.config.pod]

    def patch_ephemeral(
        self, target: Mapping[str, Any], helper: Mapping[str, Any]
    ) -> None:
        patch = append_ephemeral_patch(target, helper)
        kubectl(
            self.config,
            (
                "-n",
                self.config.namespace,
                "patch",
                "pod",
                self.config.pod,
                "--subresource=ephemeralcontainers",
                "--type=json",
                "--patch",
                json.dumps(patch, separators=(",", ":")),
            ),
            self.runner,
        )
        self.event(
            "ephemeral-appended", helperName=helper["name"], patchOperations=len(patch)
        )

    def _postflight_identities(
        self, state: Mapping[str, Any], pods: Mapping[str, Mapping[str, Any]]
    ) -> None:
        identities = validate_pod_set(pods)
        reject_unfinished_peer_helpers(pods, self.config.pod)
        for pod_name in INGESTER_PODS + (KAFKA_POD,) + SINGLETON_PODS:
            if pod_name == self.config.pod:
                continue
            if not _same_identity(
                state["identities"][pod_name], identities[pod_name], include_rv=False
            ):
                raise ReloadError(
                    f"Mimir peer identity changed during reload: {pod_name}"
                )
        if storage_snapshot(self.config, pods, self.runner) != state["storage"]:
            raise ReloadError(
                "Mimir PVC/PV identity or CSI handle changed during reload"
            )
        if read_configmap_hash(self.config, self.runner) != state["configSha256"]:
            raise ReloadError("Mimir ConfigMap changed during reload")

    def wait_for_restart(
        self, helper: Mapping[str, Any], state: Mapping[str, Any]
    ) -> dict[str, Any]:
        target_container = target_container_for_pod(self.config.pod)
        expected_restart = int(state["restartCount"]) + 1
        deadline = self.clock() + self.config.timeout
        helper_done = False
        old_exit: dict[str, Any] | None = None
        last_reason: str | None = None
        while self.clock() <= deadline:
            pod = read_pod(self.config, self.config.pod, self.runner)
            identity = observe_pod(
                pod,
                target_container,
                require_container_id=False,
                require_image_id=False,
            )
            if identity["podUID"] != state["podUID"]:
                raise ReloadError("target Pod UID changed during reload")
            if identity["restartCount"] > expected_restart:
                raise ReloadError(
                    "Mimir restarted more than once during one helper attempt"
                )
            status = find_container_status(pod, target_container)
            helper_state = ephemeral_status(pod, str(helper["name"]))
            if helper_state is not None:
                terminal = helper_state.get("state", {}).get("terminated")
                if isinstance(terminal, Mapping):
                    code = terminal.get("exitCode")
                    if code != 0:
                        raise ReloadError(
                            f"Mimir reload helper exited unsuccessfully: {code!r}"
                        )
                    helper_done = True
            if identity["restartCount"] == expected_restart:
                if not identity["running"] or not identity["ready"]:
                    last_reason = "target container is not Running and Ready"
                elif (
                    not isinstance(identity["containerID"], str)
                    or not identity["containerID"]
                    or not isinstance(identity["startedAt"], str)
                    or not identity["startedAt"]
                    or not isinstance(identity["imageID"], str)
                    or not identity["imageID"]
                    or identity["imageID"] != state["targetIdentity"]["imageID"]
                    or identity["containerID"] == state["targetIdentity"]["containerID"]
                    or identity["startedAt"] == state["targetIdentity"]["startedAt"]
                ):
                    last_reason = "target container incarnation did not change"
                else:
                    old_exit = previous_exit(status)
                    if helper_done:
                        try:
                            pods = read_all_pods(self.config, self.runner)
                            self._postflight_identities(state, pods)
                            target_spec = TARGETS[self.config.pod]
                            pdb = get_json(
                                self.config,
                                (
                                    "-n",
                                    self.config.namespace,
                                    "get",
                                    "pdb",
                                    target_spec.pdb,
                                    "-o",
                                    "json",
                                ),
                                self.runner,
                            )
                            target_pods = [
                                pods[pod_name]
                                for pod_name, target in TARGETS.items()
                                if target.statefulset == target_spec.statefulset
                            ]
                            validate_pdb(
                                pdb,
                                target_spec.pdb,
                                target_pods,
                                list(pods.values()),
                                target_spec.component,
                            )
                            http_status = self.readiness_reader(
                                self.config, self.config.pod
                            )
                            if http_status is not True and http_status != 200:
                                raise ReloadError(
                                    f"Mimir readiness returned HTTP {http_status!r}"
                                )
                        except PortForwardCleanupError:
                            raise
                        except ReloadError as exc:
                            last_reason = redact_text(str(exc), limit=300)
                        else:
                            result = {
                                "oldContainerID": state["targetIdentity"][
                                    "containerID"
                                ],
                                "newContainerID": identity["containerID"],
                                "oldStartedAt": state["targetIdentity"]["startedAt"],
                                "newStartedAt": identity["startedAt"],
                                "restartCount": identity["restartCount"],
                                "previousExit": old_exit,
                                "helperExitCode": 0,
                                "ready": True,
                                "httpStatus": 200,
                                "kafkaIdentityUnchanged": True,
                                "peerIdentitiesUnchanged": True,
                                "storageIdentityUnchanged": True,
                            }
                            self.event("reload-accepted", **result)
                            return result
            if self.clock() >= deadline:
                break
            self.sleep(self.config.poll)
        suffix = f": {last_reason}" if last_reason else ""
        raise ReloadError(
            "bounded wait did not observe one clean Mimir process restart and HTTP readiness"
            + suffix
        )

    def _run_locked(self) -> dict[str, Any]:
        try:
            state = self.preflight()
            if not self.config.execute:
                if (
                    self.config.utility_image
                    and self.config.expected_process_start_ticks
                    and self.config.expected_boot_id
                ):
                    helper = helper_spec(
                        helper_name(state["podUID"], state["restartCount"]),
                        self.config.utility_image,
                        TARGETS[self.config.pod].component,
                        state["configSha256"],
                        self.config.expected_process_start_ticks,
                        self.config.expected_boot_id,
                    )
                    self.audit["patchPreview"] = append_ephemeral_patch(
                        state["target"], helper
                    )
                    self.event("plan-patch-ready", helperName=helper["name"])
                else:
                    self.event(
                        "plan-patch-not-built",
                        reason="process identity and utility image flags are optional in plan mode",
                    )
                self.finish("plan")
                return self.audit
            target = self.refresh_before_patch(state)
            helper = helper_spec(
                helper_name(state["podUID"], state["restartCount"]),
                self.config.utility_image or "",
                TARGETS[self.config.pod].component,
                state["configSha256"],
                self.config.expected_process_start_ticks or "",
                self.config.expected_boot_id or "",
            )
            self.patch_ephemeral(target, helper)
            self.audit["result"] = self.wait_for_restart(helper, state)
            self.finish("complete")
            return self.audit
        except ReloadError as exc:
            self.event("failed", reason=redact_text(str(exc), limit=500))
            self.finish("failed")
            raise

    def run(self) -> dict[str, Any]:
        self.validate_config()
        self.event("started")
        try:
            lock_context: Any = (
                OperatorLock(self.config)
                if self.config.execute
                else contextlib.nullcontext()
            )
            with lock_context as lock:
                if isinstance(lock, OperatorLock):
                    self.event("operator-lock-acquired", path=str(lock.path))
                return self._run_locked()
        except ReloadError as exc:
            if self.audit.get("outcome") != "failed":
                self.event("failed", reason=redact_text(str(exc), limit=500))
                self.finish("failed")
            raise


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument(
        "--context", default=os.environ.get("KUBE_CONTEXT", CONTEXT)
    )
    argument_parser.add_argument("--namespace", default=NAMESPACE)
    argument_parser.add_argument(
        "--pod", default=INGESTER_PODS[0], choices=sorted(TARGETS)
    )
    argument_parser.add_argument("--expected-pod-uid")
    argument_parser.add_argument("--expected-container-id")
    argument_parser.add_argument("--expected-config-sha256")
    argument_parser.add_argument("--expected-process-start-ticks")
    argument_parser.add_argument("--expected-boot-id")
    argument_parser.add_argument("--utility-image")
    argument_parser.add_argument("--execute", action="store_true")
    argument_parser.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS
    )
    argument_parser.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS)
    argument_parser.add_argument(
        "--command-timeout", type=float, default=DEFAULT_COMMAND_TIMEOUT_SECONDS
    )
    argument_parser.add_argument("--audit-file", type=Path)
    return argument_parser


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    config = Config(
        context=args.context,
        namespace=args.namespace,
        pod=args.pod,
        expected_pod_uid=args.expected_pod_uid,
        expected_container_id=args.expected_container_id,
        expected_config_sha256=args.expected_config_sha256,
        expected_process_start_ticks=args.expected_process_start_ticks,
        expected_boot_id=args.expected_boot_id,
        utility_image=args.utility_image,
        execute=args.execute,
        timeout=args.timeout,
        poll=args.poll,
        command_timeout=args.command_timeout,
        audit_path=args.audit_file,
    )
    workflow = Workflow(config)
    try:
        result = workflow.run()
    except ReloadError as exc:
        print(f"mimir-container-reload: {redact_text(str(exc))}", file=sys.stderr)
        if config.audit_path is not None:
            print(json.dumps(workflow.audit, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
