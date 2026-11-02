#!/usr/bin/env python3
"""Run platform acceptance against private, disposable loopback services."""

import argparse
import contextlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


OFZ = Path(__file__).resolve().parents[1]


def ports(count):
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]


class Fixture:
    def __init__(self):
        self.uid, self.gid = os.getuid(), os.getgid()
        if self.uid == 0:
            identity = pwd.getpwnam("ofz-fixture")
            self.uid, self.gid = identity.pw_uid, identity.pw_gid
        self.directory = Path(tempfile.mkdtemp(prefix="ofz-platform-"))
        self.processes = []
        self.logs = []
        self.pg_port, self.http_port, self.grpc_port, self.metrics_port = ports(4)
        if os.getuid() == 0:
            os.chown(self.directory, self.uid, self.gid)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def run(self, *command, postgres=False):
        log = self.directory / "setup.log"
        with log.open("ab") as output:
            subprocess.run(
                command,
                cwd=self.directory,
                check=True,
                stdout=output,
                stderr=subprocess.STDOUT,
                **self.identity(postgres),
            )

    def identity(self, postgres):
        if postgres and os.getuid() == 0:
            return {"user": self.uid, "group": self.gid, "extra_groups": []}
        return {}

    def start(self, name, command, postgres=False):
        output = (self.directory / f"{name}.log").open("wb")
        self.logs.append(output)
        process = subprocess.Popen(
            command,
            cwd=self.directory,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            **self.identity(postgres),
        )
        self.processes.append(process)
        return process

    def wait(self, process, ready):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Fixture process exited with {process.returncode}")
            if ready():
                return
            time.sleep(0.1)
        raise TimeoutError("Disposable fixture did not become ready within 60 seconds")

    def prepare(self):
        root = self.directory
        self.run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-sha256",
            "-days",
            "1",
            "-subj",
            "/CN=Ofz disposable fixture CA",
            "-keyout",
            str(root / "ca.key"),
            "-out",
            str(root / "ca.crt"),
        )
        self.run(
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=localhost",
            "-keyout",
            str(root / "server.key"),
            "-out",
            str(root / "server.csr"),
        )
        (root / "server.ext").write_text(
            "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n"
            "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"
        )
        self.run(
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "server.csr"),
            "-CA",
            str(root / "ca.crt"),
            "-CAkey",
            str(root / "ca.key"),
            "-CAcreateserial",
            "-days",
            "1",
            "-sha256",
            "-extfile",
            str(root / "server.ext"),
            "-out",
            str(root / "server.crt"),
        )
        (root / "native.key").write_text("ofz-policy-fixture")
        os.chmod(root / "server.key", 0o600)
        if os.getuid() == 0:
            os.chown(root / "server.key", self.uid, self.gid)
        self.run(
            "initdb",
            "-D",
            str(root / "database"),
            "-U",
            "postgres",
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
            postgres=True,
        )
        (root / "database/pg_hba.conf").write_text(
            "local all all trust\nhostnossl all all 127.0.0.1/32 reject\n"
            "hostssl all postgres 127.0.0.1/32 trust\n"
            "hostssl all all 127.0.0.1/32 scram-sha-256\n"
        )
        database = self.start(
            "postgres",
            [
                "postgres",
                "-D",
                str(root / "database"),
                "-p",
                str(self.pg_port),
                "-h",
                "127.0.0.1",
                "-k",
                str(root),
                "-c",
                "track_commit_timestamp=on",
                "-c",
                "ssl=on",
                "-c",
                f"ssl_cert_file={root}/server.crt",
                "-c",
                f"ssl_key_file={root}/server.key",
            ],
            postgres=True,
        )
        self.wait(
            database,
            lambda: subprocess.run(
                [
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-p",
                    str(self.pg_port),
                    "-U",
                    "postgres",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0,
        )
        uri = f"postgres://postgres@127.0.0.1:{self.pg_port}/postgres?sslmode=require"
        self.run("createdb", "--maintenance-db", uri, "ofz_control")
        datastore = ["--datastore-engine=postgres", f"--datastore-conn-uri={uri}"]
        self.run(
            "spicedb",
            "datastore",
            "migrate",
            "head",
            *datastore,
            "--skip-release-check=true",
            "--log-level=warn",
        )
        native = self.start(
            "spicedb",
            [
                "spicedb",
                "serve",
                *datastore,
                f"--grpc-addr=127.0.0.1:{self.grpc_port}",
                f"--http-addr=127.0.0.1:{self.http_port}",
                f"--metrics-addr=127.0.0.1:{self.metrics_port}",
                "--grpc-preshared-key=ofz-policy-fixture",
                "--http-enabled=true",
                "--dispatch-cache-enabled=false",
                "--dispatch-cluster-cache-enabled=false",
                "--telemetry-endpoint=",
                "--skip-release-check=true",
                "--log-level=warn",
            ],
        )

        def healthy():
            try:
                with urllib.request.urlopen(self.endpoint + "/healthz", timeout=1):
                    return True
            except (OSError, urllib.error.URLError):
                return False

        self.wait(native, healthy)

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.http_port}"

    def environment(self):
        return {
            **os.environ,
            "OFZ_TEST_DSN": f"host=localhost port={self.pg_port} dbname=ofz_control user=postgres sslmode=require",
            "OFZ_TEST_CA_FILE": str(self.directory / "ca.crt"),
            "OFZ_TEST_NATIVE_KEY_FILE": str(self.directory / "native.key"),
            "OFZ_TEST_NATIVE_ENDPOINT": self.endpoint,
        }

    def close(self):
        for process in reversed(self.processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        for log in self.logs:
            log.close()
        shutil.rmtree(self.directory)


def platform_inputs(directory):
    services = json.loads((OFZ / "platform/services.json").read_text())
    services["services"].append(
        {
            "id": "fixture-client",
            "identities": [
                "spiffe://proompteng.ai/ns/fixture/sa/first",
                "spiffe://proompteng.ai/ns/fixture/sa/second",
            ],
            "roles": ["platform.client", "relay.client"],
        }
    )
    services["workspaces"][0]["initial_clients"].append("fixture-client")
    services["workspaces"][0]["resources"].extend(
        [
            {
                "kind": "kubernetes.namespace",
                "id": "galactic/11111111-1111-4111-8111-111111111111",
                "name": "fixture",
            },
            {
                "kind": "kubernetes.namespace",
                "id": "galactic/22222222-2222-4222-8222-222222222222",
                "name": "approved",
            },
        ]
    )
    services["workspaces"].append(
        {
            "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "name": "Other workspace",
            "resources": [
                {
                    "kind": "kubernetes.namespace",
                    "id": "galactic/33333333-3333-4333-8333-333333333333",
                    "name": "private",
                }
            ],
            "initial_clients": ["fixture-client"],
            "import_platform_members": False,
        }
    )
    policies = json.loads((OFZ / "platform/policies.json").read_text())
    policies["actions"].append(
        {
            "id": "fixture.status.read",
            "resourceKind": "kubernetes.namespace",
            "permission": "read_status",
            "grantRelation": "status_reader",
        }
    )
    for name, data in [("services", services), ("policies", policies)]:
        (directory / f"{name}.json").write_text(json.dumps(data))
    return {
        "OFZ_SERVICES_FILE": str(directory / "services.json"),
        "OFZ_POLICY_CATALOG_FILE": str(directory / "policies.json"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["platform", "policy", "qualify"])
    qualification = parser.add_mutually_exclusive_group()
    qualification.add_argument("--write", action="store_true")
    qualification.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name in ["openssl", "initdb", "postgres", "pg_isready", "createdb", "spicedb"]:
        if not shutil.which(name):
            parser.error(
                f"Missing fixture executable: {name}; use the AgentRun toolchain"
            )
    with Fixture() as fixture:
        try:
            fixture.prepare()
            if args.mode == "platform":
                environment = {
                    **fixture.environment(),
                    **platform_inputs(fixture.directory),
                }
                command = [
                    "cargo",
                    "test",
                    "--locked",
                    "--lib",
                    "platform::integration",
                    "--",
                    "--ignored",
                    "--nocapture",
                ]
                result = subprocess.run(
                    command,
                    cwd=OFZ,
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                print(result.stdout, end="", flush=True)
                if result.returncode:
                    return result.returncode
                if not re.search(
                    r"test result: ok\. [1-9][0-9]* passed; 0 failed;", result.stdout
                ):
                    raise RuntimeError(
                        "Platform fixture must execute at least one real integration test"
                    )
            else:
                command = (
                    [sys.executable, "tests/policy.py", fixture.endpoint]
                    if args.mode == "policy"
                    else [
                        sys.executable,
                        "tests/qualify_platform.py",
                        str(fixture.http_port),
                        "--write" if args.write else "--check",
                    ]
                )
                subprocess.run(command, cwd=OFZ, check=True)
            print(
                f"PASS: disposable {args.mode} fixture; PostgreSQL TLS and SpiceDB on loopback"
            )
            return 0
        except BaseException:
            for path in sorted(fixture.directory.glob("*.log")):
                print(
                    f"Fixture diagnostic {path.name}:\n{path.read_text(errors='replace')[-6000:]}",
                    file=sys.stderr,
                )
            raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    sys.exit(main())
