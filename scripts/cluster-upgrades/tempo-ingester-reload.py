#!/usr/bin/env python3
"""Safely restart one Tempo 2.x ingester container in place.

The default mode is read-only and reports whether the preconditions for a
same-Pod restart are true.  ``--execute`` is deliberately narrow: it appends
one ephemeral container through the Kubernetes ephemeral-containers
subresource, and that helper sends exactly one SIGTERM to the Tempo process
after checking its command line and projected configuration hash.

The script never changes a ConfigMap or StatefulSet, deletes a Pod, or uses a
forced signal.  It is intended to run only after GitOps has staged the
StatefulSet as OnDelete, three Ready ingesters, and the desired projected
configuration.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.error import URLError
from urllib.request import Request, urlopen


class ReloadError(RuntimeError):
    """A safety precondition or bounded postcondition was not met."""


Runner = Callable[[Sequence[str], str | None, float], tuple[int, str, str]]
Clock = Callable[[], float]
Sleeper = Callable[[float], None]


CONTEXT = "galactic-lan"
NAMESPACE = "observability"
DEFAULT_POD = "observability-tempo-ingester-0"
STATEFULSET = "observability-tempo-ingester"
CONFIGMAP = "observability-tempo-config"
CONFIG_KEY = "tempo.yaml"
PDB = "observability-tempo-ingester"
RING_SERVICE = "observability-tempo-distributor"
TARGET_CONTAINER = "ingester"
INGESTER_SELECTOR = (
    "app.kubernetes.io/component=ingester,"
    "app.kubernetes.io/instance=observability-tempo,"
    "app.kubernetes.io/name=tempo"
)
HELPER_PREFIX = "tempo-ingester-term-"
TARGET_UID = 1000
TARGET_GID = 1000
DEFAULT_TIMEOUT_SECONDS = 300.0
DEFAULT_POLL_SECONDS = 5.0
DEFAULT_COMMAND_TIMEOUT_SECONDS = 20.0
MAX_RING_HEARTBEAT_AGE_SECONDS = 60
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
class Config:
    context: str
    namespace: str
    pod: str = DEFAULT_POD
    expected_pod_uid: str | None = None
    expected_container_id: str | None = None
    expected_config_sha256: str | None = None
    expected_process_start_ticks: str | None = None
    expected_boot_id: str | None = None
    utility_image: str | None = None
    execute: bool = False
    statefulset: str = STATEFULSET
    configmap: str = CONFIGMAP
    config_key: str = CONFIG_KEY
    pdb: str = PDB
    ring_service: str = RING_SERVICE
    ring_port: int = 3200
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    poll: float = DEFAULT_POLL_SECONDS
    command_timeout: float = DEFAULT_COMMAND_TIMEOUT_SECONDS
    audit_path: Path | None = None


@dataclass(frozen=True)
class RingSnapshot:
    """The safe subset of the Tempo ring page used by the gate."""

    active_ids: tuple[str, ...]
    fresh_active_ids: tuple[str, ...] = ()
    active_addresses: tuple[tuple[str, str], ...] = ()
    active_heartbeats: tuple[tuple[str, str], ...] = ()


def subprocess_runner(
    argv: Sequence[str], input_text: str | None, timeout: float
) -> tuple[int, str, str]:
    """Run one argv vector without a shell or inherited credentials output."""

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
    """Keep operational evidence while removing likely credential values."""

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


def kubectl(
    config: Config,
    args: Sequence[str],
    runner: Runner,
    *,
    input_text: str | None = None,
) -> str:
    argv = ("kubectl", "--context", config.context, *args)
    code, stdout, stderr = runner(argv, input_text, config.command_timeout)
    if code != 0:
        detail = redact_text(stderr.strip() or stdout.strip(), limit=300)
        raise ReloadError(f"kubectl failed ({code}) for {args[0]}: {detail}")
    return stdout


def get_json(config: Config, args: Sequence[str], runner: Runner) -> Mapping[str, Any]:
    try:
        value = json.loads(kubectl(config, args, runner))
    except json.JSONDecodeError as exc:
        raise ReloadError(f"kubectl returned invalid JSON for {args[0]}") from exc
    if not isinstance(value, Mapping):
        raise ReloadError(f"kubectl returned a non-object for {args[0]}")
    return value


def read_pod(config: Config, pod: str, runner: Runner) -> Mapping[str, Any]:
    return get_json(
        config, ("-n", config.namespace, "get", "pod", pod, "-o", "json"), runner
    )


def read_configmap_hash(config: Config, runner: Runner) -> str:
    payload = get_json(
        config,
        ("-n", config.namespace, "get", "configmap", config.configmap, "-o", "json"),
        runner,
    )
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise ReloadError(f"ConfigMap {config.configmap} has no data map")
    value = data.get(config.config_key)
    if not isinstance(value, str):
        raise ReloadError(
            f"ConfigMap {config.configmap} has no {config.config_key} key"
        )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_ring_page(body: str) -> RingSnapshot:
    """Parse only table rows from Tempo's HTML ring endpoint.

    The endpoint is intentionally fetched through a short-lived port-forward;
    this parser does not accept forms or follow any action links.
    """

    active: list[str] = []
    fresh_active: list[str] = []
    active_addresses: list[tuple[str, str]] = []
    active_heartbeats: list[tuple[str, str]] = []
    rows = re.findall(r"<tr(?:\s[^>]*)?>(.*?)</tr>", body, re.IGNORECASE | re.DOTALL)
    for row in rows:
        cells = re.findall(
            r"<t[dh](?:\s[^>]*)?>(.*?)</t[dh]>", row, re.IGNORECASE | re.DOTALL
        )
        values = [re.sub(r"<[^>]*>", "", html.unescape(cell)).strip() for cell in cells]
        if len(values) < 3 or values[0].lower() == "instance id":
            continue
        if values[2].upper() == "ACTIVE" and values[0]:
            active.append(values[0])
            address = values[3] if len(values) > 3 else ""
            active_addresses.append((values[0], address))
            heartbeat = values[7] if len(values) > 7 else ""
            active_heartbeats.append((values[0], heartbeat))
            if heartbeat_is_fresh(heartbeat):
                fresh_active.append(values[0])
    return RingSnapshot(
        tuple(active),
        tuple(fresh_active),
        tuple(active_addresses),
        tuple(active_heartbeats),
    )


def heartbeat_is_fresh(value: str) -> bool:
    match = re.match(r"^\s*(\d+)\s*([smhd])\s+ago\b", value, re.IGNORECASE)
    if match is None:
        return value.strip().lower() in {"just now", "now"}
    amount = int(match.group(1))
    seconds = amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2).lower()]
    return seconds <= MAX_RING_HEARTBEAT_AGE_SECONDS


def ring_host(address: str) -> str:
    if address.startswith("[") and "]" in address:
        return address[1:].split("]", 1)[0]
    if address.count(":") == 1:
        return address.rsplit(":", 1)[0]
    return address


class PortForward:
    """Short-lived read-only port-forward with TERM-only cleanup."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.process: subprocess.Popen[str] | None = None
        self.local_port: int | None = None

    @staticmethod
    def free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def __enter__(self) -> "PortForward":
        try:
            self.local_port = self.free_port()
            try:
                self.process = subprocess.Popen(
                    [
                        "kubectl",
                        "--context",
                        self.config.context,
                        "-n",
                        self.config.namespace,
                        "port-forward",
                        f"service/{self.config.ring_service}",
                        f"{self.local_port}:{self.config.ring_port}",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
            except OSError as exc:
                raise ReloadError("unable to start Tempo ring port-forward") from exc
            deadline = time.monotonic() + min(self.config.timeout, 30.0)
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise ReloadError(
                        "Tempo ring port-forward exited before becoming ready"
                    )
                try:
                    self.request("/ready")
                    return self
                except (OSError, URLError):
                    time.sleep(0.25)
            raise ReloadError("Tempo ring port-forward did not become ready")
        except BaseException:
            self._stop()
            raise

    def request(self, path: str) -> str:
        if self.local_port is None:
            raise ReloadError("ring port-forward is not active")
        request = Request(f"http://127.0.0.1:{self.local_port}{path}", method="GET")
        with urlopen(
            request, timeout=min(self.config.command_timeout, 10.0)
        ) as response:
            return response.read().decode("utf-8", errors="replace")

    def _stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(timeout=5.0)
        except subprocess.TimeoutExpired as exc:
            raise ReloadError("ring port-forward did not exit after SIGTERM") from exc

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        del exc_type, exc_value, traceback
        self._stop()


def read_ring(config: Config, _runner: Runner) -> RingSnapshot:
    """Fetch the distributor's read-only ingester ring page and close cleanly."""

    with PortForward(config) as port_forward:
        return parse_ring_page(port_forward.request("/ingester/ring"))


def ring_evidence(ring: RingSnapshot) -> dict[str, Any]:
    """Return JSON-native ring evidence suitable for audit and stdout output."""

    return {
        "activeIDs": list(ring.active_ids),
        "freshActiveIDs": list(ring.fresh_active_ids),
        "activeAddresses": {name: address for name, address in ring.active_addresses},
        "heartbeats": {name: heartbeat for name, heartbeat in ring.active_heartbeats},
    }


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
    raise ReloadError(
        f"Pod {pod.get('metadata', {}).get('name', '<unknown>')} has no {name} status"
    )


def observe_target(
    pod: Mapping[str, Any], *, require_container_id: bool
) -> tuple[str, str, int, str | None, str | None, bool, bool]:
    """Read a Pod identity, tolerating a transient missing ID during restart."""

    metadata = pod.get("metadata")
    if not isinstance(metadata, Mapping):
        raise ReloadError("target Pod has no metadata")
    uid = metadata.get("uid")
    resource_version = metadata.get("resourceVersion")
    if (
        not isinstance(uid, str)
        or not uid
        or not isinstance(resource_version, str)
        or not resource_version
    ):
        raise ReloadError("target Pod is missing UID or resourceVersion")
    if metadata.get("deletionTimestamp") is not None:
        raise ReloadError("target Pod is terminating")
    status = find_container_status(pod, TARGET_CONTAINER)
    raw_container_id = status.get("containerID")
    container_id: str | None
    if raw_container_id is None:
        container_id = None
    elif isinstance(raw_container_id, str) and CONTAINER_ID_RE.fullmatch(
        raw_container_id
    ):
        container_id = raw_container_id
    else:
        raise ReloadError("Tempo ingester containerID is malformed")
    if require_container_id and container_id is None:
        raise ReloadError("Tempo ingester containerID is missing or malformed")
    restart_count = status.get("restartCount", 0)
    if (
        not isinstance(restart_count, int)
        or isinstance(restart_count, bool)
        or restart_count < 0
    ):
        raise ReloadError("Tempo ingester restartCount is invalid")
    state = status.get("state")
    running_state = state.get("running") if isinstance(state, Mapping) else None
    running = isinstance(running_state, Mapping)
    started_at = running_state.get("startedAt") if running else None
    if started_at is not None and not isinstance(started_at, str):
        raise ReloadError("Tempo ingester startedAt is malformed")
    ready = status.get("ready") is True and condition_true(pod, "Ready")
    return (
        uid,
        resource_version,
        restart_count,
        container_id,
        started_at,
        running,
        ready,
    )


def target_identity(pod: Mapping[str, Any]) -> tuple[str, str, int, bool, bool]:
    """Read the strict identity required before patching an ephemeral helper."""

    uid, resource_version, restart_count, _container_id, _started_at, running, ready = (
        observe_target(pod, require_container_id=True)
    )
    return uid, resource_version, restart_count, running, ready


def runtime_identity(pod: Mapping[str, Any]) -> tuple[str, str]:
    """Return the running container ID and start timestamp for restart fencing."""

    (
        _uid,
        _resource_version,
        _restart_count,
        container_id,
        started_at,
        running,
        _ready,
    ) = observe_target(pod, require_container_id=True)
    if not running or not isinstance(started_at, str) or not started_at:
        raise ReloadError("Tempo ingester has no running startedAt")
    if container_id is None:
        raise ReloadError("Tempo ingester containerID is missing or malformed")
    return container_id, started_at


def validate_target_identity(
    pod: Mapping[str, Any],
    *,
    expected_uid: str | None,
    expected_container_id: str | None,
    expected_restart_count: int | None = None,
) -> tuple[str, str, int]:
    uid, resource_version, restart_count, _container_id, _started_at, running, ready = (
        observe_target(pod, require_container_id=True)
    )
    if expected_uid is not None and uid != expected_uid:
        raise ReloadError(
            f"target Pod UID changed: expected {expected_uid}, observed {uid}"
        )
    status = find_container_status(pod, TARGET_CONTAINER)
    container_id = status["containerID"]
    if expected_container_id is not None and container_id != expected_container_id:
        raise ReloadError("target Tempo containerID changed")
    if expected_restart_count is not None and restart_count != expected_restart_count:
        raise ReloadError(
            f"target restartCount changed: expected {expected_restart_count}, observed {restart_count}"
        )
    if not running:
        raise ReloadError("target Tempo ingester container is not Running")
    if not ready:
        raise ReloadError("target Tempo ingester Pod/container is not Ready")
    return uid, resource_version, restart_count


def validate_statefulset(sts: Mapping[str, Any]) -> None:
    spec = sts.get("spec")
    if not isinstance(spec, Mapping):
        raise ReloadError("Tempo ingester StatefulSet has no spec")
    if spec.get("replicas") != 3:
        raise ReloadError(
            f"Tempo ingester StatefulSet replicas must be 3, observed {spec.get('replicas')!r}"
        )
    strategy = spec.get("updateStrategy")
    if not isinstance(strategy, Mapping) or strategy.get("type") != "OnDelete":
        observed = strategy.get("type") if isinstance(strategy, Mapping) else None
        raise ReloadError(
            f"Tempo ingester StatefulSet must use OnDelete, observed {observed!r}"
        )


def pod_is_ready_ingester(pod: Mapping[str, Any]) -> bool:
    if pod.get("metadata", {}).get("deletionTimestamp") is not None:
        return False
    if pod.get("status", {}).get("phase") != "Running" or not condition_true(
        pod, "Ready"
    ):
        return False
    try:
        status = find_container_status(pod, TARGET_CONTAINER)
    except ReloadError:
        return False
    state = status.get("state")
    return (
        status.get("ready") is True
        and isinstance(state, Mapping)
        and isinstance(state.get("running"), Mapping)
    )


def ready_ingester_details(
    pods: Mapping[str, Any],
) -> tuple[tuple[str, ...], dict[str, str], dict[str, str]]:
    items = pods.get("items")
    if not isinstance(items, list) or len(items) != 3:
        observed = len(items) if isinstance(items, list) else 0
        raise ReloadError(
            f"expected exactly 3 Tempo ingester Pods, observed {observed}"
        )
    names: list[str] = []
    pod_ips: dict[str, str] = {}
    pod_nodes: dict[str, str] = {}
    for pod in items:
        if not isinstance(pod, Mapping) or not pod_is_ready_ingester(pod):
            name = (
                pod.get("metadata", {}).get("name", "<unknown>")
                if isinstance(pod, Mapping)
                else "<unknown>"
            )
            raise ReloadError(f"Tempo ingester Pod {name} is not Ready")
        name = pod.get("metadata", {}).get("name")
        if not isinstance(name, str) or not name:
            raise ReloadError("Ready Tempo ingester is missing a name")
        pod_ip = pod.get("status", {}).get("podIP")
        if not isinstance(pod_ip, str) or not pod_ip:
            raise ReloadError(f"Ready Tempo ingester Pod {name} is missing podIP")
        node_name = pod.get("spec", {}).get("nodeName")
        if not isinstance(node_name, str) or not node_name:
            raise ReloadError(f"Tempo ingester Pod {name} is missing nodeName")
        names.append(name)
        pod_ips[name] = pod_ip
        pod_nodes[name] = node_name
    if len(set(names)) != 3:
        raise ReloadError("Tempo ingester Pod list contains duplicate names")
    if len(set(pod_nodes.values())) != 3:
        raise ReloadError(
            "Tempo ingester Ready Pods must run on 3 unique nodes; "
            f"observed {sorted(pod_nodes.values())!r}"
        )
    return tuple(sorted(names)), pod_ips, pod_nodes


def ready_ingester_names(pods: Mapping[str, Any]) -> tuple[str, ...]:
    """Return names for callers that do not need the endpoint identity map."""

    names, _pod_ips, _pod_nodes = ready_ingester_details(pods)
    return names


def validate_pdb(pdb: Mapping[str, Any]) -> None:
    allowed = pdb.get("status", {}).get("disruptionsAllowed")
    if allowed != 1:
        raise ReloadError(
            f"Tempo ingester PDB disruptionsAllowed must be 1, observed {allowed!r}"
        )
    maximum = pdb.get("spec", {}).get("maxUnavailable")
    if maximum not in (1, "1"):
        raise ReloadError(
            f"Tempo ingester PDB maxUnavailable must be 1, observed {maximum!r}"
        )


def validate_ring(
    ring: RingSnapshot,
    ready_names: Sequence[str],
    ready_ips: Mapping[str, str] | None = None,
) -> None:
    if len(ring.active_ids) != 3 or len(set(ring.active_ids)) != 3:
        raise ReloadError(
            f"Tempo ingester ring must have 3 unique ACTIVE members, observed {ring.active_ids!r}"
        )
    if set(ring.fresh_active_ids) != set(ring.active_ids):
        raise ReloadError(
            f"Tempo ingester ring has stale or unreadable heartbeats: active={sorted(ring.active_ids)!r} "
            f"fresh={sorted(ring.fresh_active_ids)!r}"
        )
    if set(ring.active_ids) != set(ready_names):
        raise ReloadError(
            f"Tempo ring ACTIVE members do not match Ready Pods: ring={sorted(ring.active_ids)!r} "
            f"ready={sorted(ready_names)!r}"
        )
    if ready_ips is not None:
        addresses = dict(ring.active_addresses)
        for name in ready_names:
            observed = ring_host(addresses.get(name, ""))
            if not observed or observed != ready_ips.get(name):
                raise ReloadError(
                    f"Tempo ring address does not match Ready Pod {name}: "
                    f"ring={addresses.get(name)!r} podIP={ready_ips.get(name)!r}"
                )


def helper_name(uid: str, restart_count: int) -> str:
    return f"{HELPER_PREFIX}{restart_count}-{uid[:8]}"


def validate_sha256(value: str, label: str) -> None:
    if not SHA256_RE.fullmatch(value):
        raise ReloadError(
            f"{label} must be exactly 64 lowercase hexadecimal characters"
        )


def validate_process_start_ticks(
    value: str, label: str = "expected process start ticks"
) -> None:
    if not PROCESS_START_TICKS_RE.fullmatch(value):
        raise ReloadError(f"{label} must be a non-negative decimal tick count")


def validate_boot_id(value: str, label: str = "expected boot ID") -> None:
    if not BOOT_ID_RE.fullmatch(value):
        raise ReloadError(f"{label} must be a lowercase UUID")


def validate_utility_image(value: str) -> None:
    if not IMAGE_DIGEST_RE.fullmatch(value):
        raise ReloadError("utility image must be an explicit @sha256: digest pin")


def helper_script(
    expected_sha256: str,
    expected_process_start_ticks: str,
    expected_boot_id: str,
) -> str:
    validate_sha256(expected_sha256, "expected config SHA-256")
    validate_process_start_ticks(expected_process_start_ticks)
    validate_boot_id(expected_boot_id)
    incarnation_checks = f'''boot_id="$(tr -d '\\n' </proc/sys/kernel/random/boot_id)"
if [ "$boot_id" != "{expected_boot_id}" ]; then
  printf '%s\\n' 'kernel boot ID changed since the process identity was captured' >&2
  exit 43
fi
stat_line="$(tr -d '\\n' </proc/1/stat)"
case "$stat_line" in
  "1 ("*) ;;
  *) printf '%s\\n' 'target PID 1 stat record is malformed' >&2; exit 44 ;;
esac
stat_fields="${{stat_line##*) }}"
set -- $stat_fields
field=3
start_ticks=""
while [ "$#" -gt 0 ]; do
  if [ "$field" -eq 22 ]; then
    start_ticks="$1"
    break
  fi
  shift
  field=$((field + 1))
done
if [ "$start_ticks" != "{expected_process_start_ticks}" ]; then
  printf '%s\\n' 'target Tempo process start ticks changed' >&2
  exit 45
fi
'''
    return f"""set -eu
cmd=\"$(tr '\\000' ' ' </proc/1/cmdline)\"
case \"$cmd\" in
  \"/tempo \"*\"-target=ingester\"*\"-config.file=/conf/tempo.yaml\"*) ;;
  *) printf '%s\\n' 'target PID 1 is not the expected Tempo ingester' >&2; exit 41 ;;
esac
digest_output=\"$(sha256sum /proc/1/root/conf/tempo.yaml)\"
digest=\"${{digest_output%% *}}\"
if [ \"$digest\" != \"{expected_sha256}\" ]; then
  printf '%s\\n' 'projected Tempo configuration hash does not match the authoritative ConfigMap' >&2
  exit 42
fi
{incarnation_checks}kill -0 1
kill -TERM 1
"""


def helper_spec(
    name: str,
    image: str,
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
                expected_sha256,
                expected_process_start_ticks,
                expected_boot_id,
            ),
        ],
        "targetContainerName": TARGET_CONTAINER,
        "securityContext": {
            "runAsUser": TARGET_UID,
            "runAsGroup": TARGET_GID,
            "runAsNonRoot": True,
            "allowPrivilegeEscalation": False,
            "privileged": False,
            "capabilities": {"drop": ["ALL"]},
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


def redact_lifecycle_logs(output: str) -> list[str]:
    lines: list[str] = []
    for raw_line in output.splitlines():
        if not re.search(
            r"(?i)wal|replay|flush|shutdown|ready|started|stopping|error|failed",
            raw_line,
        ):
            continue
        lines.append(redact_text(raw_line, limit=500))
        if len(lines) >= 80:
            break
    return lines


def previous_exit(status: Mapping[str, Any]) -> dict[str, Any]:
    last = status.get("lastState")
    terminated = last.get("terminated") if isinstance(last, Mapping) else None
    if not isinstance(terminated, Mapping):
        raise ReloadError(
            "restarted Tempo container has no previous termination status"
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
        raise ReloadError("Tempo ingester was force- or OOM-terminated")
    if exit_code != 0 or terminated.get("signal") not in (None, 0):
        raise ReloadError(
            f"Tempo ingester did not exit gracefully: exitCode={exit_code!r}"
        )
    return evidence


def ephemeral_status(pod: Mapping[str, Any], name: str) -> Mapping[str, Any] | None:
    statuses = pod.get("status", {}).get("ephemeralContainerStatuses", [])
    if isinstance(statuses, list):
        for status in statuses:
            if isinstance(status, Mapping) and status.get("name") == name:
                return status
    return None


class Workflow:
    def __init__(
        self,
        config: Config,
        runner: Runner = subprocess_runner,
        *,
        clock: Clock = time.monotonic,
        sleep: Sleeper = time.sleep,
        ring_reader: Callable[[Config, Runner], RingSnapshot] = read_ring,
    ) -> None:
        self.config = config
        self.runner = runner
        self.clock = clock
        self.sleep = sleep
        self.ring_reader = ring_reader
        self.audit: dict[str, Any] = {
            "metadata": {
                "mode": "execute" if config.execute else "plan",
                "context": config.context,
                "namespace": config.namespace,
                "pod": config.pod,
                "targetContainer": TARGET_CONTAINER,
            },
            "events": [],
        }

    def event(self, name: str, **values: Any) -> None:
        self.audit["events"].append({"name": name, **values})

    def finish(self, outcome: str) -> None:
        self.audit["outcome"] = outcome
        if self.config.audit_path is not None:
            self.config.audit_path.write_text(
                json.dumps(self.audit, indent=2) + "\n", encoding="utf-8"
            )

    def validate_config(self) -> None:
        if not self.config.context.strip() or not self.config.namespace.strip():
            raise ReloadError("--context and --namespace are required")
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
                "--expected-process-start-ticks and --expected-boot-id must be supplied together"
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
        missing = [
            flag
            for flag, value in (
                ("--expected-pod-uid", self.config.expected_pod_uid),
                ("--expected-container-id", self.config.expected_container_id),
                ("--expected-config-sha256", self.config.expected_config_sha256),
                (
                    "--expected-process-start-ticks",
                    self.config.expected_process_start_ticks,
                ),
                ("--expected-boot-id", self.config.expected_boot_id),
                ("--utility-image", self.config.utility_image),
            )
            if not value
        ]
        if missing:
            raise ReloadError(f"--execute requires explicit {', '.join(missing)}")
        if self.config.utility_image != APPROVED_UTILITY_IMAGE:
            raise ReloadError(
                "--utility-image is not the approved busybox multi-platform digest"
            )
        if not CONTAINER_ID_RE.fullmatch(self.config.expected_container_id or ""):
            raise ReloadError("--expected-container-id is malformed")

    def preflight(self) -> dict[str, Any]:
        sts = get_json(
            self.config,
            (
                "-n",
                self.config.namespace,
                "get",
                "statefulset",
                self.config.statefulset,
                "-o",
                "json",
            ),
            self.runner,
        )
        validate_statefulset(sts)
        pods = get_json(
            self.config,
            (
                "-n",
                self.config.namespace,
                "get",
                "pods",
                "-l",
                INGESTER_SELECTOR,
                "-o",
                "json",
            ),
            self.runner,
        )
        ready_names, ready_ips, ready_nodes = ready_ingester_details(pods)
        pdb = get_json(
            self.config,
            ("-n", self.config.namespace, "get", "pdb", self.config.pdb, "-o", "json"),
            self.runner,
        )
        validate_pdb(pdb)
        ring = self.ring_reader(self.config, self.runner)
        validate_ring(ring, ready_names, ready_ips)
        authoritative_hash = read_configmap_hash(self.config, self.runner)
        if (
            self.config.expected_config_sha256 is not None
            and authoritative_hash != self.config.expected_config_sha256
        ):
            raise ReloadError(
                "authoritative ConfigMap hash does not match --expected-config-sha256"
            )
        target = read_pod(self.config, self.config.pod, self.runner)
        uid, resource_version, restart_count = validate_target_identity(
            target,
            expected_uid=self.config.expected_pod_uid,
            expected_container_id=self.config.expected_container_id,
        )
        container_id, started_at = runtime_identity(target)
        ephemeral = target.get("spec", {}).get("ephemeralContainers", [])
        if not isinstance(ephemeral, list):
            raise ReloadError("target Pod ephemeralContainers is not a list")
        if any(
            isinstance(item, Mapping)
            and str(item.get("name", "")).startswith(HELPER_PREFIX)
            for item in ephemeral
        ):
            raise ReloadError(
                "target Pod already has a Tempo reload helper; refusing a blind repeat"
            )
        self.event(
            "preflight-ready",
            statefulSetReplicas=3,
            readyIngesterPods=list(ready_names),
            readyIngesterIPs=ready_ips,
            readyIngesterNodes=ready_nodes,
            activeRingMembers=list(ring.active_ids),
            ring=ring_evidence(ring),
            pdbDisruptionsAllowed=1,
            authoritativeConfigSHA256=authoritative_hash,
            podUID=uid,
            resourceVersion=resource_version,
            restartCount=restart_count,
            containerID=container_id,
            startedAt=started_at,
            expectedProcessStartTicks=self.config.expected_process_start_ticks,
            expectedBootID=self.config.expected_boot_id,
            existingEphemeralCount=len(ephemeral),
        )
        return {
            "target": target,
            "uid": uid,
            "resourceVersion": resource_version,
            "restartCount": restart_count,
            "containerID": container_id,
            "startedAt": started_at,
            "configSha256": authoritative_hash,
            "readyNames": ready_names,
            "readyIPs": ready_ips,
            "readyNodes": ready_nodes,
            "ring": ring_evidence(ring),
            "ephemeral": ephemeral,
        }

    def refresh_before_patch(self, state: Mapping[str, Any]) -> Mapping[str, Any]:
        current_hash = read_configmap_hash(self.config, self.runner)
        if current_hash != state["configSha256"]:
            raise ReloadError(
                "authoritative ConfigMap changed during preflight; refusing TERM"
            )
        target = read_pod(self.config, self.config.pod, self.runner)
        uid, resource_version, restart_count = validate_target_identity(
            target,
            expected_uid=self.config.expected_pod_uid,
            expected_container_id=self.config.expected_container_id,
            expected_restart_count=state["restartCount"],
        )
        if uid != state["uid"]:
            raise ReloadError("target Pod UID changed during preflight")
        ephemeral = target.get("spec", {}).get("ephemeralContainers", [])
        if not isinstance(ephemeral, list):
            raise ReloadError("target Pod ephemeralContainers is not a list")
        if any(
            isinstance(item, Mapping)
            and str(item.get("name", "")).startswith(HELPER_PREFIX)
            for item in ephemeral
        ):
            raise ReloadError(
                "target Pod gained a Tempo reload helper during preflight"
            )
        self.event(
            "identity-fenced",
            podUID=uid,
            resourceVersion=resource_version,
            restartCount=restart_count,
        )
        return target

    def patch_ephemeral(
        self, target: Mapping[str, Any], helper: Mapping[str, Any]
    ) -> None:
        patch = append_ephemeral_patch(target, helper)
        patch_json = json.dumps(patch, separators=(",", ":"))
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
                patch_json,
            ),
            self.runner,
        )
        self.event(
            "ephemeral-appended", helperName=helper["name"], patchOperations=len(patch)
        )

    def capture_logs(self, *, previous: bool) -> list[str]:
        argv = (
            "kubectl",
            "--context",
            self.config.context,
            "-n",
            self.config.namespace,
            "logs",
            self.config.pod,
            "-c",
            TARGET_CONTAINER,
            "--tail",
            "200",
        )
        if previous:
            argv += ("--previous",)
        code, stdout, stderr = self.runner(argv, None, self.config.command_timeout)
        if code != 0:
            raise ReloadError(
                f"{'previous' if previous else 'current'} Tempo ingester logs were unavailable after restart: "
                + redact_text(stderr.strip() or stdout.strip(), limit=240)
            )
        return redact_lifecycle_logs(stdout)

    def capture_previous_shutdown_logs(self) -> list[str]:
        """Capture the terminated container's bounded shutdown evidence."""

        return self.capture_logs(previous=True)

    def capture_current_startup_logs(self) -> list[str]:
        """Capture current bounded startup logs without claiming WAL replay."""

        return self.capture_logs(previous=False)

    def wait_for_restart(
        self, helper: Mapping[str, Any], state: Mapping[str, Any]
    ) -> dict[str, Any]:
        expected_restart = int(state["restartCount"]) + 1
        deadline = self.clock() + self.config.timeout
        old_exit: dict[str, Any] | None = None
        helper_done = False
        last_ring_error: str | None = None
        while self.clock() <= deadline:
            pod = read_pod(self.config, self.config.pod, self.runner)
            (
                uid,
                _resource_version,
                restart_count,
                container_id,
                started_at,
                running,
                ready,
            ) = observe_target(pod, require_container_id=False)
            if uid != state["uid"]:
                raise ReloadError("target Pod UID changed during restart")
            if restart_count > expected_restart:
                raise ReloadError(
                    "Tempo ingester restarted more than once during one helper attempt"
                )
            status = find_container_status(pod, TARGET_CONTAINER)
            identity_changed = (
                isinstance(container_id, str)
                and isinstance(started_at, str)
                and container_id != state["containerID"]
                and started_at != state["startedAt"]
            )
            if restart_count == expected_restart and identity_changed:
                last_state = status.get("lastState")
                terminated = (
                    last_state.get("terminated")
                    if isinstance(last_state, Mapping)
                    else None
                )
                if isinstance(terminated, Mapping):
                    old_exit = previous_exit(status)
            helper_state = ephemeral_status(pod, str(helper["name"]))
            if helper_state is not None:
                terminated = helper_state.get("state", {}).get("terminated")
                if isinstance(terminated, Mapping):
                    code = terminated.get("exitCode")
                    if code != 0:
                        raise ReloadError(
                            f"Tempo reload helper exited unsuccessfully: {code!r}"
                        )
                    helper_done = True
            if (
                helper_done
                and restart_count == expected_restart
                and running
                and ready
                and identity_changed
                and old_exit is not None
            ):
                try:
                    pods = get_json(
                        self.config,
                        (
                            "-n",
                            self.config.namespace,
                            "get",
                            "pods",
                            "-l",
                            INGESTER_SELECTOR,
                            "-o",
                            "json",
                        ),
                        self.runner,
                    )
                    current_names, current_ips, current_nodes = ready_ingester_details(
                        pods
                    )
                    if (
                        current_names != state["readyNames"]
                        or current_ips != state["readyIPs"]
                        or current_nodes != state["readyNodes"]
                    ):
                        raise ReloadError(
                            "Ready ingester membership, Pod IP, or node changed during restart"
                        )
                    ring = self.ring_reader(self.config, self.runner)
                    validate_ring(ring, current_names, current_ips)
                except ReloadError as exc:
                    last_ring_error = redact_text(str(exc), limit=300)
                    self.event("ring-not-yet-ready", reason=last_ring_error)
                else:
                    previous_shutdown_logs = self.capture_previous_shutdown_logs()
                    current_startup_logs = self.capture_current_startup_logs()
                    evidence = ring_evidence(ring)
                    self.event(
                        "restart-accepted",
                        previousExit=old_exit,
                        previousShutdownLogs=previous_shutdown_logs,
                        currentStartupLogs=current_startup_logs,
                        ring=evidence,
                        activeRingMembers=list(ring.active_ids),
                        oldContainerID=state["containerID"],
                        newContainerID=container_id,
                        oldStartedAt=state["startedAt"],
                        newStartedAt=started_at,
                    )
                    return {
                        "restartCount": restart_count,
                        "previousExit": old_exit,
                        "previousShutdownLogs": previous_shutdown_logs,
                        "currentStartupLogs": current_startup_logs,
                        "ring": evidence,
                        "oldContainerID": state["containerID"],
                        "newContainerID": container_id,
                        "oldStartedAt": state["startedAt"],
                        "newStartedAt": started_at,
                    }
            if self.clock() >= deadline:
                break
            self.sleep(self.config.poll)
        detail = f"; last ring error: {last_ring_error}" if last_ring_error else ""
        raise ReloadError(
            "bounded wait did not observe helper exit, one Tempo restart, Ready, and ACTIVE ring"
            + detail
        )

    def run(self) -> dict[str, Any]:
        self.validate_config()
        self.event("started")
        try:
            state = self.preflight()
            if not self.config.execute:
                if (
                    self.config.utility_image is not None
                    and self.config.expected_process_start_ticks is not None
                    and self.config.expected_boot_id is not None
                ):
                    helper = helper_spec(
                        helper_name(state["uid"], state["restartCount"]),
                        self.config.utility_image,
                        state["configSha256"],
                        self.config.expected_process_start_ticks,
                        self.config.expected_boot_id,
                    )
                    target = state["target"]
                    self.audit["patchPreview"] = append_ephemeral_patch(target, helper)
                    self.event("plan-patch-ready", helperName=helper["name"])
                elif self.config.utility_image is not None:
                    self.event(
                        "plan-patch-not-built",
                        reason="process incarnation flags omitted; execute requires both",
                    )
                else:
                    self.event("plan-patch-not-built", reason="--utility-image omitted")
                self.finish("plan")
                return self.audit
            target = self.refresh_before_patch(state)
            image = self.config.utility_image
            expected_hash = self.config.expected_config_sha256
            if image is None or expected_hash is None:
                raise ReloadError("execute configuration lost required helper inputs")
            helper = helper_spec(
                helper_name(state["uid"], state["restartCount"]),
                image,
                expected_hash,
                self.config.expected_process_start_ticks,
                self.config.expected_boot_id,
            )
            self.patch_ephemeral(target, helper)
            result = self.wait_for_restart(helper, state)
            self.audit["result"] = result
            self.finish("complete")
            return self.audit
        except ReloadError as exc:
            self.event("failed", reason=redact_text(str(exc), limit=500))
            self.finish("failed")
            raise


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--context", required=True)
    argument_parser.add_argument("--namespace", required=True)
    argument_parser.add_argument("--pod", default=DEFAULT_POD)
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
        print(f"tempo-ingester-reload: {redact_text(str(exc))}", file=sys.stderr)
        if config.audit_path is not None:
            print(json.dumps(workflow.audit, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
