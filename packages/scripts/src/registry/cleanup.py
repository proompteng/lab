#!/usr/bin/env python3
"""Prepare online; collect only inside a bounded, verified read-only window."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import urllib.error
import urllib.request
import uuid

DIGEST = re.compile(r"sha256:([0-9a-f]{64})\Z")
BUILD_TAG = re.compile(
    r"(?:[0-9a-f]{7,64}|(?:prepare-|kargo-)?sha-[0-9a-f]{7,64}(?:-run-[0-9]+(?:-[a-z0-9.-]+)?)?)\Z"
)
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}


def encoded(digest):
    match = DIGEST.fullmatch(digest)
    if not match:
        raise ValueError(f"Invalid digest: {digest!r}")
    return match[1]


def signature(path):
    value = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode):
        raise ValueError(f"Expected a regular file: {path}")
    return [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns]


def emit(event, **values):
    print(json.dumps({"event": event, **values}), file=sys.stderr, flush=True)


class Store:
    def __init__(self, root, workers=16):
        self.root = Path(root)
        if self.root.is_symlink():
            raise ValueError("Registry root must not be a symlink")
        self.root = self.root.resolve()
        self.workers = workers

    def blob(self, digest):
        value = encoded(digest)
        return self.root / "blobs/sha256" / value[:2] / value / "data"

    def identity(self):
        value = self.root.stat()
        return [value.st_dev, value.st_ino]

    def repositories(self):
        result = []
        base = self.root / "repositories"
        for current, directories, _ in os.walk(base, followlinks=False):
            directories[:] = [name for name in directories if not name.startswith("_")]
            path = Path(current)
            if (path / "_manifests").is_dir():
                result.append(path.relative_to(base).as_posix())
        return sorted(result)

    def repository(self, name):
        parts = name.split("/")
        if any(
            not part or part in {".", ".."} or part.startswith("_") for part in parts
        ):
            raise ValueError(f"Invalid repository: {name!r}")
        path = self.root / "repositories" / name
        if path.resolve() != path.absolute():
            raise ValueError(f"Symlink in repository path: {name!r}")
        return path

    def scan_roots(self, cutoff_ns):
        tags = {}
        recent = set()
        tag_files = []
        revision_files = []
        for repository in self.repositories():
            root = self.repository(repository) / "_manifests"
            tags[repository] = {}
            path = root / "tags"
            if path.exists():
                tag_files.extend(
                    (repository, child.name, child / "current/link")
                    for child in path.iterdir()
                )
            path = root / "revisions/sha256"
            if path.exists():
                revision_files.extend(
                    (child.name, child / "link") for child in path.iterdir()
                )

        def tag_value(item):
            repository, tag, path = item
            value = path.read_text().strip()
            encoded(value)
            revision = (
                self.repository(repository)
                / "_manifests/revisions/sha256"
                / encoded(value)
                / "link"
            )
            if revision.read_text().strip() != value:
                raise ValueError(
                    f"Tagged manifest revision is missing or changed: {path}"
                )
            return repository, tag, {"digest": value, "signature": signature(path)}

        def recent_value(item):
            value, path = item
            try:
                modified = signature(path)[3]
            except FileNotFoundError:
                # Distribution can leave empty revision directories after API deletion.
                return None
            if modified < cutoff_ns:
                return None
            digest = path.read_text().strip()
            if encoded(digest) != value:
                raise ValueError(f"Revision link disagrees with its name: {path}")
            try:
                signature(self.blob(digest))
            except FileNotFoundError:
                return None
            return digest

        emit(
            "scanning",
            repositories=len(tags),
            tagLinks=len(tag_files),
            revisionLinks=len(revision_files),
        )
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for repository, tag, value in pool.map(tag_value, tag_files):
                tags[repository][tag] = value
            for value in pool.map(recent_value, revision_files):
                if value:
                    recent.add(value)
        return tags, recent

    def protected(self, references, tags):
        roots = set()
        protected_tags = set()
        for reference in references:
            name = reference.split("/", 1)[1]
            if "@" in name:
                repository, digest = name.rsplit("@", 1)
                self.repository(repository)
                encoded(digest)
                roots.add(digest)
            else:
                repository, tag = name.rsplit(":", 1)
                roots.add(tags[repository][tag]["digest"])
                protected_tags.add((repository, tag))
        return roots, protected_tags

    def retained_roots(self, tags, recent, references, deletes=()):
        roots, protected_tags = self.protected(references, tags)
        roots.update(recent)
        omitted = {(row["repository"], row["tag"]): row for row in deletes}
        applicable = []
        for repository, values in tags.items():
            for tag, value in values.items():
                row = omitted.get((repository, tag))
                if (
                    row
                    and row["value"] == value
                    and (repository, tag) not in protected_tags
                ):
                    applicable.append(row)
                else:
                    roots.add(value["digest"])
        return roots, applicable

    def select_delete_tags(self, tags, references, cutoff_ns, keep):
        _, protected_tags = self.protected(references, tags)
        deletes = []
        for repository, values in tags.items():
            builds = sorted(
                (
                    (tag, value)
                    for tag, value in values.items()
                    if BUILD_TAG.fullmatch(tag)
                ),
                key=lambda row: (row[1]["signature"][3], row[0]),
                reverse=True,
            )
            for tag, value in builds[keep:]:
                if (
                    value["signature"][3] < cutoff_ns
                    and (repository, tag) not in protected_tags
                ):
                    deletes.append(
                        {"repository": repository, "tag": tag, "value": value}
                    )
        return deletes

    @staticmethod
    def quarantined_tag(quarantine, row):
        key = hashlib.sha256(
            (row["repository"] + ":" + row["tag"]).encode()
        ).hexdigest()
        return quarantine / "tags" / key

    def graph(self, roots, cached=None):
        manifests = dict(cached or {})
        marked = set()
        expected_sizes = {}
        visited = set()
        pending = set(roots)

        def inspect(digest):
            path = self.blob(digest)
            current = signature(path)
            previous = manifests.get(digest)
            if previous and previous["signature"] == current:
                raw = previous["raw"].encode()
            else:
                if current[2] > 16 * 1024 * 1024:
                    raise ValueError(f"Manifest exceeds 16 MiB: {digest}")
                raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != encoded(digest):
                raise ValueError(f"Manifest digest mismatch: {digest}")
            body = json.loads(raw)
            if body.get("schemaVersion") != 2:
                raise ValueError(f"Unsupported manifest schema: {digest}")
            media_type = body.get("mediaType")
            if media_type in INDEX_TYPES:
                children, blobs = body["manifests"], []
            elif media_type in IMAGE_TYPES:
                children, blobs = [], [body["config"], *body["layers"]]
            else:
                raise ValueError(f"Unsupported manifest media type: {media_type!r}")
            if body.get("subject"):
                children = [*children, body["subject"]]
            for descriptor in [*children, *blobs]:
                encoded(descriptor["digest"])
                size = descriptor["size"]
                if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                    raise ValueError(f"Invalid descriptor size: {digest}")
            return digest, {"signature": current, "raw": raw.decode()}, children, blobs

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            while pending:
                batch = pending - visited
                pending = set()
                for digest, manifest, children, blobs in pool.map(inspect, batch):
                    manifests[digest] = manifest
                    visited.add(digest)
                    marked.add(digest)
                    for descriptor in [*children, *blobs]:
                        child, size = descriptor["digest"], descriptor["size"]
                        if child in expected_sizes and expected_sizes[child] != size:
                            raise ValueError(f"Conflicting descriptor sizes: {child}")
                        expected_sizes[child] = size
                        marked.add(child)
                    pending.update(item["digest"] for item in children)

            def verify(item):
                digest, size = item
                if signature(self.blob(digest))[2] != size:
                    raise ValueError(f"Missing or truncated retained blob: {digest}")

            list(pool.map(verify, expected_sizes.items()))
        return marked, {digest: manifests[digest] for digest in visited}

    def prepare(self, references, keep=5, days=7, prune_tags=True):
        if not isinstance(keep, int) or keep < 5 or days < 7:
            raise ValueError("Retention requires keep>=5 and days>=7")
        started = time.monotonic()
        cutoff_ns = time.time_ns() - days * 86400 * 1_000_000_000
        tags, recent = self.scan_roots(cutoff_ns)
        deletes = (
            self.select_delete_tags(tags, references, cutoff_ns, keep)
            if prune_tags
            else []
        )
        roots, deletes = self.retained_roots(tags, recent, references, deletes)
        emit(
            "roots", repositories=len(tags), roots=len(roots), tagsToRemove=len(deletes)
        )
        marked, manifests = self.graph(roots)
        emit("graph", retainedManifests=len(manifests), retainedBlobs=len(marked))

        def candidates(prefix):
            result = []
            for directory in prefix.iterdir():
                digest = "sha256:" + directory.name
                encoded(digest)
                if digest in marked:
                    continue
                path = directory / "data"
                try:
                    value = signature(path)
                except FileNotFoundError:
                    continue
                if value[3] < cutoff_ns:
                    result.append({"digest": digest, "signature": value})
            return result

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            blobs = [
                row
                for rows in pool.map(candidates, (self.root / "blobs/sha256").iterdir())
                for row in rows
            ]
        blobs.sort(key=lambda row: row["signature"][2], reverse=True)
        result = {
            "version": 2,
            "identity": self.identity(),
            "cutoffNs": cutoff_ns,
            "keep": keep,
            "references": references,
            "deleteTags": deletes,
            "manifests": manifests,
            "blobs": blobs,
            "candidateBytes": sum(row["signature"][2] for row in blobs),
        }
        emit(
            "prepared",
            candidates=len(blobs),
            candidateBytes=result["candidateBytes"],
            seconds=round(time.monotonic() - started, 1),
        )
        return result

    def collect(
        self,
        plan,
        references,
        require_frozen,
        max_blobs=2000,
        seconds=180,
        quarantine_id=None,
    ):
        if plan["version"] != 2 or plan["identity"] != self.identity():
            raise ValueError("Plan belongs to a different registry filesystem")
        if (
            not isinstance(plan["keep"], int)
            or plan["keep"] < 5
            or plan["cutoffNs"] > time.time_ns() - 7 * 86400 * 1_000_000_000
        ):
            raise ValueError("Plan weakens minimum retention")
        deadline = time.monotonic() + seconds
        require_frozen()
        tags, recent = self.scan_roots(plan["cutoffNs"])
        eligible = {
            (row["repository"], row["tag"]): row
            for row in self.select_delete_tags(
                tags, references, plan["cutoffNs"], plan["keep"]
            )
        }
        roots, deletes = self.retained_roots(
            tags,
            recent,
            references,
            [
                row
                for row in plan["deleteTags"]
                if eligible.get((row["repository"], row["tag"])) == row
            ],
        )
        marked, _ = self.graph(roots, plan["manifests"])
        require_frozen()
        if time.monotonic() >= deadline:
            raise TimeoutError(
                "Frozen validation exceeded collection budget; no deletes performed"
            )
        rows = []
        already_missing = 0
        for row in plan["blobs"]:
            digest = row["digest"]
            if digest in marked:
                continue
            if row["signature"][3] >= plan["cutoffNs"]:
                raise ValueError("Plan contains a recent blob")
            try:
                current = signature(self.blob(digest))
            except FileNotFoundError:
                already_missing += 1
                continue
            if current != row["signature"]:
                raise ValueError(f"Candidate changed: {digest}")
            rows.append(row)
            if len(rows) >= max_blobs:
                break
        for row in deletes:
            link = (
                self.repository(row["repository"])
                / "_manifests/tags"
                / row["tag"]
                / "current/link"
            )
            if signature(link) != row["value"]["signature"]:
                raise ValueError("Tag changed during frozen validation")
        quarantine_id = quarantine_id or "registry-collect-" + uuid.uuid4().hex
        if not re.fullmatch(r"[a-z0-9-]{1,80}", quarantine_id):
            raise ValueError("Invalid quarantine identifier")
        quarantine = self.root / "_gc_quarantine" / quarantine_id
        quarantine.mkdir(parents=True, exist_ok=False)
        receipt = quarantine / "receipt.json"
        with receipt.open("x") as output:
            json.dump({"version": 2, "blobs": rows, "tags": deletes}, output)
            output.flush()
            os.fsync(output.fileno())
        directory_fd = os.open(quarantine, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

        def move_tag(row):
            if time.monotonic() >= deadline:
                return False
            path = self.repository(row["repository"]) / "_manifests/tags" / row["tag"]
            target = self.quarantined_tag(quarantine, row)
            target.parent.mkdir(exist_ok=True)
            os.rename(path, target)
            return True

        # Tag directories also contain allocated metadata; do not unlink them while frozen.
        with ThreadPoolExecutor(max_workers=min(self.workers, 16)) as pool:
            deleted_tags = sum(pool.map(move_tag, deletes))

        def move(row):
            if time.monotonic() >= deadline or deleted_tags != len(deletes):
                return None
            path = self.blob(row["digest"])
            if signature(path) != row["signature"]:
                raise ValueError(
                    f"Candidate changed before quarantine: {row['digest']}"
                )
            value = encoded(row["digest"])
            target = quarantine / value[:2] / value
            target.parent.mkdir(exist_ok=True)
            os.rename(path, target)
            return row["signature"][2]

        # Rename preserves allocated blocks. Their slow physical release happens after writes reopen.
        with ThreadPoolExecutor(max_workers=min(self.workers, 16)) as pool:
            sizes = list(pool.map(move, rows))
        quarantined_blobs = sum(size is not None for size in sizes)
        return {
            "deletedTags": deleted_tags,
            "quarantineId": quarantine_id,
            "quarantinedBlobs": quarantined_blobs,
            "quarantinedBytes": sum(size for size in sizes if size is not None),
            "collectionTimedOut": deleted_tags < len(deletes)
            or quarantined_blobs < len(rows),
            "remainingCandidates": len(plan["blobs"])
            - already_missing
            - quarantined_blobs,
        }

    def purge(self, quarantine_id):
        if not re.fullmatch(r"[a-z0-9-]{1,80}", quarantine_id):
            raise ValueError("Invalid quarantine identifier")
        quarantine = self.root / quarantine_id
        if quarantine.resolve() != quarantine.absolute():
            raise ValueError("Symlink in quarantine path")
        receipt = json.loads((quarantine / "receipt.json").read_text())
        if receipt["version"] != 2:
            raise ValueError("Unknown quarantine receipt version")

        def remove_tag(row):
            path = self.quarantined_tag(quarantine, row)
            if path.resolve() != path.absolute():
                raise ValueError("Symlink in quarantined tag path")
            if not path.exists():
                return False
            link = path / "current/link"
            if link.exists() and (
                signature(link) != row["value"]["signature"]
                or link.read_text().strip() != row["value"]["digest"]
            ):
                raise ValueError("Quarantined tag changed")
            for current, directories, files in os.walk(path, followlinks=False):
                if any(
                    (Path(current) / name).is_symlink() for name in directories + files
                ):
                    raise ValueError("Symlink in quarantined tag contents")
            shutil.rmtree(path)
            return True

        def remove(row):
            value = encoded(row["digest"])
            path = quarantine / value[:2] / value
            if path.resolve() != path.absolute():
                raise ValueError("Symlink in quarantined file path")
            try:
                current = signature(path)
            except FileNotFoundError:
                return None
            if current != row["signature"]:
                raise ValueError("Quarantined file changed: " + row["digest"])
            path.unlink()
            emit("purged", digest=row["digest"], bytes=current[2])
            return current[2]

        with ThreadPoolExecutor(max_workers=min(self.workers, 8)) as pool:
            deleted_tags = sum(pool.map(remove_tag, receipt["tags"]))
            sizes = list(pool.map(remove, receipt["blobs"]))
        for path in quarantine.iterdir():
            if path.is_dir():
                path.rmdir()
        (quarantine / "receipt.json").unlink()
        quarantine.rmdir()
        return {
            "deletedTags": deleted_tags,
            "deletedBlobs": sum(size is not None for size in sizes),
            "deletedBytes": sum(size for size in sizes if size is not None),
        }


def require_read_only(base_url):
    base = base_url.rstrip("/") + "/v2/"
    with urllib.request.urlopen(base, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError("Registry read endpoint is unavailable")
    request = urllib.request.Request(
        base + "ceph-smoke/registry-gc-check/blobs/uploads/", b"", method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            pass
    except urllib.error.HTTPError as error:
        if error.code == 405:
            return
        raise
    raise RuntimeError("Registry accepts uploads; refusing filesystem deletion")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "collect", "purge"])
    parser.add_argument("--root", default="/var/lib/registry/docker/registry/v2")
    parser.add_argument(
        "--references",
        help="Fresh workload and retained Kargo reference JSON",
    )
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--keep", type=int, default=5)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--no-prune-tags", action="store_true")
    parser.add_argument("--plan")
    parser.add_argument("--quarantine-id")
    parser.add_argument(
        "--base-url", default="http://registry.registry.svc.cluster.local"
    )
    parser.add_argument("--max-blobs", type=int, default=2000)
    parser.add_argument("--seconds", type=int, default=180)
    args = parser.parse_args()
    if (
        not 1 <= args.workers <= 32
        or args.keep < 5
        or args.days < 7
        or args.seconds < 1
        or args.max_blobs < 1
    ):
        parser.error("Use 1..32 workers, keep>=5, days>=7, seconds>=1 and max-blobs>=1")
    store = Store(args.root, args.workers)
    if args.operation == "purge":
        if not args.quarantine_id:
            parser.error(
                "purge requires --quarantine-id and a quarantine-only --root mount"
            )
        print(json.dumps(store.purge(args.quarantine_id)))
        return
    if not args.references:
        parser.error("prepare and collect require --references")
    references = json.loads(Path(args.references).read_text())
    if (
        not isinstance(references, list)
        or not references
        or not all(isinstance(value, str) for value in references)
    ):
        parser.error("A nonempty protection reference list is required")
    if args.operation == "prepare":
        result = store.prepare(references, args.keep, args.days, not args.no_prune_tags)
    else:
        if not args.plan:
            parser.error("collect requires --plan")
        plan = json.loads(Path(args.plan).read_text())
        result = store.collect(
            plan,
            references,
            lambda: require_read_only(args.base_url),
            args.max_blobs,
            args.seconds,
            args.quarantine_id,
        )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
