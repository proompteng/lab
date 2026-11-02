#!/usr/bin/env python3
"""Exercise the production Alloy graph against a local failing/recovering OTLP sink."""

import argparse
import gzip
import hashlib
import http.server
import json
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_until(predicate, timeout: float, description: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError(description)


def verify(binary: pathlib.Path, source: pathlib.Path) -> dict:
    original = source.read_text()
    subprocess.run([str(binary), "validate", str(source)], check=True, timeout=15)
    recovered = threading.Event()
    delivered = threading.Event()
    trace_id = uuid.uuid4().hex
    state = {"rejections": 0, "deliveries": 0}

    class Sink(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            status = 200
            if self.path == "/v1/traces":
                if not recovered.is_set():
                    state["rejections"] += 1
                    status = 503
                else:
                    if self.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    if bytes.fromhex(trace_id) in body:
                        state["deliveries"] += 1
                        delivered.set()
            self.send_response(status)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *args) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    receiver_port, admin_port = free_port(), free_port()
    backend = f"http://127.0.0.1:{server.server_port}"
    config = original.replace('"0.0.0.0:4318"', f'"127.0.0.1:{receiver_port}"')
    config = (
        config.replace(
            "http://observability-tempo-distributor.observability.svc.cluster.local:4318",
            backend,
        )
        .replace(
            "http://observability-mimir-gateway.observability.svc.cluster.local",
            backend,
        )
        .replace("127.0.0.1:12345", f"127.0.0.1:{admin_port}")
    )
    if "svc.cluster.local" in config:
        raise ValueError("Regression must not contact any cluster endpoint")
    try:
        with tempfile.TemporaryDirectory(prefix="bayn-relay-test-") as directory:
            root = pathlib.Path(directory)
            config_path = root / "config.alloy"
            config_path.write_text(config)
            with (root / "alloy.log").open("w+") as log:
                process = subprocess.Popen(
                    [
                        str(binary),
                        "run",
                        str(config_path),
                        "--disable-reporting",
                        f"--server.http.listen-addr=127.0.0.1:{admin_port}",
                        f"--storage.path={root / 'data'}",
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                try:

                    def ready() -> bool:
                        if process.poll() is not None:
                            log.seek(0)
                            raise RuntimeError(f"Alloy exited: {log.read()[-4000:]}")
                        try:
                            with urllib.request.urlopen(
                                f"http://127.0.0.1:{admin_port}/-/ready", timeout=1
                            ) as response:
                                return response.status == 200
                        except (OSError, urllib.error.URLError):
                            return False

                    wait_until(ready, 15, "Alloy did not become ready")
                    now = time.time_ns()
                    payload = {
                        "resourceSpans": [
                            {
                                "resource": {
                                    "attributes": [
                                        {
                                            "key": "service.name",
                                            "value": {
                                                "stringValue": "bayn-relay-regression"
                                            },
                                        }
                                    ]
                                },
                                "scopeSpans": [
                                    {
                                        "scope": {"name": "bayn-regression"},
                                        "spans": [
                                            {
                                                "traceId": trace_id,
                                                "spanId": uuid.uuid4().hex[:16],
                                                "name": "retry-recovery",
                                                "kind": 1,
                                                "startTimeUnixNano": str(
                                                    now - 1_000_000
                                                ),
                                                "endTimeUnixNano": str(now),
                                            }
                                        ],
                                    }
                                ],
                            }
                        ]
                    }
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{receiver_port}/v1/traces",
                        data=json.dumps(payload).encode(),
                        headers={"Content-Type": "application/json"},
                    )
                    with urllib.request.urlopen(request, timeout=5) as response:
                        if response.status != 200:
                            raise AssertionError("Relay did not accept the fixture")
                    wait_until(
                        lambda: state["rejections"] >= 2,
                        15,
                        "Sink retry was not observed",
                    )
                    if delivered.is_set():
                        raise AssertionError(
                            "Delivery was reported while the sink rejected requests"
                        )
                    recovered.set()
                    wait_until(
                        delivered.is_set,
                        20,
                        "Accepted trace was lost before sink recovery",
                    )
                    return {
                        "schemaVersion": "bayn.telemetry-relay-regression.v1",
                        "configurationSha256": hashlib.sha256(
                            original.encode()
                        ).hexdigest(),
                        "nativeValidation": "PASSED",
                        "producerAcceptedDuringOutage": True,
                        "sinkRejectedAttempts": state["rejections"],
                        "fixtureDeliveredAfterRecovery": True,
                        "fixtureDeliveries": state["deliveries"],
                        "clusterAccess": False,
                        "scope": "Transient sink failure only; restart and queue overflow can lose traces",
                    }
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=pathlib.Path, required=True)
    parser.add_argument("--config", type=pathlib.Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.binary.resolve(), args.config.resolve()), indent=2))


if __name__ == "__main__":
    main()
