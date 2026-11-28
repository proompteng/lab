"""Prepare online; collect only inside a bounded, verified read-only window."""

from contextlib import contextmanager
import hashlib
import json
import os
import re
import signal
import stat
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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


@contextmanager
def worker_pool(count):
    pending = set()
    handlers = {}
    executor = None
    failure = None

    def record(signum, _frame):
        pending.add(signum)

    def check_pending():
        if pending & {signal.SIGTERM, signal.SIGINT}:
            raise InterruptedError("Filesystem worker phase interrupted")
        if signal.SIGALRM in pending:
            raise TimeoutError("Filesystem worker phase exceeded its budget")

    def map_work(function, values):
        check_pending()
        for result in executor.map(function, values):
            check_pending()
            yield result

    try:
        # Install non-raising handlers before spawning workers, and restore them only after join.
        if threading.current_thread() is threading.main_thread():
            for signum in [signal.SIGTERM, signal.SIGINT, signal.SIGALRM]:
                previous = signal.getsignal(signum)
                if previous != signal.SIG_IGN:
                    handlers[signum] = previous
                    signal.signal(signum, record)
        executor = ThreadPoolExecutor(max_workers=count)
        yield map_work
    except BaseException as error:
        failure = error
        raise
    finally:
        if executor is not None:
            try:
                executor.shutdown(wait=True, cancel_futures=True)
            except BaseException:
                # A failed join must kill every mutation thread before its lock can be released.
                os._exit(70)
        for signum, previous in handlers.items():
            signal.signal(signum, previous)
        if failure is None or isinstance(failure, TimeoutError):
            check_pending()


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


def checked_path(path):
    if path.resolve() != path.absolute():
        raise ValueError("Symlink in quarantine path")
    return path


def content_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def tag_inventory(path):
    """Record every metadata inode before rename, so partial purges remain verifiable."""
    result = {}
    directories = [checked_path(path)]
    while directories:
        directory = checked_path(directories.pop())
        result[directory.relative_to(path).as_posix()] = {
            "inode": directory.stat().st_ino
        }
        with os.scandir(directory) as entries:
            for entry in entries:
                file = checked_path(Path(entry.path))
                if stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode):
                    directories.append(file)
                    continue
                before = signature(file)
                digest = content_digest(file)
                if signature(file) != before:
                    raise ValueError("Tag metadata changed while hashing")
                result[file.relative_to(path).as_posix()] = {
                    "signature": before,
                    "sha256": digest,
                }
    return result


def validate_receipt(receipt, batch, pvc_uid, pv):
    if not isinstance(receipt, dict) or receipt.get("version") != 3:
        raise ValueError(
            "Invalid quarantine receipt: version 3 required; older receipts need "
            "verified recovery (see docs/registry/manual-garbage-collection.md)"
        )
    if not pvc_uid or not pv or receipt.get("storage") != {"pvcUid": pvc_uid, "pv": pv}:
        raise ValueError("Quarantine receipt belongs to a different registry claim/PV")
    if receipt.get("batch") != batch or type(receipt.get("inode")) is not int:
        raise ValueError("Invalid quarantine receipt ownership")
    for key in ("blobs", "tags"):
        if not isinstance(receipt.get(key), list):
            raise TypeError("Invalid quarantine receipt entries")

    def valid_signature(value):
        if (
            not isinstance(value, list)
            or len(value) != 4
            or any(type(item) is not int or item < 0 for item in value)
        ):
            raise ValueError("Invalid quarantine receipt signature")

    seen = set()
    for row in receipt["blobs"]:
        value = encoded(row["digest"])
        valid_signature(row["signature"])
        if value in seen:
            raise ValueError("Duplicate quarantine blob")
        seen.add(value)
    seen = set()
    for row in receipt["tags"]:
        key = (row["repository"], row["tag"])
        if key in seen:
            raise ValueError("Duplicate quarantine tag")
        seen.add(key)
        encoded(row["value"]["digest"])
        valid_signature(row["value"]["signature"])
        entries = row["entries"]
        if (
            not isinstance(entries, dict)
            or "." not in entries
            or "current/link" not in entries
        ):
            raise ValueError("Invalid quarantined tag inventory")
        for name, entry in entries.items():
            if name != "." and (
                not name or any(part in ("", ".", "..") for part in name.split("/"))
            ):
                raise ValueError("Unsafe quarantined tag path")
            if "inode" in entry:
                if type(entry["inode"]) is not int or entry["inode"] < 1:
                    raise ValueError("Invalid quarantined directory inode")
            else:
                valid_signature(entry["signature"])
                encoded("sha256:" + entry["sha256"])
        if entries["current/link"].get("signature") != row["value"]["signature"]:
            raise ValueError("Quarantined tag inventory disagrees with its link")


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
        with worker_pool(self.workers) as map_work:
            for repository, tag, value in map_work(tag_value, tag_files):
                tags[repository][tag] = value
            for value in map_work(recent_value, revision_files):
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

        with worker_pool(self.workers) as map_work:
            while pending:
                batch = pending - visited
                pending = set()
                for digest, manifest, children, blobs in map_work(inspect, batch):
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

            list(map_work(verify, expected_sizes.items()))
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

        with worker_pool(self.workers) as map_work:
            blobs = [
                row
                for rows in map_work(candidates, (self.root / "blobs/sha256").iterdir())
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
        if not plan.get("pvcUid") or not plan.get("pv"):
            raise ValueError("Collection requires the prepared claim/PV identity")
        quarantine_id = quarantine_id or "registry-collect-" + uuid.uuid4().hex
        if not re.fullmatch(r"[a-z0-9-]{1,80}", quarantine_id):
            raise ValueError("Invalid quarantine identifier")
        quarantine = checked_path(self.root / "_gc_quarantine" / quarantine_id)

        def inventory_tag(row):
            path = self.repository(row["repository"]) / "_manifests/tags" / row["tag"]
            return {**row, "entries": tag_inventory(path)}

        with worker_pool(min(self.workers, 16)) as map_work:
            tag_rows = list(map_work(inventory_tag, deletes))
        quarantine.mkdir(parents=True, exist_ok=False)
        receipt = quarantine / "receipt.json"
        document = {
            "version": 3,
            "batch": quarantine_id,
            "storage": {"pvcUid": plan["pvcUid"], "pv": plan["pv"]},
            "inode": quarantine.stat().st_ino,
            "blobs": rows,
            "tags": tag_rows,
        }
        validate_receipt(document, quarantine_id, plan["pvcUid"], plan["pv"])
        with receipt.open("x") as output:
            json.dump(document, output)
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
        with worker_pool(min(self.workers, 16)) as map_work:
            deleted_tags = sum(map_work(move_tag, deletes))

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
        with worker_pool(min(self.workers, 16)) as map_work:
            sizes = list(map_work(move, rows))
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

    def purge(self, quarantine_id, pvc_uid, pv):
        if not re.fullmatch(r"[a-z0-9-]{1,80}", quarantine_id):
            raise ValueError("Invalid quarantine identifier")
        quarantine = checked_path(self.root / quarantine_id)
        finished = checked_path(self.root / (".purged-" + quarantine_id))
        if finished.exists():
            if quarantine.exists():
                raise ValueError("Conflicting quarantine finalization")
            # Only an atomic rename of an emptied, verified batch enters this
            # state. Never traverse or recursively delete an unexpected file.
            if list(finished.iterdir()) not in ([], [finished / "receipt.json"]):
                raise ValueError("Unexpected files in finalized quarantine")
            receipt_path = checked_path(finished / "receipt.json")
            if receipt_path.exists():
                signature(receipt_path)
                receipt = json.loads(receipt_path.read_text())
                validate_receipt(receipt, quarantine_id, pvc_uid, pv)
                if finished.stat().st_ino != receipt["inode"]:
                    raise ValueError("Quarantine directory identity changed")
                receipt_path.unlink()
            finished.rmdir()
            return {"deletedTags": 0, "deletedBlobs": 0, "deletedBytes": 0}
        if not any(quarantine.iterdir()):
            quarantine.rmdir()
            return {"deletedTags": 0, "deletedBlobs": 0, "deletedBytes": 0}
        receipt_path = checked_path(quarantine / "receipt.json")
        signature(receipt_path)
        receipt = json.loads(receipt_path.read_text())
        validate_receipt(receipt, quarantine_id, pvc_uid, pv)
        if quarantine.stat().st_ino != receipt["inode"]:
            raise ValueError("Quarantine directory identity changed")

        def remove_tag(row):
            path = checked_path(self.quarantined_tag(quarantine, row))
            if not path.exists():
                return False
            # Missing entries were already removed on a previous attempt. Never
            # infer ownership from a missing current/link or adopt new metadata.
            current = tag_inventory(path)
            for name, entry in current.items():
                expected = row["entries"].get(name)
                if expected is None:
                    raise ValueError("Quarantined tag changed")
                if "inode" in entry:
                    unchanged = entry == expected
                else:
                    unchanged = entry["signature"][1:] == expected.get("signature", [])[
                        1:
                    ] and entry["sha256"] == expected.get("sha256")
                if not unchanged:
                    raise ValueError("Quarantined tag changed")
            for name, entry in current.items():
                if "signature" in entry:
                    (path / name).unlink()
            for name in sorted(
                current, key=lambda name: len(Path(name).parts), reverse=True
            ):
                if "inode" in current[name]:
                    (path / name).rmdir()
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
            # Device numbers are mount-local, unlike the claim/PV binding and
            # inode. Keep the full signature checks in prepare/collect unchanged.
            if current[1:] != row["signature"][1:] or content_digest(path) != value:
                raise ValueError("Quarantined file changed: " + row["digest"])
            if signature(path) != current:
                raise ValueError("Quarantined file changed while hashing")
            path.unlink()
            emit("purged", digest=row["digest"], bytes=current[2])
            return current[2]

        with worker_pool(min(self.workers, 8)) as map_work:
            deleted_tags = sum(map_work(remove_tag, receipt["tags"]))
            sizes = list(map_work(remove, receipt["blobs"]))
        for path in quarantine.iterdir():
            if path.is_dir():
                path.rmdir()
        if list(quarantine.iterdir()) != [receipt_path]:
            raise ValueError("Unexpected files in quarantine")
        # Persist the terminal state before removing the receipt. A process/Pod
        # interruption here can only leave a receipt or an empty finalizer directory.
        quarantine.rename(finished)
        directory_fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        (finished / "receipt.json").unlink()
        finished.rmdir()
        return {
            "deletedTags": deleted_tags,
            "deletedBlobs": sum(size is not None for size in sizes),
            "deletedBytes": sum(size for size in sizes if size is not None),
        }
