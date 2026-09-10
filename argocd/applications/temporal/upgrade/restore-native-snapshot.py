"""Restore only a named Cassandra native snapshot into an empty data volume."""

from __future__ import print_function
import glob
import hashlib
import json
import os
import re
import stat
import zlib

STRING_TYPES = (str, type(b"".decode("utf-8")))


def regular_file(path):
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise ValueError("snapshot component must be a regular file: " + path)
    return path


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_component(source, destination):
    before = os.stat(regular_file(source))
    checksum = 0
    digest = hashlib.sha256()
    with open(source, "rb") as reader, open(destination, "wb") as writer:
        while True:
            block = reader.read(1024 * 1024)
            if not block:
                break
            writer.write(block)
            checksum = zlib.crc32(block, checksum)
            digest.update(block)
        writer.flush()
        os.fsync(writer.fileno())
    after = os.stat(source)
    if (before.st_ino, before.st_size, before.st_mtime) != (
        after.st_ino,
        after.st_size,
        after.st_mtime,
    ) or os.path.getsize(destination) != before.st_size:
        raise ValueError("snapshot component changed during restore: " + source)
    return checksum & 0xFFFFFFFF, digest.hexdigest(), before.st_size


def restore(
    source,
    target,
    generation,
    proof,
    expected_temporal_tables=18,
    source_version="3.11.5",
):
    if source_version not in ("3.11.5", "3.11.19", "4.1.12", "5.0.9"):
        raise ValueError("unsupported native snapshot source version")
    relative_manifest = source_version != "3.11.5"
    if not re.match(r"^[0-9]+-v[1-9][0-9]*$", generation):
        raise ValueError("invalid native snapshot generation")
    source = os.path.realpath(source)
    target = os.path.realpath(target)
    if (
        source == target
        or source.startswith(target + os.sep)
        or target.startswith(source + os.sep)
    ):
        raise ValueError("source and destination volumes must be separate")
    destination = os.path.join(target, "data")
    if os.path.lexists(destination):
        raise ValueError("restore requires an empty destination data directory")
    tag = "temporal-before-" + generation
    snapshots = sorted(
        glob.glob(os.path.join(source, "data", "*", "*", "snapshots", tag))
    )
    tables = set()
    plan = []
    for snapshot in snapshots:
        if os.path.realpath(snapshot) != snapshot or not os.path.isdir(snapshot):
            raise ValueError("snapshot directory must not contain symlinks")
        relative = os.path.relpath(snapshot, os.path.join(source, "data")).split(os.sep)
        keyspace, table = relative[:2]
        if not re.match(r"^[a-z][a-z0-9_]*$", keyspace) or not re.match(
            r"^[A-Za-z][A-Za-z0-9_]*-[0-9a-f]{32}$", table
        ):
            raise ValueError("unexpected snapshot keyspace or table identity")
        identity = keyspace + "." + table.rsplit("-", 1)[0]
        if identity in tables:
            raise ValueError("duplicate table identity in native snapshot")
        tables.add(identity)
        with open(regular_file(os.path.join(snapshot, "manifest.json"))) as manifest:
            files = json.load(manifest)["files"]
        filename_pattern = r"^[a-z]{2}-[0-9]+-big-Data\.db$"
        if relative_manifest:
            filename_pattern = (
                r"^(\.[A-Za-z][A-Za-z0-9_]*/)?[a-z]{2}-[0-9]+-big-Data\.db$"
            )
        if not isinstance(files, list) or any(
            not isinstance(name, STRING_TYPES) or not re.match(filename_pattern, name)
            for name in files
        ):
            raise ValueError("invalid SSTable filename in native snapshot manifest")
        if len(files) != len(set(files)):
            raise ValueError("native snapshot manifest must contain unique files")
        groups = [("", snapshot)]
        for name in sorted(os.listdir(snapshot)):
            path = os.path.join(snapshot, name)
            mode = os.lstat(path).st_mode
            if stat.S_ISLNK(mode):
                raise ValueError("snapshot entries must not be symlinks")
            if stat.S_ISDIR(mode):
                if not re.match(r"^\.[A-Za-z][A-Za-z0-9_]*$", name):
                    raise ValueError("unexpected secondary index directory")
                groups.append((name, path))
        manifest_matched = False
        relative_data_files = set()
        for index, folder in groups:
            names = set(os.listdir(folder))
            data_files = sorted(name for name in names if name.endswith("-Data.db"))
            relative_data_files.update(
                (index + "/" if index else "") + name for name in data_files
            )
            # Cassandra 3.11.5 writes each index's manifest to its parent table.
            # Validate that manifest against one complete native group, and retain
            # every base/index SSTable in the immutable named snapshot directory.
            if set(files) == set(data_files):
                manifest_matched = True
            allowed = set()
            if not index:
                allowed.update(["manifest.json", "schema.cql"])
                allowed.update(name for name, _ in groups if name)
            components = []
            for name in data_files:
                if not re.match(r"^[a-z]{2}-[0-9]+-big-Data\.db$", name):
                    raise ValueError("invalid SSTable filename")
                prefix = name[: -len("Data.db")]
                with open(
                    regular_file(os.path.join(folder, prefix + "TOC.txt"))
                ) as toc:
                    suffixes = toc.read().splitlines()
                if len(suffixes) != len(set(suffixes)) or not {
                    "Data.db",
                    "Digest.crc32",
                    "Statistics.db",
                    "Index.db",
                    "TOC.txt",
                }.issubset(suffixes):
                    raise ValueError("native SSTable component list is incomplete")
                for suffix in suffixes:
                    if not re.match(r"^[A-Za-z][A-Za-z0-9]*\.(db|txt|crc32)$", suffix):
                        raise ValueError("invalid SSTable component filename")
                    regular_file(os.path.join(folder, prefix + suffix))
                    allowed.add(prefix + suffix)
                with open(os.path.join(folder, prefix + "Digest.crc32")) as digest:
                    expected = digest.read().strip()
                if not re.match(r"^[0-9]+$", expected) or int(expected) > 0xFFFFFFFF:
                    raise ValueError("invalid native SSTable CRC32 digest")
                components.append((prefix, suffixes, int(expected)))
            if names - allowed:
                raise ValueError("unexpected or orphaned native snapshot component")
            plan.append((folder, keyspace, table, index, components))
        if relative_manifest:
            if set(files) != relative_data_files:
                raise ValueError(
                    "relative manifest does not match all native base and index SSTables"
                )
        elif not manifest_matched:
            raise ValueError("manifest does not match a native table or index group")

    if (
        len([name for name in tables if name.startswith("temporal.")])
        != expected_temporal_tables
    ):
        raise ValueError(
            "native snapshot does not include the expected Temporal tables"
        )
    if not {"system.local", "system_schema.keyspaces", "system_schema.tables"}.issubset(
        tables
    ):
        raise ValueError("native snapshot is missing cluster identity or schema tables")
    os.mkdir(destination)
    total_bytes = 0
    copied = []
    for snapshot, keyspace, table, index, components in plan:
        output = os.path.join(destination, keyspace, table, index)
        os.makedirs(output)
        for prefix, suffixes, expected in components:
            for suffix in suffixes:
                name = prefix + suffix
                checksum, digest, size = copy_component(
                    os.path.join(snapshot, name), os.path.join(output, name)
                )
                if suffix == "Data.db" and checksum != expected:
                    raise ValueError(
                        "native snapshot SSTable checksum mismatch: "
                        + os.path.join(keyspace, table, index, name)
                    )
                copied.append(
                    (os.path.join(keyspace, table, index, name), digest, size)
                )
                total_bytes += size
        sync_directory(output)
        sync_directory(os.path.dirname(output))
    sync_directory(destination)
    sync_directory(target)
    result = {
        "generation": generation,
        "sourceVersion": source_version,
        "tables": len(tables),
        "secondaryIndexes": sum(1 for item in plan if item[3]),
        "components": len(copied),
        "bytes": total_bytes,
        "componentsSHA256": hashlib.sha256(
            json.dumps(sorted(copied), separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
    with open(os.path.join(proof, "native-snapshot-restored.json"), "w") as receipt:
        json.dump(result, receipt, sort_keys=True)
    with open(os.path.join(proof, "native-snapshot-generation"), "w") as marker:
        marker.write(generation + "\n")
    print(
        "PASS: restored generation %s from %d native snapshot tables; %d components, %d bytes; every SSTable CRC32 matched. Live files and commit logs were excluded."
        % (generation, len(tables), len(copied), total_bytes)
    )
    return result


if __name__ == "__main__":
    restore(
        "/snapshot",
        "/var/lib/cassandra",
        os.environ["GENERATION"],
        "/proof",
        source_version=os.environ["EXPECTED_VERSION"],
    )
