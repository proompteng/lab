"""Restore a legacy quarantine without granting it deletion authority."""

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cleanup


def location(store, batch):
    if not re.fullmatch(r"[a-z0-9-]{1,80}", batch):
        raise ValueError("Invalid recovery batch")
    return cleanup.checked_path(store.root / "_gc_quarantine" / batch)


def target_tag(store, row):
    if not cleanup.BUILD_TAG.fullmatch(row["tag"]):
        raise ValueError("Unexpected legacy build tag")
    return cleanup.checked_path(
        store.repository(row["repository"]) / "_manifests/tags" / row["tag"]
    )


def unchanged(path, expected):
    if (
        not isinstance(expected, list)
        or len(expected) != 4
        or any(type(value) is not int or value < 0 for value in expected)
    ):
        raise ValueError("Invalid recovery file signature")
    actual = cleanup.signature(path)
    if actual[1:] != expected[1:]:
        raise ValueError("Recovery file changed: " + str(path))
    return actual


def prepare(store, batch, pvc_uid, pv):
    quarantine = location(store, batch)
    raw = cleanup.checked_path(quarantine / "receipt.json").read_bytes()
    receipt = json.loads(raw)
    if receipt.get("version") != 2 or not pvc_uid or not pv:
        raise ValueError("Recovery requires a version 2 receipt and Bound claim")
    if len({r["digest"] for r in receipt["blobs"]}) != len(receipt["blobs"]):
        raise ValueError("Duplicate recovery blob")
    if len({(r["repository"], r["tag"]) for r in receipt["tags"]}) != len(
        receipt["tags"]
    ):
        raise ValueError("Duplicate recovery tag")

    def inspect_blob(row):
        digest = cleanup.encoded(row["digest"])
        source = cleanup.checked_path(quarantine / digest[:2] / digest)
        before = unchanged(source, row["signature"])
        if cleanup.content_digest(source) != digest:
            raise ValueError("Recovery blob digest mismatch: " + row["digest"])
        if cleanup.signature(source) != before:
            raise ValueError("Recovery blob changed while hashing")
        target = cleanup.checked_path(store.blob(row["digest"]))
        existing = None
        if target.exists():
            existing = cleanup.signature(target)
            if (
                cleanup.content_digest(target) != digest
                or cleanup.signature(target) != existing
            ):
                raise ValueError("Existing registry blob digest mismatch")
        return {**row, "signature": before, "target": existing}

    def inspect_tag(row):
        cleanup.encoded(row["value"]["digest"])
        target = target_tag(store, row)
        source = cleanup.checked_path(store.quarantined_tag(quarantine, row))
        link = source / "current/link"
        unchanged(link, row["value"]["signature"])
        if link.read_text().strip() != row["value"]["digest"]:
            raise ValueError("Recovery tag digest changed")
        entries = cleanup.tag_inventory(source)
        for name, entry in entries.items():
            if "signature" not in entry:
                continue
            parts = name.split("/")
            if parts == ["current", "link"]:
                expected = row["value"]["digest"]
            elif (
                len(parts) == 4
                and parts[:2] == ["index", "sha256"]
                and parts[3] == "link"
            ):
                cleanup.encoded("sha256:" + parts[2])
                expected = "sha256:" + parts[2]
            else:
                raise ValueError("Unexpected quarantined tag metadata")
            if (source / name).read_text().strip() != expected:
                raise ValueError("Invalid quarantined tag metadata")
        return {
            **row,
            "entries": entries,
            "target": target.stat().st_ino if target.exists() else None,
        }

    blobs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for row in pool.map(inspect_blob, receipt["blobs"]):
            blobs.append(row)
            if len(blobs) % 100 == 0:
                cleanup.emit("recovery-verified", blobs=len(blobs))
        tags = list(pool.map(inspect_tag, receipt["tags"]))
    return {
        "version": 1,
        "operation": "restore",
        "pvcUid": pvc_uid,
        "pv": pv,
        "batch": batch,
        "inode": quarantine.stat().st_ino,
        "receiptSha256": hashlib.sha256(raw).hexdigest(),
        "blobs": blobs,
        "tags": tags,
    }


def persist(path, raw):
    cleanup.checked_path(path)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError("Recovery archive changed: " + str(path))
        return
    temporary = cleanup.checked_path(path.with_suffix(".tmp"))
    with temporary.open("wb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


def sync_directory(path):
    directory = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def check_tag(path, entries):
    actual = cleanup.tag_inventory(path)

    def normalized(inventory):
        return {
            name: entry
            if "inode" in entry
            else {**entry, "signature": entry["signature"][1:]}
            for name, entry in inventory.items()
        }

    if normalized(actual) != normalized(entries):
        raise ValueError("Recovery tag changed: " + str(path))


def restore(store, plan, require_frozen, seconds=180):
    if plan.get("version") != 1 or plan.get("operation") != "restore":
        raise ValueError("Invalid restoration plan")
    quarantine = location(store, plan["batch"])
    archive = cleanup.checked_path(quarantine.with_name(".restored-" + plan["batch"]))
    completed = cleanup.checked_path(archive / "completed")
    if not quarantine.exists() and completed.exists():
        quarantine = completed
    require_frozen()
    raw = cleanup.checked_path(quarantine / "receipt.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != plan["receiptSha256"]:
        raise ValueError("Recovery receipt changed")
    if quarantine.stat().st_ino != plan["inode"]:
        raise ValueError("Recovery batch identity changed")
    receipt = json.loads(raw)

    def blob_contract(rows):
        return sorted((r["digest"], r["signature"][1:]) for r in rows)

    def tag_contract(rows):
        return sorted(
            (
                r["repository"],
                r["tag"],
                r["value"]["digest"],
                r["value"]["signature"][1:],
            )
            for r in rows
        )

    if (
        receipt.get("version") != 2
        or blob_contract(receipt["blobs"]) != blob_contract(plan["blobs"])
        or tag_contract(receipt["tags"]) != tag_contract(plan["tags"])
    ):
        raise ValueError("Restoration plan disagrees with original receipt")
    deadline = time.monotonic() + seconds
    allowed_files = {"receipt.json"}
    for row in plan["blobs"]:
        digest = cleanup.encoded(row["digest"])
        allowed_files.add(digest[:2] + "/" + digest)
    for row in plan["tags"]:
        name = store.quarantined_tag(quarantine, row).name
        allowed_files.update(
            "tags/" + name + "/" + key
            for key, entry in row["entries"].items()
            if "signature" in entry
        )

    def inspect_blob(row):
        digest = cleanup.encoded(row["digest"])
        source = cleanup.checked_path(quarantine / digest[:2] / digest)
        target = cleanup.checked_path(store.blob(row["digest"]))
        saved = cleanup.checked_path(archive / "blobs" / digest)
        if source.exists():
            unchanged(source, row["signature"])
            if target.exists():
                current = cleanup.signature(target)
                if current[1:] == row["signature"][1:]:
                    destination = target
                elif row["target"] is not None:
                    unchanged(target, row["target"])
                    destination = saved
                else:
                    raise ValueError(
                        "Registry destination changed after recovery planning"
                    )
            else:
                destination = target
        elif saved.exists():
            unchanged(saved, row["signature"])
            destination = saved
        else:
            unchanged(target, row["signature"])
            destination = target
        if destination == saved and saved.exists():
            unchanged(saved, row["signature"])
        return source, destination, "Blobs", row["signature"]

    def inspect_tag(row):
        target = target_tag(store, row)
        source = cleanup.checked_path(store.quarantined_tag(quarantine, row))
        saved = cleanup.checked_path(archive / "tags" / source.name)
        if source.exists():
            check_tag(source, row["entries"])
            if target.exists():
                if target.stat().st_ino != row["target"]:
                    raise ValueError(
                        "Registry tag destination changed after recovery planning"
                    )
                destination = saved
            else:
                destination = target
        elif saved.exists():
            check_tag(saved, row["entries"])
            destination = saved
        else:
            # This directory could only acquire its quarantine inode by our rename.
            # Uploads may have legitimately advanced its link after an interrupted hold.
            if (
                not target.is_dir()
                or target.stat().st_ino != row["entries"]["."]["inode"]
            ):
                raise ValueError("Restored tag directory identity changed")
            destination = target
        if destination == saved and saved.exists():
            check_tag(saved, row["entries"])
        return source, destination, "Tags", None

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = [
            *pool.map(inspect_blob, plan["blobs"]),
            *pool.map(inspect_tag, plan["tags"]),
        ]
    for current, directories, files in os.walk(quarantine, followlinks=False):
        for name in directories + files:
            if (Path(current) / name).is_symlink():
                raise ValueError("Symlink in legacy quarantine")
        if any(
            (Path(current) / name).relative_to(quarantine).as_posix()
            not in allowed_files
            for name in files
        ):
            raise ValueError("Unexpected files in legacy quarantine")
    archive.mkdir(exist_ok=True)
    persist(archive / "receipt.v2.json", raw)
    persist(archive / "plan.json", json.dumps(plan, sort_keys=True).encode())
    result = {
        "restoredBlobs": 0,
        "restoredTags": 0,
        "archivedBlobs": 0,
        "archivedTags": 0,
    }

    def move(row):
        source, destination, kind, expected = row
        if time.monotonic() >= deadline:
            raise TimeoutError("Restoration deadline reached; resume the same plan")
        if source.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            if expected is None:
                source.rename(destination)
                sync_directory(destination.parent)
            elif destination.exists():
                unchanged(destination, expected)
                sync_directory(destination.parent)
                source.unlink()
            else:
                # Keep a destination link durable before removing the quarantine name.
                os.link(source, destination)
                sync_directory(destination.parent)
                source.unlink()
        action = "archived" if destination.is_relative_to(archive) else "restored"
        return action + kind

    with ThreadPoolExecutor(max_workers=8) as pool:
        for action in pool.map(move, rows):
            result[action] += 1
    for current, _, files in os.walk(quarantine):
        path = Path(current)
        if files and (path != quarantine or files != ["receipt.json"]):
            raise ValueError("Unexpected files remain in legacy quarantine")
    if quarantine != completed:
        quarantine.rename(completed)
        sync_directory(archive)
        sync_directory(archive.parent)
    return {**result, "archive": archive.name}


def operator(args):
    from collect import Collection
    from prepare import CONTAINER, copy_verified, maintenance_pod

    client = Collection(args.context)
    if args.apply:
        result = client.run(args.plan, args.plan, restoring=True)
        print(json.dumps(result))
        return
    if not args.batch:
        raise ValueError("Preparing restoration requires --batch")
    pvc = client.get("registry", "pvc", "registry-data")
    if pvc["status"]["phase"] != "Bound":
        raise ValueError("Registry claim is not Bound")
    pod = maintenance_pod(client)["metadata"]["name"]
    prefix = "/dev/shm/registry-recover-" + uuid.uuid4().hex[:12]
    try:
        client.command(
            ["-n", "registry", "exec", pod, "-c", CONTAINER, "--", "mkdir", prefix]
        )
        for name in ["cleanup", "recover"]:
            copy_verified(
                client,
                pod,
                Path(__file__).with_name(name + ".py"),
                prefix + "/" + name + ".py",
            )
        with args.plan.open("w") as output:
            subprocess.run(
                client.kubectl
                + [
                    "-n",
                    "registry",
                    "exec",
                    pod,
                    "-c",
                    CONTAINER,
                    "--",
                    "python3",
                    prefix + "/recover.py",
                    "--prepare",
                    "--batch",
                    args.batch,
                    "--pvc-uid",
                    pvc["metadata"]["uid"],
                    "--pv",
                    pvc["spec"]["volumeName"],
                ],
                stdout=output,
                check=True,
                timeout=2700,
            )
        current = client.get("registry", "pvc", "registry-data")
        if (current["metadata"]["uid"], current["spec"]["volumeName"]) != (
            pvc["metadata"]["uid"],
            pvc["spec"]["volumeName"],
        ):
            raise ValueError("Registry claim changed during recovery preparation")
        print(json.dumps({"plan": str(args.plan), "operation": "restore-only"}))
    finally:
        client.command(
            ["-n", "registry", "exec", pod, "-c", CONTAINER, "--", "rm", "-rf", prefix]
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context")
    parser.add_argument("--root", default="/var/lib/registry/docker/registry/v2")
    parser.add_argument("--batch")
    parser.add_argument("--pvc-uid")
    parser.add_argument("--pv")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--seconds", type=int, default=180)
    args = parser.parse_args()
    if args.context:
        if not args.plan:
            parser.error("Operator recovery requires --plan")
        signal.signal(
            signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt())
        )
        operator(args)
    else:
        signal.alarm(2700 if args.prepare else args.seconds)
        store = cleanup.Store(args.root)
        result = (
            prepare(store, args.batch, args.pvc_uid, args.pv)
            if args.prepare
            else restore(
                store,
                json.loads(args.plan.read_text()),
                lambda: cleanup.require_read_only(
                    "http://registry.registry.svc.cluster.local"
                ),
                args.seconds,
            )
        )
        print(json.dumps(result))


if __name__ == "__main__":
    main()
