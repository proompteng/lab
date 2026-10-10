#!/usr/bin/env python3
"""Exercise the final policy on disposable SpiceDB; never use a production key."""

import hashlib
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ENDPOINT = sys.argv[1]
assert ENDPOINT.startswith("http://127.0.0.1:"), "fixture must bind loopback"
WORKSPACE = "860649d5-e760-4b3e-8d51-a07b3b7bd86f"
OTHER_WORKSPACE = "54279e9b-73f3-41d7-ac03-4a99c6f0986b"
NAMESPACE = "galactic/1659ee4e-e176-442c-b48f-fb1cce61d51d"
CONNECTION = "c540d8cb-716b-43eb-ae2b-7c574d945fcd"
GRANT = "0a94f080-d2f2-4b99-bede-387e97bb7d0c"
AGENT = "8672e3c8-bdca-4437-97c5-957473f66852"
ROLES = [
    "owner",
    "developer",
    "viewer",
    "administrator",
    "auditor",
    "operator",
    "outsider",
    "emergency",
]
HUMANS = {
    role: hashlib.sha256(f"github:{index + 1}".encode()).hexdigest()
    for index, role in enumerate(ROLES)
}
CHECKS = 0


def api(path, body, token="ofz-policy-fixture"):
    request = Request(
        ENDPOINT + path,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=2) as response:
        return json.load(response)


def obj(kind, value):
    return {"objectType": kind, "objectId": value}


def relationship(kind, resource, relation, subject_kind, subject, expires=None):
    result = {
        "resource": obj(kind, resource),
        "relation": relation,
        "subject": {"object": obj(subject_kind, subject)},
    }
    if expires:
        result["optionalExpiresAt"] = expires.isoformat().replace("+00:00", "Z")
    return result


def write(*relationships):
    return api(
        "/v1/relationships/write",
        {
            "updates": [
                {"operation": "OPERATION_TOUCH", "relationship": rel}
                for rel in relationships
            ]
        },
    )


def check(kind, resource, permission, subject, expected, subject_kind="human"):
    global CHECKS
    result = api(
        "/v1/permissions/check",
        {
            "consistency": {"fullyConsistent": True},
            "resource": obj(kind, resource),
            "permission": permission,
            "subject": {"object": obj(subject_kind, subject)},
        },
    )
    allowed = result["permissionship"] == "PERMISSIONSHIP_HAS_PERMISSION"
    assert allowed == expected, (kind, resource, permission, subject, result)
    CHECKS += 1


def delete(kind, resource, relation, subject_kind, subject):
    api(
        "/v1/relationships/delete",
        {
            "relationshipFilter": {
                "resourceType": kind,
                "optionalResourceId": resource,
                "optionalRelation": relation,
                "optionalSubjectFilter": {
                    "subjectType": subject_kind,
                    "optionalSubjectId": subject,
                },
            }
        },
    )


def delegated(expected, workspace=WORKSPACE, issuer=None):
    global CHECKS
    issuer = issuer or HUMANS["owner"]
    result = api(
        "/v1/permissions/checkbulk",
        {
            "consistency": {"fullyConsistent": True},
            "items": [
                {
                    "resource": obj("agent_grant", GRANT),
                    "permission": "use",
                    "subject": {"object": obj("agent", AGENT)},
                },
                {
                    "resource": obj("agent_grant", GRANT),
                    "permission": "issuer",
                    "subject": {"object": obj("human", issuer)},
                },
                {
                    "resource": obj("agent_grant", GRANT),
                    "permission": "workspace",
                    "subject": {"object": obj("workspace", workspace)},
                },
                {
                    "resource": obj("workspace", workspace),
                    "permission": "manage_grants",
                    "subject": {"object": obj("human", issuer)},
                },
                {
                    "resource": obj("workspace", workspace),
                    "permission": "observe_files",
                    "subject": {"object": obj("human", issuer)},
                },
            ],
        },
    )
    assert len(result["pairs"]) == 5, result
    allowed = all(
        pair.get("item", {}).get("permissionship") == "PERMISSIONSHIP_HAS_PERMISSION"
        for pair in result["pairs"]
    )
    assert allowed == expected, result
    assert result["checkedAt"]["token"], result
    CHECKS += 1


def main():
    schema = (Path(__file__).resolve().parents[1] / "schema.zed").read_text()
    api("/v1/schema/write", {"schema": schema})
    relationships = [
        relationship("platform", "lab", "member", "human", HUMANS[role])
        for role in ROLES
        if role != "outsider"
    ]
    relationships += [
        relationship("platform", "lab", role, "human", HUMANS[role])
        for role in ["administrator", "auditor", "operator"]
    ]
    relationships += [
        relationship("workspace", uid, "platform", "platform", "lab")
        for uid in [WORKSPACE, OTHER_WORKSPACE]
    ]
    relationships += [
        relationship("workspace", WORKSPACE, role, "human", HUMANS[role])
        for role in ["owner", "developer", "viewer"]
    ]
    relationships += [
        relationship("kube_namespace", NAMESPACE, "platform", "platform", "lab"),
        relationship("connector_connection", CONNECTION, "platform", "platform", "lab"),
    ]
    write(*relationships)
    observation = [
        "view_metadata",
        "observe_files",
        "observe_terminal",
        "observe_codex",
        "observe_browser",
        "observe_preview",
    ]
    control = [
        "control_guest",
        "write_files",
        "control_terminal",
        "control_codex",
        "control_browser",
        "open_editor",
        "access_preview",
        "resume",
        "sleep",
        "configure_power",
    ]
    administration = [
        "delete",
        "manage_collaborators",
        "read_access",
        "manage_grants",
        "transfer",
    ]
    for role in ROLES:
        for permission in observation + control + administration:
            expected = (
                role == "owner"
                or (role == "developer" and permission not in administration)
                or (role == "viewer" and permission in observation)
            )
            check("workspace", WORKSPACE, permission, HUMANS[role], expected)
            check("workspace", OTHER_WORKSPACE, permission, HUMANS[role], False)
        # Ownership is unrelated to namespace or connector authority.
        for permission in ["read_status", "read_logs", "read_events"]:
            check("kube_namespace", NAMESPACE, permission, HUMANS[role], False)
        check("connector_connection", CONNECTION, "read", HUMANS[role], False)
    platform_permissions = [
        ("admit", set(ROLES) - {"outsider"}),
        ("create_workspace", set(ROLES) - {"outsider"}),
        ("manage_members", {"administrator"}),
        ("manage_quotas", {"administrator"}),
        ("manage_targets", {"administrator"}),
        ("read_policy", {"administrator", "auditor"}),
        ("read_audit", {"administrator", "auditor"}),
        ("operate", {"administrator", "operator"}),
    ]
    for role in ROLES:
        for permission, permitted in platform_permissions:
            check("platform", "lab", permission, HUMANS[role], role in permitted)
        if role != "outsider":
            delete("platform", "lab", "member", "human", HUMANS[role])
            for permission, _ in platform_permissions:
                check("platform", "lab", permission, HUMANS[role], False)
            write(relationship("platform", "lab", "member", "human", HUMANS[role]))
    workloads = {
        role: hashlib.sha256(
            f"spiffe://proompteng.ai/ns/{namespace}/sa/{account}".encode()
        ).hexdigest()
        for role, namespace, account in [
            ("bff", "proompteng", "proompteng"),
            ("controller", "tengri", "tengri"),
            ("kube_broker", "tengri", "tengri-kube-broker"),
            ("connector_broker", "tengri", "tengri-connector-broker"),
            ("ofz", "ofz", "ofz-api"),
            ("guest", "tengri", "nanoagent"),
        ]
    }
    write(
        *(
            relationship("platform", "lab", role, "workload", workloads[role])
            for role in ["bff", "controller", "kube_broker", "connector_broker"]
        )
    )
    for role, subject in workloads.items():
        for permission, permitted in [
            ("establish_session", {"bff"}),
            ("enroll_workspace", {"controller"}),
            ("execute_kube", {"kube_broker"}),
            ("execute_connector", {"connector_broker"}),
            ("check", {"bff", "controller", "kube_broker", "connector_broker"}),
            ("command", {"bff", "controller"}),
            ("inspect_session", {"bff", "controller"}),
            ("revoke_session", {"bff"}),
        ]:
            check("platform", "lab", permission, subject, role in permitted, "workload")
        for permission in ["view_metadata", "write_files"]:
            check("workspace", WORKSPACE, permission, subject, False, "workload")
    write(
        relationship(
            "kube_namespace", NAMESPACE, "status_reader", "human", HUMANS["viewer"]
        )
    )
    check("kube_namespace", NAMESPACE, "read_status", HUMANS["viewer"], True)
    check("kube_namespace", NAMESPACE, "read_logs", HUMANS["viewer"], False)
    write(
        relationship(
            "connector_connection", CONNECTION, "reader", "human", HUMANS["viewer"]
        )
    )
    check("connector_connection", CONNECTION, "read", HUMANS["viewer"], True)
    expires = datetime.now(timezone.utc) + timedelta(seconds=60)
    write(
        relationship("agent_grant", GRANT, "subject", "agent", AGENT, expires),
        relationship("agent_grant", GRANT, "issuer", "human", HUMANS["owner"]),
        relationship("agent_grant", GRANT, "workspace", "workspace", WORKSPACE),
    )
    stored = api(
        "/v1/relationships/read",
        {
            "consistency": {"fullyConsistent": True},
            "relationshipFilter": {
                "resourceType": "agent_grant",
                "optionalResourceId": GRANT,
                "optionalRelation": "subject",
            },
        },
    )["result"]["relationship"]
    assert stored["optionalExpiresAt"] == expires.isoformat().replace("+00:00", "Z"), (
        stored
    )
    delegated(True)
    # The same issuer can own another workspace; it still cannot replay this grant there.
    write(relationship("workspace", OTHER_WORKSPACE, "owner", "human", HUMANS["owner"]))
    delegated(False, workspace=OTHER_WORKSPACE)
    # An unrelated Owner with the same permission cannot substitute for the recorded issuer.
    write(relationship("workspace", WORKSPACE, "owner", "human", HUMANS["developer"]))
    delegated(False, issuer=HUMANS["developer"])
    delete("workspace", WORKSPACE, "owner", "human", HUMANS["developer"])
    for relation, kind, subject in [
        ("issuer", "human", HUMANS["owner"]),
        ("workspace", "workspace", WORKSPACE),
    ]:
        delete("agent_grant", GRANT, relation, kind, subject)
        delegated(False)
        write(relationship("agent_grant", GRANT, relation, kind, subject))
        delegated(True)
    delete("workspace", WORKSPACE, "owner", "human", HUMANS["owner"])
    delegated(False)
    write(relationship("workspace", WORKSPACE, "owner", "human", HUMANS["owner"]))
    delegated(True)
    delete("platform", "lab", "member", "human", HUMANS["owner"])
    delegated(False)
    for permission in observation + control + administration:
        check("workspace", WORKSPACE, permission, HUMANS["owner"], False)
    write(relationship("platform", "lab", "member", "human", HUMANS["owner"]))
    expires = datetime.now(timezone.utc) + timedelta(seconds=1)
    write(
        relationship("agent_grant", GRANT, "subject", "agent", AGENT, expires),
        relationship(
            "workspace", WORKSPACE, "emergency", "human", HUMANS["emergency"], expires
        ),
    )
    delegated(True)
    check("workspace", WORKSPACE, "control_guest", HUMANS["emergency"], True)
    check("workspace", WORKSPACE, "manage_collaborators", HUMANS["emergency"], False)
    time.sleep(1.1)
    delegated(False)
    check("workspace", WORKSPACE, "control_guest", HUMANS["emergency"], False)
    try:
        api("/v1/schema/read", {}, token="invalid")
    except HTTPError as error:
        assert error.code in (401, 403), error.code
    else:
        raise AssertionError("invalid native credential accepted")
    print(
        json.dumps(
            {
                "result": "PASS",
                "permission_assertions": CHECKS,
                "schema_sha256": hashlib.sha256(schema.encode()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    main()
