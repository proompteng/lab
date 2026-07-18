#!/usr/bin/env python3
"""Fail closed on rendered Torghut JupyterHub production contracts."""

from __future__ import annotations

import argparse
import base64
import re
from pathlib import Path
from typing import cast

import yaml

YamlObject = dict[str, object]


def _as_mapping(value: object, label: str) -> YamlObject:
    if not isinstance(value, dict):
        raise AssertionError(f"{label} must be an object")
    raw = cast(dict[object, object], value)
    if any(not isinstance(key, str) for key in raw):
        raise AssertionError(f"{label} must use string keys")
    return {cast(str, key): item for key, item in raw.items()}


def _as_list(value: object, label: str) -> list[object]:
    if not isinstance(value, list):
        raise AssertionError(f"{label} must be a list")
    return cast(list[object], value)


def _at(mapping: YamlObject, *path: str) -> object:
    current: object = mapping
    traversed: list[str] = []
    for key in path:
        traversed.append(key)
        parent = _as_mapping(current, ".".join(traversed[:-1]) or "document")
        if key not in parent:
            raise AssertionError(f"missing required field {'.'.join(traversed)}")
        current = parent[key]
    return current


def _optional_at(mapping: YamlObject, *path: str) -> object | None:
    current: object = mapping
    for key in path:
        if not isinstance(current, dict):
            return None
        parent = cast(dict[object, object], current)
        if key not in parent:
            return None
        current = parent[key]
    return current


def _mapping_at(mapping: YamlObject, *path: str) -> YamlObject:
    return _as_mapping(_at(mapping, *path), ".".join(path))


def _list_at(mapping: YamlObject, *path: str) -> list[object]:
    return _as_list(_at(mapping, *path), ".".join(path))


def _string_at(mapping: YamlObject, *path: str) -> str:
    value = _at(mapping, *path)
    if not isinstance(value, str):
        raise AssertionError(f"{'.'.join(path)} must be a string")
    return value


def _documents(path: Path) -> list[YamlObject]:
    documents: list[YamlObject] = []
    for index, item in enumerate(yaml.safe_load_all(path.read_text())):
        loaded: object = item
        if loaded is not None:
            documents.append(_as_mapping(loaded, f"document {index}"))
    return documents


def _metadata_name(document: YamlObject) -> str:
    name = _at(document, "metadata", "name")
    return name if isinstance(name, str) else ""


def _find(documents: list[YamlObject], kind: str, name: str) -> YamlObject:
    matches = [
        document
        for document in documents
        if document.get("kind") == kind and _metadata_name(document) == name
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"expected exactly one {kind}/{name}, found {len(matches)}"
        )
    return matches[0]


def _container(deployment: YamlObject, name: str) -> YamlObject:
    candidates = [
        _as_mapping(item, f"container {index}")
        for index, item in enumerate(
            _list_at(deployment, "spec", "template", "spec", "containers")
        )
    ]
    matches = [item for item in candidates if item.get("name") == name]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one container {name}")
    return matches[0]


def _env(container: YamlObject, name: str) -> YamlObject:
    candidates = [
        _as_mapping(item, f"environment item {index}")
        for index, item in enumerate(_list_at(container, "env"))
    ]
    matches = [item for item in candidates if item.get("name") == name]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one env {name}, found {len(matches)}")
    return matches[0]


def _secret_ref(container: YamlObject, env_name: str) -> YamlObject:
    return _mapping_at(_env(container, env_name), "valueFrom", "secretKeyRef")


def _validate_hub_and_proxy(documents: list[YamlObject]) -> None:
    hub = _container(_find(documents, "Deployment", "torghut-notebooks-hub"), "hub")
    proxy = _container(_find(documents, "Deployment", "torghut-notebooks-proxy"), "chp")
    assert hub["image"] == "quay.io/jupyterhub/k8s-hub:4.4.0"
    assert proxy["image"] == "quay.io/jupyterhub/configurable-http-proxy:5.2.0"
    assert hub["resources"] == {
        "requests": {"cpu": "250m", "memory": "512Mi"},
        "limits": {"cpu": "1", "memory": "2Gi"},
    }
    assert proxy["resources"] == {
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits": {"cpu": "500m", "memory": "512Mi"},
    }
    for container in (hub, proxy):
        assert _secret_ref(container, "CONFIGPROXY_AUTH_TOKEN") == {
            "name": "torghut-notebook-hub",
            "key": "proxy-token",
        }
    assert _secret_ref(hub, "TORGHUT_HUB_COOKIE_SECRET") == {
        "name": "torghut-notebook-hub",
        "key": "cookie-secret",
    }
    assert _secret_ref(hub, "TORGHUT_HUB_CRYPT_KEY") == {
        "name": "torghut-notebook-hub",
        "key": "crypt-key",
    }


def _validate_network_exposure(documents: list[YamlObject]) -> None:
    proxy = _find(documents, "Service", "torghut-notebooks-proxy-public")
    assert _at(proxy, "spec", "type") == "ClusterIP"
    assert not any(
        document.get("kind") == "Service"
        and _optional_at(document, "spec", "type") == "LoadBalancer"
        for document in documents
    )
    ingress = _find(documents, "Ingress", "torghut-notebooks")
    assert _at(ingress, "spec", "ingressClassName") == "tailscale"
    assert (
        _at(ingress, "metadata", "annotations", "tailscale.com/tags")
        == "tag:torghut-notebooks"
    )
    rules = [
        _as_mapping(item, f"ingress rule {index}")
        for index, item in enumerate(_list_at(ingress, "spec", "rules"))
    ]
    assert [_string_at(rule, "host") for rule in rules] == [
        "torghut-notebooks.ide-newton.ts.net"
    ]
    assert _at(ingress, "spec", "tls") == [
        {"hosts": ["torghut-notebooks.ide-newton.ts.net"]}
    ]


def _validate_hub_storage(documents: list[YamlObject]) -> None:
    hub_pvc = _find(documents, "PersistentVolumeClaim", "torghut-notebooks-hub-db-dir")
    assert _at(hub_pvc, "spec", "resources", "requests", "storage") == "1Gi"
    assert _at(hub_pvc, "spec", "storageClassName") == "rook-ceph-block"


def _chart_values(documents: list[YamlObject]) -> YamlObject:
    secret = _find(documents, "Secret", "torghut-notebooks-hub")
    encoded = _string_at(secret, "data", "values.yaml")
    loaded: object = yaml.safe_load(base64.b64decode(encoded))
    return _as_mapping(loaded, "embedded Helm values")


def _validate_hub_values(values: YamlObject) -> None:
    hub = _mapping_at(values, "hub")
    assert hub["activeServerLimit"] == 1
    assert hub["concurrentSpawnLimit"] == 1
    assert hub["allowNamedServers"] is False
    assert _at(hub, "config", "JupyterHub", "admin_access") is False
    extra_config = _string_at(hub, "extraConfig", "00-torghut-single-operator")
    for required in (
        'return {"name": "torghut", "admin": False}',
        "authenticate(self, handler, data=None)",
        "auto_login = True",
        "bytes.fromhex(cookie_secret)",
        "c.CryptKeeper.keys = [crypt_key]",
    ):
        assert required in extra_config
    assert all(
        term not in extra_config
        for term in ("Keycloak", "OAuth", "password", "REMOTE_USER", "identity")
    )


def _validate_singleuser_values(values: YamlObject) -> None:
    singleuser = _mapping_at(values, "singleuser")
    assert _at(singleuser, "image", "name") == (
        "registry.ide-newton.ts.net/lab/torghut-notebook@sha256"
    )
    assert re.fullmatch(r"[0-9a-f]{64}", str(_at(singleuser, "image", "tag")))
    assert singleuser["cpu"] == {"guarantee": 2, "limit": 8}
    assert singleuser["memory"] == {"guarantee": "8G", "limit": "16G"}
    assert _at(singleuser, "storage", "capacity") == "50Gi"
    assert _at(singleuser, "storage", "dynamic", "storageClass") == "rook-ceph-block"
    assert _at(singleuser, "extraPodConfig", "automountServiceAccountToken") is False
    assert _at(singleuser, "cloudMetadata", "blockWithIptables") is False
    extra_env = _mapping_at(singleuser, "extraEnv")
    assert extra_env["TORGHUT_NOTEBOOK_DATA_MODE"] == "live"
    assert extra_env["PGOPTIONS"] == (
        "-c default_transaction_read_only=on -c statement_timeout=30000"
    )
    assert _string_at(extra_env, "TORGHUT_STATUS_URL").endswith("/trading/status")
    forbidden_env = {
        "APCA_API_KEY_ID",
        "APCA_API_SECRET_KEY",
        "KAFKA_BOOTSTRAP_SERVERS",
        "TIGERBEETLE_CLUSTER_ID",
        "KUBECONFIG",
    }
    assert forbidden_env.isdisjoint(extra_env)


def _resource_names(documents: list[YamlObject], kind: str) -> set[str]:
    return {
        _metadata_name(document)
        for document in documents
        if document.get("kind") == kind
    }


def _validate_scheduling_values(
    values: YamlObject, documents: list[YamlObject]
) -> None:
    assert _at(values, "scheduling", "userScheduler", "enabled") is False
    assert _at(values, "scheduling", "userPlaceholder", "enabled") is False
    assert _at(values, "prePuller", "continuous", "enabled") is False
    assert _at(values, "cull", "timeout") == 14400
    assert _at(values, "cull", "adminUsers") is False
    names = {_metadata_name(document) for document in documents}
    assert not any(
        "user-scheduler" in name or "continuous-image-puller" in name for name in names
    )
    assert "torghut-notebooks-singleuser" in _resource_names(documents, "NetworkPolicy")


def _validate_sealed_secrets(documents: list[YamlObject]) -> None:
    assert _resource_names(documents, "SealedSecret") == {
        "torghut-notebook-hub",
        "torghut-notebook-postgres",
        "torghut-notebook-clickhouse",
    }


def validate(rendered_path: Path) -> None:
    documents = _documents(rendered_path)
    if any(document.get("kind") == "Namespace" for document in documents):
        raise AssertionError("Torghut notebook render must not contain Namespace")
    _validate_hub_and_proxy(documents)
    _validate_network_exposure(documents)
    _validate_hub_storage(documents)
    values = _chart_values(documents)
    _validate_hub_values(values)
    _validate_singleuser_values(values)
    _validate_scheduling_values(values, documents)
    _validate_sealed_secrets(documents)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("rendered", type=Path)
    args = parser.parse_args()
    validate(args.rendered)
    print("Torghut notebook render contract is valid")


if __name__ == "__main__":
    main()
