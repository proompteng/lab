#!/usr/bin/env python3
"""Exercise a newly provisioned SpiceDB instance and remove the test data."""

import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    args = parser.parse_args()
    endpoint = args.endpoint.rstrip("/")
    address = urllib.parse.urlsplit(endpoint)
    if address.scheme != "http" or address.hostname not in {"127.0.0.1", "localhost"}:
        parser.error("use a localhost kubectl port-forward endpoint")
    token = os.environ["OFZ_TEST_TOKEN"]

    def request(path, body, credential=token):
        headers = {"Content-Type": "application/json"}
        if credential:
            headers["Authorization"] = f"Bearer {credential}"
        req = urllib.request.Request(
            endpoint + path,
            data=json.dumps(body).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def successful(path, body):
        status, result = request(path, body)
        if status != 200:
            raise RuntimeError(f"{path}: HTTP {status}: {result}")
        return result

    for credential in ("", "ofz-invalid-test-token"):
        status, _ = request("/v1/schema/read", {}, credential)
        if status not in {401, 403}:
            raise RuntimeError(f"invalid credential was not rejected: HTTP {status}")

    status, original = request("/v1/schema/read", {})
    if status == 404 and original.get("code") == 5:
        original_schema = ""
    elif status == 200:
        original_schema = original["schemaText"]
    else:
        raise RuntimeError(f"cannot read schema: HTTP {status}: {original}")
    content = re.sub(r"/\*.*?\*/|//[^\n]*", "", original_schema, flags=re.DOTALL)
    if content.strip():
        raise RuntimeError(
            "bootstrap verification requires an empty application schema"
        )

    schema = """definition ofz_smoke_user {}
definition ofz_smoke_document {
    relation viewer: ofz_smoke_user
    permission view = viewer
}
"""
    identifier = uuid.uuid4().hex
    relationship = {
        "resource": {"objectType": "ofz_smoke_document", "objectId": identifier},
        "relation": "viewer",
        "subject": {"object": {"objectType": "ofz_smoke_user", "objectId": identifier}},
    }
    successful("/v1/schema/write", {"schema": schema})
    installed_schema = successful("/v1/schema/read", {})["schemaText"]

    def mutate(operation):
        return successful(
            "/v1/relationships/write",
            {"updates": [{"operation": operation, "relationship": relationship}]},
        )["writtenAt"]

    def check(subject_id, revision, expected):
        result = successful(
            "/v1/permissions/check",
            {
                "consistency": {"atLeastAsFresh": revision},
                "resource": relationship["resource"],
                "permission": "view",
                "subject": {
                    "object": {"objectType": "ofz_smoke_user", "objectId": subject_id}
                },
            },
        )
        if result["permissionship"] != expected:
            raise RuntimeError(f"unexpected permission result: {result}")

    try:
        written = mutate("OPERATION_CREATE")
        check(identifier, written, "PERMISSIONSHIP_HAS_PERMISSION")
        check("unrelated-user", written, "PERMISSIONSHIP_NO_PERMISSION")
        revoked = mutate("OPERATION_DELETE")
        check(identifier, revoked, "PERMISSIONSHIP_NO_PERMISSION")
    finally:
        mutate("OPERATION_DELETE")
        current = successful("/v1/schema/read", {})["schemaText"]
        if current != installed_schema:
            raise RuntimeError(
                "schema changed concurrently; leaving that schema intact"
            )
        successful(
            "/v1/schema/write",
            {"schema": original_schema or "// No application schema installed.\n"},
        )

    print(
        "PASS: schema write/read, relationship write, allow, deny, revision-aware "
        "revocation, invalid credentials, and test-data cleanup"
    )


if __name__ == "__main__":
    main()
