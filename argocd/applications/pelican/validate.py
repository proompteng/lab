"""Render and validate the embedded cloud-init and cross-component wiring."""

import json
from pathlib import Path
import subprocess


def yaml_documents(content: str) -> list[dict]:
    result = subprocess.run(
        ["yq", "-o=json", "-I=0", "."],
        input=content,
        text=True,
        capture_output=True,
        check=True,
    )
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def main() -> None:
    root = Path(__file__).resolve().parent
    rendered = subprocess.run(
        ["kubectl", "kustomize", str(root)], text=True, capture_output=True, check=True
    ).stdout
    resources = yaml_documents(rendered)
    assert all(item["kind"] != "Namespace" for item in resources)
    assert all(item["metadata"]["namespace"] == "pelican" for item in resources)

    def resource(kind: str, name: str) -> dict:
        return next(
            item
            for item in resources
            if item["kind"] == kind and item["metadata"]["name"] == name
        )

    secret = resource("ExternalSecret", "pelican-bootstrap")["spec"]
    assert secret["refreshPolicy"] == "CreatedOnce"
    assert secret["target"]["creationPolicy"] == "Orphan"
    cloud = yaml_documents(secret["target"]["template"]["data"]["userdata"])[0]
    assert cloud["ssh_pwauth"] is False and cloud["disable_root"] is True
    files = {item["path"]: item for item in cloud["write_files"]}
    wings = yaml_documents(files["/etc/pelican/config.yml"]["content"])[0]
    config = resource("ConfigMap", "pelican-config")["data"]
    assert wings["uuid"] == config["WINGS_NODE_UUID"]
    assert wings["token_id"] == config["WINGS_TOKEN_ID"]
    assert len(wings["token_id"]) == 16
    assert wings["token"] == "{{ .wings_token }}"
    subprocess.run(
        ["bash", "-n"],
        input=files["/usr/local/sbin/install-pelican-wings"]["content"],
        text=True,
        check=True,
    )
    deployment = resource("Deployment", "pelican")["spec"]
    assert deployment["replicas"] == 1 and deployment["strategy"]["type"] == "Recreate"
    pod = deployment["template"]["spec"]
    assert pod["automountServiceAccountToken"] is False
    assert pod["securityContext"]["runAsNonRoot"] is True
    for container in pod["containers"] + pod["initContainers"]:
        assert "@sha256:" in container["image"]
        assert container["securityContext"]["allowPrivilegeEscalation"] is False
    subprocess.run(
        ["sh", "-n"], input=pod["initContainers"][0]["args"][0], text=True, check=True
    )
    assert all(item["name"] != "ADMIN_PASSWORD" for item in pod["containers"][0]["env"])
    assert resource("Service", "pelican-games")["spec"]["loadBalancerClass"] == "tailscale"
    print(f"PASS: {len(resources)} resources; cloud-init/shell, credential parity, persistence and isolation.")


if __name__ == "__main__":
    main()
