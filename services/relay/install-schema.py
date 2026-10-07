#!/usr/bin/env python3
"""Install Relay's reviewed schema on an empty Ofz instance; never replace another application's schema."""

import argparse
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request


def normalized(schema):
    return re.sub(
        r"\s+", "", re.sub(r"/\*.*?\*/|//[^\n]*", "", schema, flags=re.DOTALL)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    endpoint = args.endpoint.rstrip("/")
    address = urllib.parse.urlsplit(endpoint)
    if address.scheme != "http" or address.hostname not in {"127.0.0.1", "localhost"}:
        parser.error("use a localhost kubectl port-forward endpoint")
    token = os.environ["OFZ_TEST_TOKEN"]

    def request(path, body):
        req = urllib.request.Request(
            endpoint + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    schema = Path(__file__).with_name("schema.zed").read_text()
    status, current = request("/v1/schema/read", {})
    if status == 200:
        existing = current["schemaText"]
    elif status == 404 and current.get("code") == 5:
        existing = ""
    else:
        raise RuntimeError(f"cannot inspect Ofz schema: HTTP {status}")
    if normalized(existing) == normalized(schema):
        print("Relay schema is already installed")
        return
    if normalized(existing):
        raise RuntimeError(
            "Ofz contains a different schema; refusing to replace it. Review an additive migration."
        )
    if not args.apply:
        print(
            "Ofz has no application schema; reviewed Relay schema can be installed with --apply"
        )
        return
    status, _ = request("/v1/schema/write", {"schema": schema})
    if status != 200:
        raise RuntimeError(f"Relay schema installation failed: HTTP {status}")
    status, installed = request("/v1/schema/read", {})
    if status != 200 or normalized(installed["schemaText"]) != normalized(schema):
        raise RuntimeError("Relay schema readback did not match")
    print("Relay schema installed and verified; no connector grants were created")


if __name__ == "__main__":
    main()
