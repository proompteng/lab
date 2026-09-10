import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time


NAMESPACE = "clickhouse-upgrade-acceptance"
JOBS = ["clickhouse-native-20260910-v2-0", "clickhouse-native-20260910-v2-1"]
SOURCES = {
    "chi-torghut-clickhouse-default-0-0-0": [9000, 8123],
    "chi-torghut-clickhouse-default-0-1-0": [9000, 8123],
    "chk-torghut-keeper-default-0-0-0": [2181],
}


def kubectl(namespace, *args, data=None, check=True):
    result = subprocess.run(
        ["kubectl", "--context", "galactic-lan", "-n", namespace, *args],
        input=data,
        capture_output=True,
        timeout=30,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode()[-2000:])
    return result


def get(namespace, kind, name):
    return json.loads(kubectl(namespace, "get", kind, name, "-o", "json").stdout)


def positive_controls(expected=None):
    targets = []
    pods = {name: get("torghut", "pod", name) for name in SOURCES}
    for name, pod in pods.items():
        if pod["status"]["phase"] != "Running" or not all(
            c["ready"] for c in pod["status"]["containerStatuses"]
        ):
            raise RuntimeError("Production target is not ready: " + name)
        ip = pod["status"]["podIP"]
        for port in SOURCES[name]:
            targets.append(
                {
                    "pod": name,
                    "podUID": pod["metadata"]["uid"],
                    "endpoint": ip + ":" + str(port),
                    "positiveControl": "PASS",
                }
            )
    if expected is not None and targets != expected:
        raise RuntimeError(
            "Production Pod identity/address changed during isolation test"
        )
    source = next(iter(SOURCES))
    for target in targets:
        ip, port = target["endpoint"].split(":")
        kubectl(
            "torghut",
            "exec",
            source,
            "-c",
            "clickhouse",
            "--",
            "timeout",
            "5",
            "bash",
            "-c",
            'exec 3<>/dev/tcp/"$1"/"$2"',
            "_",
            ip,
            port,
        )
    for name, pod in pods.items():
        current = get("torghut", "pod", name)
        if (
            current["metadata"]["uid"] != pod["metadata"]["uid"]
            or current["status"]["podIP"] != pod["status"]["podIP"]
        ):
            raise RuntimeError(
                "Production target changed during positive control: " + name
            )
    return {"epoch": int(time.time()), "targets": targets}


def read_file(pod, container, path):
    result = kubectl(
        NAMESPACE, "exec", pod, "-c", container, "--", "cat", path, check=False
    )
    if result.returncode:
        if b"No such file or directory" in result.stderr:
            return None
        raise RuntimeError(result.stderr.decode()[-2000:])
    return result.stdout


def write_control(pod, container, directory, side, receipt):
    entries = {f"runtime-{side}.json": json.dumps(receipt) + "\n"}
    if side == "before":
        entries["runtime-targets.txt"] = "".join(
            item["endpoint"] + "\n" for item in receipt["targets"]
        )
    entries[f".{side}-ready"] = str(receipt["epoch"]) + "\n"
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as output:
        for name, value in entries.items():
            contents = value.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.uid, info.gid = len(contents), 0o640, 101, 101
            output.addfile(info, io.BytesIO(contents))
    kubectl(
        NAMESPACE,
        "exec",
        "-i",
        pod,
        "-c",
        container,
        "--",
        "bash",
        "-c",
        'set -e; tar -x -C "$1"; mv "$1/.$2-ready" "$1/runtime-$2.epoch"',
        "_",
        directory,
        side,
        data=archive.getvalue(),
    )


def main():
    global JOBS, SOURCES
    phases = {name: name.replace("-", "_") for name in ["v25-3", "v25-8", "v26-3"]}
    proof_prefix = "/proof/v2/"
    if len(sys.argv) == 3:
        profile = json.loads(Path(sys.argv[2]).read_text())
        JOBS, SOURCES = profile["jobs"], profile["sources"]
        phases, proof_prefix = profile["phases"], profile["proofPrefix"]
        if not JOBS or len(set(JOBS)) != len(JOBS) or not phases or not SOURCES:
            raise ValueError("Incomplete runtime isolation profile")
        if not proof_prefix.startswith("/proof/") or not proof_prefix.endswith("/"):
            raise ValueError("Proof prefix must remain under /proof/")
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    positive_controls()
    kubectl(NAMESPACE, "get", "jobs", "-o", "name")
    print(json.dumps({"controller": "ACTIVE", "pid": os.getpid()}), flush=True)
    completed = set()
    deadline = time.monotonic() + 43200
    while len(completed) != len(JOBS):
        if time.monotonic() >= deadline:
            raise RuntimeError("Native rehearsal exceeded its deadline")
        heartbeat = output / "controller-ready.tmp"
        heartbeat.write_text(
            json.dumps(
                {"status": "ACTIVE", "pid": os.getpid(), "epoch": int(time.time())}
            )
            + "\n"
        )
        heartbeat.replace(output / "controller-ready.json")
        for name in JOBS:
            if name in completed:
                continue
            response = kubectl(NAMESPACE, "get", "job", name, "-o", "json", check=False)
            if response.returncode:
                if b"NotFound" in response.stderr:
                    continue
                raise RuntimeError(response.stderr.decode())
            job = json.loads(response.stdout)
            if any(
                c["type"] == "Failed" and c["status"] == "True"
                for c in job.get("status", {}).get("conditions", [])
            ):
                raise RuntimeError("Native rehearsal Job failed: " + name)
            pods = json.loads(
                kubectl(
                    NAMESPACE,
                    "get",
                    "pods",
                    "-l",
                    "batch.kubernetes.io/job-name=" + name,
                    "-o",
                    "json",
                ).stdout
            )["items"]
            if not pods:
                continue
            if len(pods) != 1:
                raise RuntimeError("Unexpected retry or duplicate rehearsal Pod")
            pod = pods[0]
            if not any(
                o["uid"] == job["metadata"]["uid"]
                for o in pod["metadata"].get("ownerReferences", [])
            ):
                raise RuntimeError("Rehearsal Pod owner changed")
            pod_name = pod["metadata"]["name"]
            if any(
                c["type"] == "Complete" and c["status"] == "True"
                for c in job.get("status", {}).get("conditions", [])
            ):
                log = kubectl(NAMESPACE, "logs", pod_name, "-c", "verify").stdout
                receipt = json.loads(log)
                if receipt["status"] != "PASS":
                    raise RuntimeError("Native verifier did not pass")
                receipt.update(
                    jobUID=job["metadata"]["uid"],
                    podUID=pod["metadata"]["uid"],
                    containers=pod["status"]["initContainerStatuses"]
                    + pod["status"]["containerStatuses"],
                )
                (output / (name + ".json")).write_text(
                    json.dumps(receipt, indent=2) + "\n"
                )
                completed.add(name)
                print(
                    json.dumps(
                        {
                            "job": name,
                            "status": "PASS",
                            **{
                                key: receipt[key]
                                for key in ["rows", "znodes"]
                                if key in receipt
                            },
                        }
                    ),
                    flush=True,
                )
                continue
            running = [
                c
                for c in pod.get("status", {}).get("initContainerStatuses", [])
                if c.get("state", {}).get("running")
            ]
            if not running:
                continue
            container = running[0]["name"]
            if container not in phases:
                raise RuntimeError("Unexpected native engine container")
            directory = proof_prefix + phases[container]
            ready = kubectl(
                NAMESPACE,
                "exec",
                pod_name,
                "-c",
                container,
                "--",
                "test",
                "-d",
                directory,
                check=False,
            )
            if ready.returncode:
                continue
            before_raw = read_file(
                pod_name, container, directory + "/runtime-before.json"
            )
            if before_raw is None:
                before = positive_controls()
                write_control(pod_name, container, directory, "before", before)
                print(
                    json.dumps({"job": name, "phase": container, "before": "PASS"}),
                    flush=True,
                )
                continue
            before = json.loads(before_raw)
            if (
                read_file(pod_name, container, directory + "/runtime-after.epoch")
                is not None
            ):
                continue
            denied = read_file(pod_name, container, directory + "/isolation.tsv")
            expected = "".join(
                t["endpoint"] + "\tDENIED\n" for t in before["targets"]
            ).encode()
            if denied != expected:
                continue
            after = positive_controls(before["targets"])
            if after["epoch"] - before["epoch"] > 90:
                raise RuntimeError(
                    "Runtime controls are stale; refuse to accept isolation"
                )
            write_control(pod_name, container, directory, "after", after)
            print(
                json.dumps({"job": name, "phase": container, "isolation": "PASS"}),
                flush=True,
            )
        time.sleep(3)


if __name__ == "__main__":
    main()
