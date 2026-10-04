#!/usr/bin/env python3
import argparse
import datetime
import json
import re
import subprocess
import time


def kubectl(context, namespace, *args, check=True):
    return subprocess.run(
        ["kubectl", "--context", context, "-n", namespace, *args],
        text=True,
        capture_output=True,
        check=check,
        timeout=30,
    )


def verify(context, timeout):
    expected = "spiffe://proompteng.ai/ns/spire-test/sa/identity-canary"
    nodes = json.loads(
        kubectl(context, "spire-test", "get", "nodes", "-o", "json").stdout
    )
    architectures = {
        node["metadata"]["name"]: node["status"]["nodeInfo"]["architecture"]
        for node in nodes["items"]
        if node["status"]["nodeInfo"]["operatingSystem"] == "linux"
    }
    assert {"amd64", "arm64"} <= set(architectures.values()), architectures
    for namespace, kind, name in (
        ("spire-server", "statefulset", "spire-server"),
        ("spire-system", "daemonset", "spire-agent"),
        ("spire-system", "daemonset", "spire-spiffe-csi-driver"),
    ):
        workload = json.loads(
            kubectl(context, namespace, "get", kind, name, "-o", "json").stdout
        )
        status = workload["status"]
        assert (
            status.get("observedGeneration", 0) >= workload["metadata"]["generation"]
        ), (name, status)
        desired = status.get(
            "desiredNumberScheduled", workload["spec"].get("replicas", 1)
        )
        ready = status.get("numberReady", status.get("readyReplicas", 0))
        assert ready == desired and desired > 0, (name, status)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pods = json.loads(
            kubectl(
                context,
                "spire-test",
                "get",
                "pods",
                "-l",
                "app.kubernetes.io/name=spire-identity-canary",
                "-o",
                "json",
            ).stdout
        )["items"]
        evidence = []
        for pod in pods:
            if (
                pod["metadata"].get("deletionTimestamp")
                or pod["status"].get("phase") != "Running"
            ):
                continue
            logs = kubectl(
                context,
                "spire-test",
                "logs",
                pod["metadata"]["name"],
                "-c",
                "identity",
                "--tail=300",
            ).stdout
            records = re.findall(
                r"SPIFFE ID:\s+(\S+)\s+SVID Valid After:\s+([^\n]+)\nSVID Valid Until:\s+([^\n]+)",
                logs,
            )
            windows = {
                (after, until)
                for identity, after, until in records
                if identity == expected
            }
            if len(windows) < 2:
                continue
            after, until = max(windows, key=lambda window: window[1])

            def parse(value):
                return datetime.datetime.strptime(
                    value.strip(), "%Y-%m-%d %H:%M:%S %z UTC"
                )

            now = datetime.datetime.now(datetime.timezone.utc)
            assert parse(after) <= now < parse(until), (
                pod["metadata"]["name"],
                after,
                until,
            )
            evidence.append(
                {
                    "pod": pod["metadata"]["name"],
                    "node": pod["spec"]["nodeName"],
                    "architecture": architectures[pod["spec"]["nodeName"]],
                    "spiffeID": expected,
                    "validityWindows": len(windows),
                    "validUntil": until,
                }
            )
        if {item["node"] for item in evidence} == set(architectures):
            denied = kubectl(
                context,
                "spire-system",
                "exec",
                "daemonset/spire-agent",
                "-c",
                "spire-agent",
                "--",
                "/opt/spire/bin/spire-agent",
                "api",
                "fetch",
                "x509",
                "-socketPath",
                "/tmp/spire-agent/public/spire-agent.sock",
                check=False,
            )
            assert denied.returncode != 0 and re.search(
                r"no identity|permissiondenied",
                denied.stdout + denied.stderr,
                re.IGNORECASE,
            ), denied.stdout + denied.stderr
            print(
                json.dumps(
                    {
                        "context": context,
                        "canaries": evidence,
                        "unregisteredWorkloadDenied": True,
                    },
                    indent=2,
                )
            )
            return
        print(
            f"Rotation verified on {len(evidence)}/{len(architectures)} nodes",
            flush=True,
        )
        time.sleep(10)
    raise RuntimeError(
        "Identity issuance and rotation did not pass on every node before timeout"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", default="galactic-tailscale")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    verify(args.context, args.timeout)
