"""Clean the existing registry filesystem without restarting its serving processes."""

import contextlib
import csv
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import time
import urllib.error
import urllib.request

from cleanup import Store, checked_path, validate_receipt

ROOT = Path("/var/lib/registry/docker/registry/v2")
CONTROL = Path("/control")
WRITERS = ("registry_write", "registry_manifest_write")


def report(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def atomic_json(path, value):
    atomic_text(path, json.dumps(value) + "\n")


def atomic_text(path, value):
    temporary = path.with_suffix(".pending")
    with temporary.open("w") as output:
        os.chmod(temporary, 0o660)
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


class WriteGate:
    def __init__(self, control=CONTROL, base_url="http://127.0.0.1:8080"):
        self.control = Path(control)
        self.base_url = base_url

    def command(self, command):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3)
            connection.connect(str(self.control / "admin.sock"))
            connection.sendall((command + "\n").encode())
            connection.shutdown(socket.SHUT_WR)
            result = bytearray()
            while chunk := connection.recv(65536):
                result.extend(chunk)
        return result.decode().strip()

    def update(self, command):
        result = self.command(command)
        if result:
            raise RuntimeError(f"HAProxy rejected {command!r}: {result}")

    def map_value(self, value):
        atomic_text(self.control / "freeze.map", f"freeze {value}\n")
        self.update(f"set map {self.control}/freeze.map freeze {value}")

    def open(self):
        for backend in WRITERS:
            self.update(f"set server {backend}/registry state ready")
        self.map_value(0)
        self.require_open()
        report("uploads-open")

    def require_map(self, value):
        entries = self.command(f"show map {self.control}/freeze.map").splitlines()
        if sum(line.split()[-2:] == ["freeze", str(value)] for line in entries) != 1:
            raise RuntimeError("Registry proxy runtime gate has an unexpected value")
        if (self.control / "freeze.map").read_text() != f"freeze {value}\n":
            raise RuntimeError("Registry proxy restart gate has an unexpected value")

    def require_open(self):
        self.require_map(0)
        if any(row["status"].startswith("MAINT") for row in self.writers()):
            raise RuntimeError("Registry writer servers are still fenced")

    def writers(self):
        rows = csv.DictReader(io.StringIO(self.command("show stat").lstrip("# ")))
        result = [
            row
            for row in rows
            if row["pxname"] in WRITERS and row["svname"] == "registry"
        ]
        if {row["pxname"] for row in result} != set(WRITERS):
            raise RuntimeError("HAProxy did not report both registry writer servers")
        return result

    def require_frozen(self):
        self.require_map(1)
        if any(
            not row["status"].startswith("MAINT") or int(row["scur"]) != 0
            for row in self.writers()
        ):
            raise RuntimeError("Registry writer sessions are still active")
        with urllib.request.urlopen(self.base_url + "/v2/", timeout=3) as response:
            if response.status != 200:
                raise RuntimeError("Registry reads are unavailable")
        request = urllib.request.Request(
            self.base_url + "/v2/ceph-smoke/registry-gc-check/blobs/uploads/",
            b"",
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=3):
                pass
        except urllib.error.HTTPError as error:
            if error.code == 405:
                return
            raise
        raise RuntimeError("Registry accepts uploads while cleanup is frozen")

    @contextlib.contextmanager
    def frozen(self, deadline):
        try:
            self.map_value(1)
            for backend in WRITERS:
                self.update(f"set server {backend}/registry state maint")
            while any(int(row["scur"]) for row in self.writers()):
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "Registry uploads did not drain within the budget"
                    )
                time.sleep(0.1)
            self.require_frozen()
            report("uploads-frozen")
            yield
        finally:
            self.open()


@contextlib.contextmanager
def budget(seconds):
    def expired(*_):
        raise TimeoutError(f"Registry maintenance exceeded its {seconds}s budget")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def references(message):
    values = message["references"]
    if (
        not isinstance(values, list)
        or not values
        or not all(isinstance(value, str) for value in values)
    ):
        raise ValueError("A nonempty image-protection snapshot is required")
    return values


def code_hashes():
    return {
        name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ["cleanup.py", "maintenance.py"]
    }


def process_start(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def locked(root):
    quarantine = checked_path(root / "_gc_quarantine")
    quarantine.mkdir(exist_ok=True)
    handle = checked_path(quarantine / ".cleanup.lock").open("a+b")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        handle.close()
        raise
    return handle


def purge(store, batch, storage):
    with budget(3600):
        result = store.purge(batch, storage["pvcUid"], storage["pv"])
    report("purged", batch=batch, **result)
    return result


def run(run_id):
    message = json.loads(sys.stdin.readline())
    protected = references(message)
    storage = message["storage"]
    if message["code"] != code_hashes():
        raise RuntimeError(
            "Cleanup Job and registry Pod have different script revisions"
        )
    if not all(
        isinstance(storage.get(key), str) and storage[key] for key in ["pvcUid", "pv"]
    ):
        raise ValueError("The current registry claim and PV identities are required")
    gate = WriteGate()
    with locked(ROOT):
        cancelled = CONTROL / ("cancel-" + run_id)
        if cancelled.exists():
            cancelled.unlink()
            raise InterruptedError("Cleanup was stopped before its worker started")
        owner = CONTROL / "worker.json"
        atomic_json(
            owner,
            {
                "run": run_id,
                "pid": os.getpid(),
                "start": process_start(os.getpid()),
                "boot": boot_id(),
            },
        )
        try:
            gate.open()
            quarantine = Store(ROOT / "_gc_quarantine", workers=8)
            for batch in sorted(quarantine.root.iterdir()):
                if batch.name.startswith(
                    ("registry-collect-", ".purged-registry-collect-")
                ):
                    purge(quarantine, batch.name.removeprefix(".purged-"), storage)
            store = Store(ROOT, workers=32)
            report("prepare")
            with budget(2700):
                plan = {**store.prepare(protected, prune_tags=True), **storage}
            if not plan["blobs"] and not plan["deleteTags"]:
                report("complete", deletedTags=0, deletedBlobs=0, deletedBytes=0)
                return
            report("refresh-references", run=run_id, candidates=len(plan["blobs"]))
            with budget(90):
                protected = references(json.loads(sys.stdin.readline()))
            batch = "registry-collect-" + run_id
            deadline = time.monotonic() + 240
            result = None
            try:
                with budget(240), gate.frozen(deadline):
                    remaining = int(deadline - time.monotonic()) - 5
                    if remaining < 1:
                        raise TimeoutError(
                            "No quarantine budget remains after upload drain"
                        )
                    result = store.collect(
                        plan, protected, gate.require_frozen, 2000, remaining, batch
                    )
            except TimeoutError:
                receipt = quarantine.root / batch / "receipt.json"
                if not receipt.is_file():
                    raise
                validate_receipt(
                    json.loads(receipt.read_text()),
                    batch,
                    storage["pvcUid"],
                    storage["pv"],
                )
                result = {"quarantineId": batch, "collectionTimedOut": True}
            gate.require_open()
            report("collected", **result)
            deleted = purge(quarantine, batch, storage)
            report(
                "complete", collectionTimedOut=result["collectionTimedOut"], **deleted
            )
        finally:
            owner.unlink(missing_ok=True)


def stop(run_id):
    owner_path = CONTROL / "worker.json"
    if owner_path.exists():
        owner = json.loads(owner_path.read_text())
        if owner["run"] != run_id:
            raise RuntimeError("Another cleanup run owns this registry Pod")
        (CONTROL / ("cancel-" + run_id)).touch(mode=0o660)
        try:
            if (
                boot_id() == owner["boot"]
                and process_start(owner["pid"]) == owner["start"]
            ):
                os.kill(owner["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
        except FileNotFoundError:
            pass
    else:
        (CONTROL / ("cancel-" + run_id)).touch(mode=0o660)
    deadline = time.monotonic() + 30
    while True:
        try:
            handle = locked(ROOT)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "Cleanup worker has not stopped; leave uploads fenced"
                )
            time.sleep(0.1)
    with handle:
        WriteGate().open()
        owner_path.unlink(missing_ok=True)


def interrupted(*_):
    raise InterruptedError("Registry cleanup interrupted")


if __name__ == "__main__":
    operation, run_id = sys.argv[1:]
    if operation not in {"run", "stop"} or not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise ValueError("Expected run or stop and a 32-character cleanup ID")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    (run if operation == "run" else stop)(run_id)
