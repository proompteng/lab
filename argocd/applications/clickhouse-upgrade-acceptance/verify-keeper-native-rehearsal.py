import datetime
import hashlib
import json
import os
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def metrics(path):
    return dict(line.split("\t", 1) for line in path.read_text().splitlines() if line)


def verify(root, canary):
    phases = {"v25_12": "25.12.5.44", "v26_8": "26.8.2.7"}
    result = {}
    compare_files = [
        "canary-value",
        "canary-stat",
        "canary-acl",
        "root-stat",
        "all-children",
        "clickhouse-children",
        "clickhouse-root",
        "uuid.sha256",
    ]
    for phase, version in phases.items():
        proof = root / phase
        require(
            (proof / "process-exit").read_text().strip() == "0",
            f"Native process failure: {phase}",
        )
        require(
            (proof / "keeper-exit").read_text().strip() == "0",
            f"Native shutdown failure: {phase}",
        )
        require(
            (proof / "ruok").read_text().strip() == "imok",
            f"Keeper health failure: {phase}",
        )
        stats = metrics(proof / "mntr.txt")
        require(
            stats["zk_version"].startswith("v" + version + "-"),
            f"Wrong native version: {phase}",
        )
        require(
            stats["zk_server_state"] in ["leader", "standalone"],
            f"Native quorum failed: {phase}",
        )
        require(
            int(stats["zk_ephemerals_count"]) == 0,
            f"Source sessions did not expire: {phase}",
        )
        require(
            int(stats["zk_znode_count"]) > 20000,
            f"Recovered namespace is incomplete: {phase}",
        )
        require(
            (proof / "canary-value").read_text().strip() == canary,
            f"Persistent native canary lost: {phase}",
        )
        configuration = dict(
            line.split("=", 1)
            for line in (proof / "conf.txt").read_text().splitlines()
            if "=" in line
        )
        require(
            configuration["server_id"] == "0",
            f"Native server identity changed: {phase}",
        )
        before = json.loads((proof / "runtime-before.json").read_text())
        after = json.loads((proof / "runtime-after.json").read_text())
        require(
            before["targets"] == after["targets"],
            f"Production endpoint identity changed: {phase}",
        )
        require(
            0 <= after["epoch"] - before["epoch"] <= 90,
            f"Stale isolation controls: {phase}",
        )
        endpoints = [x["endpoint"] for x in before["targets"]]
        require(
            len(set(endpoints)) == len(endpoints) == 6,
            f"Incomplete native endpoint inventory: {phase}",
        )
        require(
            all(
                x["positiveControl"] == "PASS" and x["podUID"]
                for x in before["targets"]
            ),
            f"Missing positive control: {phase}",
        )
        probes = [
            json.loads(line)
            for line in (proof / "isolation-probes.jsonl").read_text().splitlines()
        ]
        require(
            [x["endpoint"] for x in probes] == endpoints,
            f"Missing native endpoint denial: {phase}",
        )
        for probe in probes:
            host, port = probe["endpoint"].split(":")
            error = (proof / f"probe-{host}-{port}.stderr").read_text()
            timeout = (
                probe["exitCode"] in [124, 143]
                and probe["outcome"] == "TIMED_OUT"
                and probe["elapsedSeconds"] >= 5
            )
            rejected = (
                probe["exitCode"] == 1
                and probe["outcome"] == "REJECTED"
                and f"/dev/tcp/{host}/{port}: Connection refused" in error
            )
            require(
                timeout or rejected, f"Unclassified native network failure: {phase}"
            )
        values = {name: (proof / name).read_text() for name in compare_files}
        require(
            int(values["all-children"].strip()) > 20000
            and int(values["clickhouse-children"].strip()) > 20000,
            f"Native tree traversal failed: {phase}",
        )
        result[phase] = {
            "nativeVersion": stats["zk_version"],
            "znodes": int(stats["zk_znode_count"]),
            "nativeChildCount": int(values["all-children"].strip()),
            "clickhouseChildCount": int(values["clickhouse-children"].strip()),
            "nativeEvidence": values,
            "isolation": {"before": before, "after": after, "probes": probes},
            "nativeRecovery": "PASS",
            "nativeShutdown": "PASS",
        }
    source_files = root / "v25_12/source-files.sha256"
    require(
        source_files.read_bytes() == (root / "v25_12/copied-files.sha256").read_bytes(),
        "Source native snapshot or Raft logs were changed during copy",
    )
    a, b = result["v25_12"], result["v26_8"]
    require(
        a["nativeEvidence"] == b["nativeEvidence"],
        "Native Keeper identity, namespace or persistent canary changed",
    )
    require(a["znodes"] == b["znodes"], "Native Keeper node count changed")
    return {
        "status": "PASS",
        "at": datetime.datetime.now(datetime.UTC).isoformat(),
        "znodes": a["znodes"],
        "method": "Native source recovery followed by in-place target recovery on the same isolated files; recursive child counts and persistent canary identity, value and ACL checks",
        "sourceFilesManifestSHA256": hashlib.sha256(
            source_files.read_bytes()
        ).hexdigest(),
        "results": result,
    }


if __name__ == "__main__":
    root = Path("/proof/keeper-v1")
    receipt = verify(root, os.environ["CANARY_VALUE"])
    receipt["nativeSnapshotSHA256"] = os.environ["NATIVE_SNAPSHOT_SHA256"]
    output = json.dumps(receipt, sort_keys=True)
    (root / "native-acceptance.json").write_text(output + "\n")
    print(output, flush=True)
