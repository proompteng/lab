"""Pin selected Ubuntu package URLs to the archive's SHA-256 metadata."""

import pathlib
import shlex
import sys
import urllib.parse


packages = {}
for stanza in pathlib.Path(sys.argv[2]).read_text().split("\n\n"):
    fields = dict(
        line.split(": ", 1)
        for line in stanza.splitlines()
        if not line.startswith(" ") and ": " in line
    )
    if "Filename" in fields and "SHA256" in fields:
        packages[fields["Filename"]] = fields["SHA256"]

count = 0
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line.startswith("'http"):
        continue
    uri = urllib.parse.urlsplit(shlex.split(line)[0])
    assert uri.hostname in {
        "archive.ubuntu.com",
        "security.ubuntu.com",
        "ports.ubuntu.com",
    }, f"Unexpected package host: {uri.hostname}"
    filename = "pool/" + urllib.parse.unquote(uri.path).split("/pool/", 1)[1]
    digest = packages[filename]
    assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
    print(urllib.parse.urlunsplit(uri._replace(scheme="https")), "SHA256:" + digest)
    count += 1
assert count > 0, "No browser runtime packages selected"
