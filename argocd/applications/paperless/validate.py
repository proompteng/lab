"""Check the Paperless and Flamingo GitOps contract before rollout."""

import json
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def yamls(text: str) -> list[dict]:
    result = subprocess.run(
        ["yq", "-o=json", "-I=0", "."],
        input=text,
        capture_output=True,
        text=True,
        check=True,
    )
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def main() -> None:
    root = Path(__file__).resolve().parent
    rendered = subprocess.run(
        ["kubectl", "kustomize", str(root)], capture_output=True, text=True, check=True
    ).stdout
    items = yamls(rendered)
    assert all(item["kind"] != "Namespace" for item in items)
    assert all(item["metadata"]["namespace"] == "paperless" for item in items)

    def resource(kind: str, name: str) -> dict:
        return next(
            item
            for item in items
            if item["kind"] == kind and item["metadata"]["name"] == name
        )

    config = resource("ConfigMap", "paperless-config")["data"]
    assert config["PAPERLESS_AI_ENABLED"] == "true"
    assert config["PAPERLESS_AI_LLM_BACKEND"] == "openai-like"
    assert (
        config["PAPERLESS_AI_LLM_ENDPOINT"]
        == "http://flamingo.flamingo.svc.cluster.local/v1"
    )
    assert config["PAPERLESS_AI_LLM_MODEL"] == "qwen38-flamingo"
    assert config["PAPERLESS_AI_LLM_EMBEDDING_BACKEND"] == "huggingface"
    assert config["PAPERLESS_DBENGINE"] == "postgresql"
    assert config["PAPERLESS_PORT"] == "8000"
    assert config["PAPERLESS_TIKA_ENABLED"] == "true"
    assert "paperless.paperless.svc.cluster.local" in config[
        "PAPERLESS_ALLOWED_HOSTS"
    ].split(",")

    secret = resource("ExternalSecret", "paperless-runtime")["spec"]
    assert secret["refreshPolicy"] == "CreatedOnce"
    assert secret["target"]["creationPolicy"] == "Orphan"
    assert secret["target"]["deletionPolicy"] == "Retain"
    assert len(secret["dataFrom"]) == 3
    assert (
        len(
            {
                source["sourceRef"]["generatorRef"]["name"]
                for source in secret["dataFrom"]
            }
        )
        == 3
    )

    deployment = resource("Deployment", "paperless")["spec"]
    assert deployment["replicas"] == 1
    assert deployment["strategy"]["type"] == "Recreate"
    assert (
        deployment["template"]["metadata"]["annotations"][
            "paperless.proompteng.ai/allowed-hosts"
        ]
        == config["PAPERLESS_ALLOWED_HOSTS"]
    ), "Host changes must roll the envFrom consumer"
    pod = deployment["template"]["spec"]
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["automountServiceAccountToken"] is False
    assert pod["enableServiceLinks"] is False
    container = pod["containers"][0]
    assert container["securityContext"]["allowPrivilegeEscalation"] is False
    assert "@sha256:" in container["image"]
    host = urlparse(config["PAPERLESS_URL"]).hostname
    for probe in ("startupProbe", "readinessProbe"):
        assert {"name": "Host", "value": host} in container[probe]["httpGet"].get(
            "httpHeaders", []
        ), f"{probe} must send the configured Paperless host"
    assert "PAPERLESS_SECRET_KEY" not in config
    for name in ("PAPERLESS_SECRET_KEY", "PAPERLESS_ADMIN_PASSWORD", "PAPERLESS_REDIS"):
        assert (
            next(item for item in container["env"] if item["name"] == name)[
                "valueFrom"
            ]["secretKeyRef"]["name"]
            == "paperless-runtime"
        )

    for name, size in (
        ("paperless-media", "100Gi"),
        ("paperless-data", "10Gi"),
        ("paperless-consume", "5Gi"),
    ):
        pvc = resource("PersistentVolumeClaim", name)
        assert pvc["spec"]["storageClassName"] == "rook-ceph-block"
        assert pvc["spec"]["resources"]["requests"]["storage"] == size
        assert (
            "Prune=false,Delete=false"
            in pvc["metadata"]["annotations"]["argocd.argoproj.io/sync-options"]
        )

    postgres = resource("Cluster", "paperless-db")["spec"]
    assert postgres["instances"] == 2
    assert postgres["backup"]["volumeSnapshot"]["className"] == "rook-ceph-block"
    backup = resource("ScheduledBackup", "paperless-db-daily")["spec"]
    assert backup["method"] == "volumeSnapshot"
    assert backup["cluster"]["name"] == "paperless-db"
    retention = resource("CronJob", "paperless-backup-retention")["spec"]
    assert retention["schedule"] == "30 11 * * *"
    assert (
        retention["jobTemplate"]["spec"]["template"]["spec"]["serviceAccountName"]
        == "paperless-backup-maintainer"
    )
    assert resource("Role", "paperless-backup-maintainer")["rules"] == [
        {
            "apiGroups": ["postgresql.cnpg.io"],
            "resources": ["backups"],
            "verbs": ["get", "list", "delete"],
        }
    ]
    assert (
        "@sha256:"
        in resource("StatefulSet", "paperless-valkey")["spec"]["template"]["spec"][
            "containers"
        ][0]["image"]
    )
    assert resource("Ingress", "paperless")["spec"]["ingressClassName"] == "tailscale"
    assert resource("NetworkPolicy", "paperless-private-ingress")["spec"][
        "policyTypes"
    ] == ["Ingress"]
    sources = resource("NetworkPolicy", "paperless-private-ingress")["spec"]["ingress"][
        0
    ]["from"]
    assert {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "agents"}},
        "podSelector": {
            "matchLabels": {
                "app.kubernetes.io/name": "agents-shell",
                "app.kubernetes.io/component": "agents-shell",
            }
        },
    } in sources
    token = resource("ExternalSecret", "paperless-agent-api")["spec"]
    assert token["refreshPolicy"] == "CreatedOnce"
    assert token["target"]["creationPolicy"] == "Orphan"
    assert token["target"]["deletionPolicy"] == "Retain"
    assert resource("Password", "paperless-agent-token")["spec"]["length"] == 40
    assert resource("Role", "paperless-agent-token-reader")["rules"] == [
        {
            "apiGroups": [""],
            "resources": ["secrets"],
            "resourceNames": ["paperless-agent-api"],
            "verbs": ["get"],
        }
    ]
    assert resource("RoleBinding", "paperless-agent-token-reader")["subjects"] == [
        {
            "kind": "ServiceAccount",
            "name": "paperless-agent-token-reader",
            "namespace": "agents",
        }
    ]
    bootstrap = resource("Job", "paperless-agent-bootstrap")
    assert bootstrap["metadata"]["annotations"]["argocd.argoproj.io/hook"] == "PostSync"
    bootstrap_pod = bootstrap["spec"]["template"]["spec"]
    assert bootstrap_pod["automountServiceAccountToken"] is False
    assert bootstrap_pod["securityContext"]["runAsNonRoot"] is True
    assert bootstrap_pod["containers"][0]["image"] == container["image"]
    for name in ("paperless-tika", "paperless-gotenberg"):
        converter = resource("Deployment", name)["spec"]["template"]["spec"]
        assert "@sha256:" in converter["containers"][0]["image"]
        if name == "paperless-gotenberg":
            assert converter["securityContext"]["runAsUser"] == 1001

    print(
        f"PASS: {len(items)} resources; Flamingo, secrets, RBD, backup, ingress, and rootless pod"
    )


if __name__ == "__main__":
    main()
