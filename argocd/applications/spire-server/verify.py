#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
from urllib.request import Request, urlopen


JWT_ISSUER = "https://oidc.proompteng.ai"


def verify_public_keys(bundle, discovery, jwks):
    assert discovery["issuer"] == JWT_ISSUER, "unexpected public JWT issuer"
    assert discovery["jwks_uri"] == JWT_ISSUER + "/keys", "unexpected JWKS URI"
    keys = jwks["keys"]
    assert keys, "public JWKS contains no signing keys"
    private_fields = {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}
    for key in keys:
        assert key.get("use") == "sig", "public JWKS contains a non-signing key"
        assert not private_fields.intersection(key), (
            "public JWKS contains private key material"
        )
    fields = {"kid", "kty", "n", "e", "crv", "x", "y"}
    published = [{k: v for k, v in key.items() if k in fields} for key in keys]
    expected = [
        {k: v for k, v in key.items() if k in fields}
        for key in bundle["keys"]
        if key.get("use") == "jwt-svid"
    ]
    assert len({key["kid"] for key in published}) == len(published), (
        "duplicate signing key ID"
    )
    assert sorted(published, key=lambda key: key["kid"]) == sorted(
        expected, key=lambda key: key["kid"]
    ), "public JWKS does not match SPIRE JWT authorities"


def verify_wif(context):
    config = json.loads(
        kubectl(
            context, "spire-server", "get", "configmap", "spire-server", "-o", "json"
        ).stdout
    )
    server = json.loads(config["data"]["server.conf"])["server"]
    assert server["jwt_issuer"] == JWT_ISSUER, "SPIRE JWT issuer differs from discovery"
    assert server["default_jwt_svid_ttl"] == "5m", "unexpected JWT-SVID lifetime"
    documents = []
    for path in ("/.well-known/openid-configuration", "/keys"):
        url = JWT_ISSUER + path
        request = Request(url, headers={"User-Agent": "lab-spire-verifier/1.0"})
        with urlopen(request, timeout=15) as response:
            assert response.geturl() == url, "discovery must not redirect"
            documents.append(json.load(response))
    bundle = json.loads(
        kubectl(
            context, "spire-system", "get", "configmap", "spire-bundle", "-o", "json"
        ).stdout
    )
    verify_public_keys(json.loads(bundle["data"]["bundle.spiffe"]), *documents)
    return {"issuer": JWT_ISSUER, "publicSigningKeys": len(documents[1]["keys"])}


def kubectl(context, namespace, *args, check=True):
    return subprocess.run(
        ["kubectl", "--context", context, "-n", namespace, *args],
        text=True,
        capture_output=True,
        check=check,
        timeout=30,
    )


def verify_ha(context):
    database = json.loads(
        kubectl(
            context, "spire-server", "get", "cluster", "spire-db", "-o", "json"
        ).stdout
    )
    assert database["spec"]["instances"] == 3, "expected three PostgreSQL instances"
    assert database["status"].get("readyInstances") == 3, (
        "PostgreSQL is not fully ready"
    )
    for selector in (
        "app.kubernetes.io/name=server,app.kubernetes.io/instance=spire",
        "cnpg.io/cluster=spire-db",
    ):
        replicas = json.loads(
            kubectl(
                context, "spire-server", "get", "pods", "-l", selector, "-o", "json"
            ).stdout
        )["items"]
        replicas = [
            pod for pod in replicas if not pod["metadata"].get("deletionTimestamp")
        ]
        hosts = {pod["spec"].get("nodeName") for pod in replicas}
        assert len(replicas) == 3 and len(hosts) == 3 and None not in hosts, (
            selector,
            "HA replicas must use three distinct hosts",
        )
    config = json.loads(
        kubectl(
            context, "spire-server", "get", "configmap", "spire-server", "-o", "json"
        ).stdout
    )
    server = json.loads(config["data"]["server.conf"])
    datastore = server["plugins"]["DataStore"][0]["sql"]["plugin_data"]
    assert datastore["database_type"] == "postgres", "SPIRE is not using PostgreSQL"
    assert "sslmode=verify-full" in datastore["connection_string"], (
        "PostgreSQL TLS is not verified"
    )


def verify(context):
    nodes = json.loads(
        kubectl(context, "spire-system", "get", "nodes", "-o", "json").stdout
    )
    architectures = {
        node["metadata"]["name"]: node["status"]["nodeInfo"]["architecture"]
        for node in nodes["items"]
        if node["status"]["nodeInfo"]["operatingSystem"] == "linux"
    }
    assert {"amd64", "arm64"} <= set(architectures.values()), architectures
    for namespace, kind, name in (
        ("spire-server", "statefulset", "spire-server"),
        ("spire-system", "daemonset", "spire-agent"),
        ("spire-system", "daemonset", "spire-spiffe-csi-driver"),
        ("spire-system", "deployment", "spire-spiffe-oidc-discovery-provider"),
    ):
        workload = json.loads(
            kubectl(context, namespace, "get", kind, name, "-o", "json").stdout
        )
        status = workload["status"]
        assert (
            status.get("observedGeneration", 0) >= workload["metadata"]["generation"]
        ), (name, status)
        desired = status.get(
            "desiredNumberScheduled", workload["spec"].get("replicas", 1)
        )
        ready = status.get("numberReady", status.get("readyReplicas", 0))
        assert ready == desired and desired > 0, (name, status)
        if name == "spire-server":
            assert desired == 3, (name, "expected three HA replicas")
            assert status.get("updatedReplicas") == 3, "SPIRE rollout is incomplete"
    verify_ha(context)
    wif = verify_wif(context)
    denied = kubectl(
        context,
        "spire-system",
        "exec",
        "daemonset/spire-agent",
        "-c",
        "spire-agent",
        "--",
        "/opt/spire/bin/spire-agent",
        "api",
        "fetch",
        "x509",
        "-socketPath",
        "/tmp/spire-agent/public/spire-agent.sock",
        check=False,
    )
    assert denied.returncode != 0 and re.search(
        r"no identity|permissiondenied",
        denied.stdout + denied.stderr,
        re.IGNORECASE,
    ), denied.stdout + denied.stderr
    print(
        json.dumps(
            {
                "context": context,
                "nodes": architectures,
                "unregisteredWorkloadDenied": True,
                "workloadIdentityFederation": wif,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", default="galactic-tailscale")
    args = parser.parse_args()
    verify(args.context)
