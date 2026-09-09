"""Create and verify a native snapshot of the existing Temporal visibility store."""

import datetime
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = "temporal-cephfs-native"
LOCATION = "/usr/share/elasticsearch/snapshots/temporal"
GENERATION = "81921-v1"
SNAPSHOT = "before-" + GENERATION
CLUSTER_UUID = "xMDCf7u4RrG55SlLBDgTsg"
SOURCE_VERSION = "8.5.1"
NODES = {
    "C_PjEAaQTdypt5nguf1CHA": "elasticsearch-master-0",
    "lY2q4gzsQZG8uN5DKXpnnQ": "elasticsearch-master-1",
    "e7J1PAZyTAaIk_SjgLtA7w": "elasticsearch-master-2",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(method, path, body=None, missing=False):
    data = None if body is None else json.dumps(body).encode()
    req = Request(
        "http://elasticsearch-master.temporal.svc.cluster.local:9200" + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(req, timeout=1900) as response:
            return json.load(response)
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError(
            "Elasticsearch request failed: %s %s HTTP %s" % (method, path, error.code)
        ) from error


def require_source(api):
    root = api("GET", "/")
    require(root.get("cluster_uuid") == CLUSTER_UUID, "cluster identity changed")
    require(
        root.get("version", {}).get("number") == SOURCE_VERSION,
        "source version changed",
    )
    health = api("GET", "/_cluster/health?wait_for_status=green&timeout=30s")
    require(
        health.get("status") == "green"
        and health.get("timed_out") is False
        and health.get("number_of_nodes") == 3
        and all(
            health.get(key) == 0
            for key in ("unassigned_shards", "initializing_shards", "relocating_shards")
        ),
        "original three-node cluster is not stable and green",
    )
    nodes = api("GET", "/_nodes/settings")
    require(nodes.get("_nodes", {}).get("failed") == 0, "node settings request failed")
    actual = nodes.get("nodes", {})
    require(
        {key: value.get("name") for key, value in actual.items()} == NODES,
        "original node identities changed",
    )
    for node in actual.values():
        require(node.get("version") == SOURCE_VERSION, "mixed Elasticsearch versions")
        paths = node.get("settings", {}).get("path", {}).get("repo", [])
        require(
            "/usr/share/elasticsearch/snapshots" in paths,
            "a node lacks the shared repository path",
        )


def capture(api=request):
    require_source(api)
    indices = api("GET", "/_cat/indices?format=json&expand_wildcards=all")
    original = {index["index"]: index["uuid"] for index in indices}
    require(
        "temporal_visibility_v1_dev" in original, "Temporal visibility index is missing"
    )
    original_hash = hashlib.sha256(
        json.dumps(original, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    repository_path = "/_snapshot/" + REPOSITORY
    repository = api("GET", repository_path, missing=True)
    if repository is None:
        created = api(
            "PUT",
            repository_path + "?verify=true",
            {"type": "fs", "settings": {"location": LOCATION, "compress": True}},
        )
        require(
            created.get("acknowledged") is True,
            "repository registration was not acknowledged",
        )
        repository = api("GET", repository_path)
    settings = repository.get(REPOSITORY, {})
    require(
        settings.get("type") == "fs"
        and settings.get("settings", {}).get("location") == LOCATION,
        "existing repository has a different type or location",
    )
    require(
        settings["settings"].get("readonly", "false") in (False, "false"),
        "production repository is read-only",
    )
    verified = api("POST", repository_path + "/_verify")
    require(
        {key: value.get("name") for key, value in verified.get("nodes", {}).items()}
        == NODES,
        "repository verification did not cover the original three nodes",
    )
    analysis = api(
        "POST",
        repository_path
        + "/_analyze?blob_count=32&max_blob_size=4mb&max_total_data_size=64mb&timeout=10m",
    )
    require(
        analysis.get("repository") == REPOSITORY
        and analysis.get("issues_detected") == [],
        "repository analysis failed",
    )
    snapshot_path = repository_path + "/" + SNAPSHOT
    snapshot = api("GET", snapshot_path, missing=True)
    if snapshot is None:
        response = api(
            "PUT",
            snapshot_path + "?wait_for_completion=true",
            {
                "include_global_state": True,
                "partial": False,
                "metadata": {
                    "generation": GENERATION,
                    "cluster_uuid": CLUSTER_UUID,
                    "indices_sha256": original_hash,
                },
            },
        )
        require(
            response.get("snapshot", {}).get("state") == "SUCCESS",
            "native snapshot did not complete successfully",
        )
        snapshot = api("GET", snapshot_path)
    snapshots = snapshot.get("snapshots", [])
    require(len(snapshots) == 1, "snapshot response is ambiguous")
    snapshot = snapshots[0]
    metadata = snapshot.get("metadata", {})
    require(
        snapshot.get("snapshot") == SNAPSHOT and snapshot.get("state") == "SUCCESS",
        "existing snapshot is incomplete or failed; use a new reviewed generation",
    )
    require(
        snapshot.get("version") == SOURCE_VERSION
        and snapshot.get("include_global_state") is True,
        "snapshot lacks expected version or global state",
    )
    require(
        metadata.get("generation") == GENERATION
        and metadata.get("cluster_uuid") == CLUSTER_UUID,
        "snapshot belongs to a different generation or cluster",
    )
    require(
        metadata.get("indices_sha256") == original_hash,
        "snapshot index identities changed",
    )
    require(
        set(original) == set(snapshot.get("indices", [])),
        "snapshot index set differs from the captured index set",
    )
    shards = snapshot.get("shards", {})
    require(
        snapshot.get("failures") == []
        and shards.get("failed") == 0
        and shards.get("successful") == shards.get("total")
        and shards.get("total", 0) > 0,
        "snapshot has failed or missing shards",
    )
    final_indices = api("GET", "/_cat/indices?format=json&expand_wildcards=all")
    final_identities = {index["index"]: index["uuid"] for index in final_indices}
    require(
        final_identities == original,
        "index identities changed while creating or verifying the native snapshot",
    )
    require_source(api)
    return {
        "status": "NATIVE_SNAPSHOT_PASS_RESTORE_PENDING",
        "at": datetime.datetime.now(datetime.UTC).isoformat(),
        "clusterUUID": CLUSTER_UUID,
        "nodeIDs": NODES,
        "generation": GENERATION,
        "repository": REPOSITORY,
        "snapshot": SNAPSHOT,
        "snapshotUUID": snapshot["uuid"],
        "version": SOURCE_VERSION,
        "indices": snapshot["indices"],
        "originalIndexUUIDs": original,
        "shards": shards,
        "repositoryAnalysisIssues": analysis["issues_detected"],
    }


def main():
    proof = capture()
    directory = Path("/repository/receipts")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = directory / (SNAPSHOT + ".json")
    temporary = target.with_suffix(".tmp")
    with temporary.open("w") as output:
        json.dump(proof, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    print(json.dumps(proof))


if __name__ == "__main__":
    main()
