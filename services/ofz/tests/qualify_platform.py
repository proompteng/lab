import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

base = f"http://127.0.0.1:{int(sys.argv[1])}"


def post(path, body):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer ofz-policy-fixture",
            "Content-Type": "application/json",
        },
    )
    return json.load(urllib.request.urlopen(request, timeout=5))


for attempt in range(100):
    try:
        urllib.request.urlopen(base + "/healthz", timeout=1).close()
        break
    except OSError:
        if attempt == 99:
            raise
        time.sleep(0.1)
schema = Path("schema.zed").read_text() + "\n" + Path("platform/schema.zed").read_text()
post("/v1/schema/write", {"schema": schema})
installed = post("/v1/schema/read", {})["schemaText"]
digest = hashlib.sha256(installed.encode()).hexdigest() + "\n"
catalog = json.loads(Path("platform/policies.json").read_text())
resources = {r["kind"]: r["nativeType"] for r in catalog["resources"]}
for index, action in enumerate(catalog["actions"]):
    result = post(
        "/v1/permissions/check",
        {
            "consistency": {"fullyConsistent": True},
            "resource": {
                "objectType": resources[action["resourceKind"]],
                "objectId": "qualification",
            },
            "permission": action["permission"],
            "subject": {"object": {"objectType": "human", "objectId": "qualification"}},
        },
    )
    assert result["permissionship"] == "PERMISSIONSHIP_NO_PERMISSION", action["id"]
    if relation := action.get("grantRelation"):
        target = {
            "objectType": resources[action["resourceKind"]],
            "objectId": f"qualification-{index}",
        }
        subject = {"object": {"objectType": "human", "objectId": "qualification"}}
        post(
            "/v1/relationships/write",
            {
                "updates": [
                    {
                        "operation": "OPERATION_TOUCH",
                        "relationship": {
                            "resource": target,
                            "relation": relation,
                            "subject": subject,
                        },
                    }
                ]
            },
        )
        allowed = post(
            "/v1/permissions/check",
            {
                "consistency": {"fullyConsistent": True},
                "resource": target,
                "permission": action["permission"],
                "subject": subject,
            },
        )
        assert allowed["permissionship"] == "PERMISSIONSHIP_HAS_PERMISSION", action[
            "id"
        ]
        for other in catalog["actions"]:
            if (
                other["resourceKind"] == action["resourceKind"]
                and other["permission"] != action["permission"]
            ):
                denied = post(
                    "/v1/permissions/check",
                    {
                        "consistency": {"fullyConsistent": True},
                        "resource": target,
                        "permission": other["permission"],
                        "subject": subject,
                    },
                )
                assert denied["permissionship"] == "PERMISSIONSHIP_NO_PERMISSION", (
                    action["id"],
                    other["id"],
                )


def relationship(resource_type, resource_id, relation, subject_type, subject_id):
    return {
        "resource": {"objectType": resource_type, "objectId": resource_id},
        "relation": relation,
        "subject": {"object": {"objectType": subject_type, "objectId": subject_id}},
    }


def write(updates):
    post("/v1/relationships/write", {"updates": updates})


def permission(kind, id, action, subject_kind, subject):
    return (
        post(
            "/v1/permissions/check",
            {
                "consistency": {"fullyConsistent": True},
                "resource": {"objectType": kind, "objectId": id},
                "permission": action,
                "subject": {
                    "object": {"objectType": subject_kind, "objectId": subject}
                },
            },
        )["permissionship"]
        == "PERMISSIONSHIP_HAS_PERMISSION"
    )


def touch(*args):
    return {"operation": "OPERATION_TOUCH", "relationship": relationship(*args)}


write(
    [
        touch("platform", "lab", "member", "human", "member"),
        touch("platform", "lab", "member", "human", "other"),
        touch("platform_workspace", "first", "platform", "platform", "lab"),
        touch("platform_workspace", "second", "platform", "platform", "lab"),
        touch("platform_workspace", "first", "member", "human", "member"),
        touch("platform_workspace", "second", "administrator", "human", "other"),
        touch("platform_workspace", "first", "client", "workload", "client"),
        touch(
            "kubernetes_namespace",
            "shared",
            "status_workspace",
            "platform_workspace",
            "first",
        ),
    ]
)
assert permission("platform_workspace", "first", "use", "human", "member")
assert permission("platform_workspace", "first", "use", "workload", "client")
assert not permission("platform_workspace", "second", "use", "human", "member")
assert not permission("platform_workspace", "first", "manage", "human", "member")
assert permission("platform_workspace", "second", "manage", "human", "other")
assert permission("kubernetes_namespace", "shared", "read_status", "human", "member")
assert not permission("kubernetes_namespace", "shared", "read_logs", "human", "member")
assert not permission("kubernetes_namespace", "shared", "read_status", "human", "other")
write(
    [
        {
            "operation": "OPERATION_DELETE",
            "relationship": relationship(
                "platform_workspace", "first", "member", "human", "member"
            ),
        }
    ]
)
assert not permission(
    "kubernetes_namespace", "shared", "read_status", "human", "member"
)
output = Path("platform/schema.sha256")
if sys.argv[2] == "--write":
    output.write_text(digest)
else:
    assert output.read_text() == digest, (
        "qualified schema hash differs; run qualify-platform.sh --write and review the schema"
    )
print(
    "PASS: installed native schema and every onboarded action; sha256=" + digest.strip()
)
