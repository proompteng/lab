"""Validate rendered Cassandra preparation ConfigMap references before GitOps."""

import json
import sys


def validate(documents):
    maps = {
        (doc.get("metadata", {}).get("namespace", ""), doc["metadata"]["name"])
        for doc in documents
        if doc and doc.get("kind") == "ConfigMap"
    }
    checked = 0
    for doc in documents:
        if not doc or doc.get("kind") != "Job":
            continue
        metadata = doc["metadata"]
        if not metadata["name"].startswith("temporal-cassandra-"):
            continue
        spec = doc["spec"]["template"]["spec"]
        for volume in spec.get("volumes", []):
            name = volume.get("configMap", {}).get("name", "")
            if not name.startswith("temporal-cassandra-"):
                continue
            key = (metadata.get("namespace", ""), name)
            if key not in maps:
                raise ValueError(
                    f"{metadata['name']}: missing rendered ConfigMap {key}"
                )
            checked += 1
    if not checked:
        raise ValueError("No Cassandra Job ConfigMap references were validated")
    return checked


if __name__ == "__main__":
    print(
        f"PASS: {validate(json.load(sys.stdin))} rendered Cassandra Job ConfigMap references resolve in the same namespace"
    )
