"""Archive one drained Talos node's Flannel state while kubelet is standalone.

Run only from the reviewed host-PID, host-network maintenance static pod.
This helper never changes Node objects, Talos configuration, disks, or etcd.
"""

import argparse
import fcntl
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import uuid


class MaintenanceError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise MaintenanceError(message)


def validate_plan(plan):
    require(isinstance(plan, dict), "plan must be an object")
    require(
        set(plan) == {"operation", "nodeName", "bootID", "oldCIDR", "daemonPodUIDs"},
        "plan has missing or unknown fields",
    )
    require(
        isinstance(plan["operation"], str)
        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan["operation"]),
        "invalid operation name",
    )
    require(
        isinstance(plan["nodeName"], str)
        and re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", plan["nodeName"]),
        "invalid node name",
    )
    old = ipaddress.ip_network(plan["oldCIDR"])
    require(
        old.version == 4
        and old.prefixlen in (23, 24)
        and old.subnet_of(ipaddress.ip_network("10.244.0.0/16")),
        "expected a /24 or /23 within 10.244.0.0/16",
    )
    require(str(uuid.UUID(plan["bootID"])) == plan["bootID"], "invalid boot ID")
    uids = plan["daemonPodUIDs"]
    require(isinstance(uids, list) and bool(uids), "daemon UID list is required")
    require(len(set(uids)) == len(uids), "duplicate daemon UID")
    for uid in uids:
        require(str(uuid.UUID(uid)) == uid, "invalid daemon UID")
    return old


def run(*args):
    result = subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=60
    )
    return result.stdout


def cri(*args):
    return run(
        "crictl",
        "--runtime-endpoint",
        "unix:///proc/1/root/run/containerd/containerd.sock",
        *args,
    )


def sandboxes():
    result = []
    for item in json.loads(cri("pods", "-o", "json"))["items"]:
        status = json.loads(cri("inspectp", item["id"]))["status"]
        mode = status["linux"]["namespaces"]["options"]["network"]
        require(mode in ("NODE", "POD"), "unknown sandbox network mode")
        result.append((item["id"], status, mode))
    return result


def standalone():
    matches = []
    for process in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            args = process.read_bytes().split(b"\0")
        except FileNotFoundError:
            continue
        if args and args[0].endswith(b"/kubelet"):
            matches.append(
                not any(
                    arg == b"--kubeconfig" or arg.startswith(b"--kubeconfig=")
                    for arg in args
                )
            )
    with socket.socket() as connection:
        connection.settimeout(1)
        api_closed = connection.connect_ex(("127.0.0.1", 10250)) != 0
    return matches == [True] and api_closed


def check_sandboxes(current, allowed):
    for _, status, mode in current:
        if status["state"] == "SANDBOX_READY" and mode == "POD":
            require(
                status["metadata"]["uid"] in allowed,
                f"undrained pod: {status['metadata']}",
            )


def lease_candidates(directory, old):
    candidates = []
    for entry in directory.iterdir():
        if entry.name == "lock":
            require(not entry.is_symlink(), "CNI lock is a symlink")
            continue
        require(
            entry.is_file() and not entry.is_symlink(),
            f"unexpected CNI entry: {entry.name}",
        )
        address = ipaddress.ip_address(
            entry.read_text().strip()
            if re.fullmatch(r"last_reserved_ip\.[0-9]+", entry.name)
            else entry.name
        )
        require(address in old, f"CNI address outside old subnet: {address}")
        candidates.append(entry)
    return candidates


def validate_links(links, old):
    if "cni0" in links:
        require(
            links["cni0"]["linkinfo"]["info_kind"] == "bridge", "cni0 is not a bridge"
        )
        addresses = json.loads(run("ip", "-j", "addr", "show", "dev", "cni0"))[0][
            "addr_info"
        ]
        for address in addresses:
            if address["family"] == "inet":
                observed = ipaddress.ip_interface(
                    f"{address['local']}/{address['prefixlen']}"
                )
                require(observed.network == old, "bridge has a different subnet")
        deadline = time.monotonic() + 120
        while json.loads(run("bridge", "-j", "link", "show", "master", "cni0")):
            require(time.monotonic() < deadline, "bridge has live ports")
            require(
                standalone(), "standalone boundary changed while CNI detached ports"
            )
            require(
                not any(
                    status["state"] == "SANDBOX_READY" and mode == "POD"
                    for _, status, mode in sandboxes()
                ),
                "pod networking became active while CNI detached ports",
            )
            time.sleep(2)
    if "flannel.1" in links:
        info = links["flannel.1"]["linkinfo"]
        require(
            info["info_kind"] == "vxlan" and info["info_data"]["id"] == 1,
            "flannel.1 has an unexpected type or VXLAN ID",
        )


def save_report(state, report):
    temporary = state / "result.tmp"
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(state / "result.json")


def cleanup(plan, root=Path("/proc/1/root"), retry_failed=False):
    old = validate_plan(plan)
    require(
        (root / "etc/hostname").read_text().strip() == plan["nodeName"], "wrong host"
    )
    require(
        (root / "proc/sys/kernel/random/boot_id").read_text().strip() == plan["bootID"],
        "host rebooted since the plan was captured",
    )
    state = root / "var/lib/podcidr23-ops" / plan["operation"]
    require(not state.is_symlink(), "operation directory is a symlink")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    digest = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
    with (state / "operation.lock").open("a") as operation_lock:
        fcntl.flock(operation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = state / "result.json"
        previous = {}
        if result.exists():
            report = json.loads(result.read_text())
            require(report["planDigest"] == digest, "operation belongs to another plan")
            if report["phase"] == "complete":
                return report
            require(retry_failed, "partial operation requires explicit --retry-failed")
            previous = report
        report = {
            "operation": plan["operation"],
            "nodeName": plan["nodeName"],
            "oldCIDR": str(old),
            "planDigest": digest,
            "phase": "waiting-for-standalone",
            "stopped": previous.get("stopped", []),
            "linksRemoved": previous.get("linksRemoved", []),
        }
        save_report(state, report)
        try:
            deadline = time.monotonic() + 300
            while not standalone():
                require(
                    time.monotonic() < deadline,
                    "standalone kubelet API boundary not established",
                )
                time.sleep(1)
            allowed = set(plan["daemonPodUIDs"])
            current = sandboxes()
            check_sandboxes(current, allowed)
            for identifier, status, _ in current:
                if status["metadata"]["uid"] in allowed:
                    cri("stopp", identifier)
                    cri("rmp", identifier)
                    report["stopped"].append(status["metadata"])
                    save_report(state, report)
            for _, status, mode in sandboxes():
                require(
                    not (status["state"] == "SANDBOX_READY" and mode == "POD"),
                    "pod networking still in use",
                )
                require(
                    status["metadata"]["uid"] not in allowed,
                    "old daemon sandbox still exists",
                )
            require(standalone(), "standalone boundary changed during cleanup")
            lease_dir = root / "var/lib/cni/networks/cbr0"
            require(
                lease_dir.is_dir() and not lease_dir.is_symlink(),
                "missing or unsafe CNI directory",
            )
            require(not (lease_dir / "lock").is_symlink(), "CNI lock is a symlink")
            saved = state / "leases"
            saved.mkdir(mode=0o700, exist_ok=True)
            with (lease_dir / "lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                candidates = lease_candidates(lease_dir, old)
                links = {
                    link["ifname"]: link
                    for link in json.loads(run("ip", "-j", "-d", "link", "show"))
                }
                validate_links(links, old)
                subnet_file = root / "run/flannel/subnet.env"
                require(
                    not subnet_file.is_symlink(), "Flannel subnet file is a symlink"
                )
                if subnet_file.exists():
                    values = dict(
                        line.split("=", 1)
                        for line in subnet_file.read_text().splitlines()
                        if "=" in line
                    )
                    require(
                        ipaddress.ip_interface(values["FLANNEL_SUBNET"]).network == old,
                        "Flannel subnet differs from plan",
                    )
                for entry in candidates:
                    require(
                        not (saved / entry.name).exists(),
                        "archive would overwrite a lease",
                    )
                    entry.replace(saved / entry.name)
                report["leasesArchived"] = sorted(
                    entry.name for entry in saved.iterdir()
                )
                for name in ("cni0", "flannel.1"):
                    if name in links:
                        run("ip", "link", "delete", name)
                        report["linksRemoved"].append(name)
                        save_report(state, report)
                if subnet_file.exists():
                    archive = state / "subnet.env"
                    require(
                        not archive.exists()
                        or archive.read_bytes() == subnet_file.read_bytes(),
                        "subnet archive would change",
                    )
                    shutil.copyfile(subnet_file, archive)
                    archive.chmod(0o600)
                    subnet_file.unlink()
            report["phase"] = "complete"
        except Exception as error:
            report["phase"] = "failed"
            report["error"] = str(error)
            if isinstance(
                error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)
            ):
                diagnostics = {
                    "command": error.cmd,
                    "exitCode": getattr(error, "returncode", None),
                    "timeoutSeconds": getattr(error, "timeout", None),
                }
                for field in ("stdout", "stderr"):
                    value = getattr(error, field, None) or ""
                    if isinstance(value, bytes):
                        value = value.decode("utf-8", errors="replace")
                    diagnostics[field] = value[-8192:]
                    diagnostics[field + "Truncated"] = len(value) > 8192
                report["commandFailure"] = diagnostics
        finally:
            save_report(state, report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument(
        "--hold",
        action="store_true",
        help="keep the static pod alive after writing its result",
    )
    args = parser.parse_args()
    report = cleanup(json.loads(args.plan.read_text()), retry_failed=args.retry_failed)
    print(
        json.dumps(
            {key: report[key] for key in ("operation", "nodeName", "oldCIDR", "phase")}
        ),
        flush=True,
    )
    if args.hold:
        while True:
            time.sleep(60)
    return 0 if report["phase"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
