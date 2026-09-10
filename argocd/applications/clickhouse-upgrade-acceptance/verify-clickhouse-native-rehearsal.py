import datetime
import json
import os
from pathlib import Path


VERSIONS = {
    "v25_3": "25.3.6.10034",
    "v25_8": "25.8.28.10001",
    "v26_3": "26.3.16.10001",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read_rows(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    require(bool(rows), f"Empty native result: {path.name}")
    return rows


def verify(proof, expected_tables):
    expected = [tuple(line.split("\t")) for line in expected_tables.splitlines()]
    require(len(expected) == 26, "Expected source table inventory is incomplete")
    results = {}
    for phase, version in VERSIONS.items():
        root = proof / phase
        reported_version = (root / "version").read_text().strip()
        require(
            reported_version.removesuffix(".altinitystable") == version,
            f"Wrong engine: {phase}",
        )
        for name in ["process-exit", "server-exit", "keeper-exit"]:
            require(
                (root / name).read_text().strip() == "0",
                f"Unclean native exit: {phase}/{name}",
            )
        before = json.loads((root / "runtime-before.json").read_text())
        after = json.loads((root / "runtime-after.json").read_text())
        endpoints = [item["endpoint"] for item in before["targets"]]
        require(
            len(endpoints) == 5 and len(set(endpoints)) == 5,
            "Invalid isolation inventory",
        )
        require(
            before["targets"] == after["targets"],
            f"Production target identity changed: {phase}",
        )
        require(
            0 <= after["epoch"] - before["epoch"] <= 90,
            f"Stale runtime isolation controls: {phase}",
        )
        for target in before["targets"]:
            require(
                target["positiveControl"] == "PASS" and bool(target["podUID"]),
                f"Missing positive control: {phase}",
            )
        isolated = [
            line.split("\t")
            for line in (root / "isolation.tsv").read_text().splitlines()
        ]
        require(
            isolated == [[endpoint, "DENIED"] for endpoint in endpoints],
            f"Isolation failed: {phase}",
        )
        for name in ["structure-restore.jsonl", "data-restore.jsonl"]:
            restored = read_rows(root / name)
            require(
                len(restored) == 1 and restored[0]["status"] == "RESTORED",
                f"Restore failed: {phase}/{name}",
            )
        tables = read_rows(root / "tables.jsonl")
        require(
            [(t["database"], t["name"], t["engine"]) for t in tables] == expected,
            f"Table inventory differs: {phase}",
        )
        require(
            len({t["uuid"] for t in tables}) == len(tables),
            f"Duplicate restored table UUIDs: {phase}",
        )
        columns = read_rows(root / "columns.jsonl")
        data, views = {}, {}
        for database, table, engine in expected:
            key = database + "." + table
            suffix = database + "-" + table + ".jsonl"
            if engine.endswith("MergeTree"):
                checked = read_rows(root / ("check-" + suffix))
                require(
                    all(row["result"] == 1 for row in checked),
                    f"Native CHECK TABLE failed: {phase}/{key}",
                )
                fingerprint = read_rows(root / ("fingerprint-" + suffix))
                require(
                    len(fingerprint) == 1,
                    f"Invalid fingerprint cardinality: {phase}/{key}",
                )
                values = fingerprint[0]
                keys = {"rows"} | {
                    prefix + str(i) for prefix in ["sum", "xor"] for i in range(4)
                }
                require(
                    set(values) == keys, f"Incomplete row fingerprint: {phase}/{key}"
                )
                require(
                    all(0 <= int(value) < 2**64 for value in values.values()),
                    f"Invalid fingerprint values: {phase}/{key}",
                )
                data[key] = {name: str(value) for name, value in values.items()}
            elif engine == "View":
                view = read_rows(root / ("view-" + suffix))
                require(
                    len(view) == 1 and int(view[0]["rows"]) >= 0,
                    f"View query failed: {phase}/{key}",
                )
                views[key] = str(view[0]["rows"])
        replicas = read_rows(root / "replicas.jsonl")
        require(len(replicas) == 11, f"Missing replicated tables: {phase}")
        for replica in replicas:
            require(
                all(
                    int(replica[key]) == 0
                    for key in [
                        "is_readonly",
                        "is_session_expired",
                        "queue_size",
                        "lost_part_count",
                    ]
                ),
                f"Unhealthy restored replica: {phase}/{replica['table']}",
            )
        results[phase] = {
            "version": version,
            "reportedVersion": reported_version,
            "tables": tables,
            "columns": columns,
            "data": data,
            "views": views,
            "replicas": replicas,
            "nativeCheck": "PASS",
            "isolation": "PASS",
            "isolationControls": {"before": before, "after": after},
            "nativeExit": "PASS",
        }
    baseline = results["v25_3"]
    for phase in ["v25_8", "v26_3"]:
        candidate = results[phase]
        require(
            candidate["data"] == baseline["data"],
            f"Full row fingerprints differ: {phase}",
        )
        require(
            candidate["views"] == baseline["views"],
            f"View query results differ: {phase}",
        )
        require(
            candidate["columns"] == baseline["columns"],
            f"Column catalog differs: {phase}",
        )

        def schema(result):
            return [
                {k: v for k, v in t.items() if k != "uuid"} for t in result["tables"]
            ]

        require(
            schema(candidate) == schema(baseline),
            f"Table engine definitions differ: {phase}",
        )
    return {
        "status": "PASS",
        "at": datetime.datetime.now(datetime.UTC).isoformat(),
        "method": "Independent native restores; full SHA256 JSON row fingerprints with count and four UInt64 sum/XOR lanes",
        "uuidComparison": "Native RESTORE creates independent table UUIDs; all other captured engine and column fields must match",
        "rows": sum(int(item["rows"]) for item in baseline["data"].values()),
        "tables": len(expected),
        "results": results,
    }


def main():
    proof = Path("/proof")
    result = verify(proof, Path("/scripts/expected-tables.tsv").read_text())
    result["replica"] = os.environ["REPLICA"]
    result["backupManifestSHA256"] = os.environ["BACKUP_MANIFEST_SHA256"]
    output = json.dumps(result, sort_keys=True)
    (proof / "native-acceptance.json").write_text(output + "\n")
    print(output, flush=True)


if __name__ == "__main__":
    main()
