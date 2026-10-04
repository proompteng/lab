"""Require restored source Clusters before the isolated PostgreSQL major upgrade."""

import json
from pathlib import Path
import ssl
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

NAMESPACE = "postgres-upgrade-acceptance"
SOURCE_IMAGES = {
    "buzz-pg18-source": "ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie@sha256:362b039f643f1c09a34edd63d9a78903e5f1f4f43c24236cc8459621eb676d12",
    "jangar-pg18-source": "ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
    "torghut-pg18-source": "ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
}
TARGET_IMAGES = {
    "buzz-pg18-source": "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1",
    "jangar-pg18-source": "ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533",
    "torghut-pg18-source": "ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533",
}
SOURCES = {
    "buzz-pg18-source": "7665590635531415571",
    "jangar-pg18-source": "7615764848397791261",
    "torghut-pg18-source": "7615765590556864543",
}
CLUSTER_UIDS = {
    "buzz-pg18-source": "f6771224-7f10-444e-9a62-1292940bfbfc",
    "jangar-pg18-source": "edbe5325-aa97-4053-b278-37f929b5ff26",
    "torghut-pg18-source": "15107329-6348-4887-86c5-0f27c68f58d6",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def ready(name, cluster):
    require(
        cluster is not None,
        name + ": missing; complete the reviewed three-source recovery stage first",
    )
    metadata, spec, status = (
        cluster.get("metadata", {}),
        cluster.get("spec", {}),
        cluster.get("status", {}),
    )
    require(
        metadata.get("name") == name
        and metadata.get("namespace") == NAMESPACE
        and metadata.get("uid") == CLUSTER_UIDS[name],
        "unexpected recovery Cluster identity",
    )
    snapshot = (
        spec.get("bootstrap", {})
        .get("recovery", {})
        .get("volumeSnapshots", {})
        .get("storage", {})
    )
    require(
        snapshot.get("name") == name + "-snapshot"
        and snapshot.get("kind") == "VolumeSnapshot"
        and snapshot.get("apiGroup") == "snapshot.storage.k8s.io",
        name + ": unexpected recovery source",
    )
    image = spec.get("imageName")
    require(
        image in (SOURCE_IMAGES[name], TARGET_IMAGES[name]),
        name + ": unsupported operand image",
    )
    if (
        status.get("phase") != "Cluster in healthy state"
        or status.get("readyInstances") != 1
    ):
        return False
    major = 17 if image == SOURCE_IMAGES[name] else 18
    data = status.get("pgDataImageInfo", {})
    if data.get("image") != image or data.get("majorVersion") != major:
        return False
    require(
        bool(status.get("systemID")), name + ": native system identifier is missing"
    )
    if major == 17:
        require(
            status["systemID"] == SOURCES[name],
            name + ": restored source identity changed",
        )
    return True


def wait_for_sources(lookup, *, timeout=900, sleep=time.sleep, clock=time.monotonic):
    deadline = clock() + timeout
    while True:
        pending = [name for name in SOURCES if not ready(name, lookup(name))]
        if not pending:
            return list(SOURCES)
        require(
            clock() < deadline, "source recovery is not ready: " + ", ".join(pending)
        )
        sleep(min(5, max(0, deadline - clock())))


def main():
    service_account = Path("/var/run/secrets/kubernetes.io/serviceaccount")
    require(
        service_account.joinpath("namespace").read_text().strip() == NAMESPACE,
        "unexpected namespace",
    )
    token = service_account.joinpath("token").read_text().strip()
    context = ssl.create_default_context(cafile=str(service_account / "ca.crt"))

    def lookup(name):
        request = Request(
            "https://kubernetes.default.svc/apis/postgresql.cnpg.io/v1/namespaces/"
            + NAMESPACE
            + "/clusters/"
            + name,
            headers={"Authorization": "Bearer " + token},
        )
        try:
            with urlopen(request, context=context, timeout=15) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError("Cluster preflight HTTP " + str(error.code)) from error

    names = wait_for_sources(lookup)
    print(
        json.dumps({"status": "SOURCE_RECOVERY_READY", "clusters": names}), flush=True
    )


if __name__ == "__main__":
    main()
