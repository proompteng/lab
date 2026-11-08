import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import textwrap
import time
import urllib.parse
import uuid

sys.path.insert(0, "/cleanup")
from maintenance import ROOT, CONTROL, Store, WriteGate


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def request(method, path, body=None, content_type=None):
    url = urllib.parse.urlsplit(path)
    path = url.path + ("?" + url.query if url.query else "")
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
    try:
        headers = {"Accept": "application/vnd.oci.image.manifest.v1+json"}
        if content_type:
            headers["Content-Type"] = content_type
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return (
            response.status,
            {key.lower(): value for key, value in response.getheaders()},
            response.read(),
        )
    finally:
        connection.close()


def upload(repository, data):
    status, headers, _ = request("POST", f"/v2/{repository}/blobs/uploads/", b"")
    assert status == 202
    location = headers["location"]
    location += ("&" if "?" in location else "?") + "digest=" + digest(data)
    assert request("PUT", location, data, "application/octet-stream")[0] == 201
    return digest(data)


def layer(contents):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as archive:
        entry = tarfile.TarInfo("fixture.txt")
        entry.size = len(contents)
        archive.addfile(entry, io.BytesIO(contents))
    return gzip.compress(raw.getvalue(), mtime=0), digest(raw.getvalue())


def manifest(repository, payload, diff_id, tag):
    config = json.dumps(
        {
            "architecture": "amd64",
            "os": "linux",
            "rootfs": {"type": "layers", "diff_ids": [diff_id]},
            "config": {},
        }
    ).encode()
    upload(repository, config)
    body = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": digest(config),
                "size": len(config),
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": digest(payload),
                    "size": len(payload),
                }
            ],
        }
    ).encode()
    status = request(
        "PUT",
        f"/v2/{repository}/manifests/{tag}",
        body,
        "application/vnd.oci.image.manifest.v1+json",
    )[0]
    return status, body


def start(command, log):
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    return process


def wait_ready(processes, log):
    for _ in range(100):
        if any(process.poll() is not None for process in processes):
            raise RuntimeError(log.read_text()[-2000:])
        try:
            if request("GET", "/v2/")[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.05)
    raise RuntimeError("Real Distribution did not become ready")


def exercise(cached):
    CONTROL.mkdir(exist_ok=True)
    (CONTROL / "freeze.map").write_text("freeze 0\n")
    config = textwrap.dedent(
        Path("/registry-configmap.yaml").read_text().split("  config.yml: |\n", 1)[1]
    )
    assert "blobdescriptor" not in config
    if cached:
        config = config.replace(
            "storage:\n", "storage:\n  cache:\n    blobdescriptor: inmemory\n"
        )
    config = config.replace("log:\n", "log:\n  level: error\n")
    path = Path("/tmp/distribution.yml")
    path.write_text(config)
    log_path = Path("/tmp/distribution.log")
    with log_path.open("w") as log:
        registry = start(["registry", "serve", str(path)], log)
        proxy = start(["haproxy", "-W", "-db", "-f", "/proxy.cfg"], log)
        try:
            wait_ready([registry, proxy], log_path)
            gate = WriteGate()
            gate.open()
            kept, kept_diff = layer(b"retained content")
            upload("lab/kept", kept)
            assert manifest("lab/kept", kept, kept_diff, "latest")[0] == 201
            reused, reused_diff = layer(b"old layer uploaded again after cleanup")
            reused_digest = upload("lab/reuse", reused)
            assert request("HEAD", "/v2/lab/reuse/blobs/" + reused_digest)[0] == 200
            store = Store(ROOT, workers=4)
            old = time.time() - 10 * 86400
            os.utime(store.blob(reused_digest), (old, old))
            protected = ["registry.example/lab/kept:latest"]
            plan = {**store.prepare(protected), "pvcUid": "claim", "pv": "volume"}
            assert [row["digest"] for row in plan["blobs"]] == [reused_digest]
            with gate.frozen(time.monotonic() + 10):
                result = store.collect(
                    plan,
                    protected,
                    gate.require_frozen,
                    quarantine_id="registry-collect-" + uuid.uuid4().hex,
                )
            Store(ROOT / "_gc_quarantine").purge(
                result["quarantineId"], "claim", "volume"
            )
            assert not store.blob(reused_digest).exists()
            head = request("HEAD", "/v2/lab/reuse/blobs/" + reused_digest)[0]
            if head == 404:
                upload("lab/reuse", reused)
            else:
                assert head == 200
            status, expected = manifest("lab/reuse", reused, reused_diff, "repushed")
            pull_ok = False
            truncated = False
            if status == 201:
                manifest_status, _, received = request(
                    "GET", "/v2/lab/reuse/manifests/repushed"
                )
                assert manifest_status == 200 and received == expected
                pulled = json.loads(received)
                pull_ok = True
                for descriptor in [pulled["config"], *pulled["layers"]]:
                    try:
                        blob_status, _, body = request(
                            "GET", "/v2/lab/reuse/blobs/" + descriptor["digest"]
                        )
                    except http.client.IncompleteRead:
                        truncated = True
                        pull_ok = False
                    else:
                        pull_ok &= (
                            blob_status == 200 and digest(body) == descriptor["digest"]
                        )
            assert registry.poll() is None and proxy.poll() is None
            return {
                "cacheEnabled": cached,
                "headAfterCollection": head,
                "repushManifestStatus": status,
                "fullPullMatches": pull_ok,
                "truncatedPull": truncated,
            }
        finally:
            for process in [proxy, registry]:
                process.terminate()
            for process in [proxy, registry]:
                process.wait(timeout=5)


baseline = exercise(True)
assert (
    baseline["headAfterCollection"] == 200
    and baseline["repushManifestStatus"] == 201
    and not baseline["fullPullMatches"]
), baseline
shutil.rmtree(ROOT.parent.parent)
fixed = exercise(False)
assert fixed["headAfterCollection"] == 404 and fixed["fullPullMatches"], fixed
print(
    json.dumps(
        {
            "before": baseline,
            "after": fixed,
            "sameProcessRepushPullRegressionPassed": True,
        }
    )
)
