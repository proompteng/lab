"""Verify the checksums in the boot files from a streamed OCI export."""

import hashlib
import sys
import tarfile

boot_files = {"guest/rootfs.ext4", "guest/vmlinux"}
manifest = "guest/SHA256SUMS"
checksums = {}
declared = None
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|", bufsize=1024 * 1024) as archive:
    for member in archive:
        name = member.name.removeprefix("./").removeprefix("/")
        if name not in boot_files and name != manifest:
            continue
        contents = archive.extractfile(member) if member.isfile() else None
        if (
            contents is None
            or name in checksums
            or (name == manifest and declared is not None)
        ):
            sys.exit(f"Invalid boot archive member: {name}")
        with contents:
            if name == manifest:
                if member.size > 1024:
                    sys.exit("Boot checksum manifest is too large")
                declared = contents.read().decode("ascii").splitlines()
            else:
                checksums[name] = hashlib.file_digest(contents, "sha256").hexdigest()

actual = [f"{digest}  /{name}" for name, digest in checksums.items()]
if (
    checksums.keys() != boot_files
    or declared is None
    or sorted(declared) != sorted(actual)
):
    sys.exit("Packed boot files do not match /guest/SHA256SUMS")

for name in sorted(boot_files):
    print(f"/{name}: OK")
