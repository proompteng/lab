from __future__ import annotations

import ast
import base64
import json
import re
import tomllib
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[4]
NOTEBOOKS_DIR = REPO_ROOT / "argocd/applications/torghut/notebooks"


def _secret_env(name: str, key: str) -> dict[str, object]:
    return {
        "name": name,
        "valueFrom": {"secretKeyRef": {"name": "torghut-notebook-hub", "key": key}},
    }


def _representative_render() -> list[dict[str, object]]:
    values_text = (NOTEBOOKS_DIR / "values.yaml").read_text()
    encoded_values = base64.b64encode(values_text.encode()).decode()
    hub_resources = {
        "requests": {"cpu": "250m", "memory": "512Mi"},
        "limits": {"cpu": "1", "memory": "2Gi"},
    }
    proxy_resources = {
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits": {"cpu": "500m", "memory": "512Mi"},
    }
    return [
        {
            "kind": "Deployment",
            "metadata": {"name": "torghut-notebooks-hub"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "hub",
                                "image": "quay.io/jupyterhub/k8s-hub:4.4.0",
                                "resources": hub_resources,
                                "env": [
                                    _secret_env(
                                        "CONFIGPROXY_AUTH_TOKEN", "proxy-token"
                                    ),
                                    _secret_env(
                                        "TORGHUT_HUB_COOKIE_SECRET", "cookie-secret"
                                    ),
                                    _secret_env("TORGHUT_HUB_CRYPT_KEY", "crypt-key"),
                                ],
                            }
                        ]
                    }
                }
            },
        },
        {
            "kind": "Deployment",
            "metadata": {"name": "torghut-notebooks-proxy"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "chp",
                                "image": "quay.io/jupyterhub/configurable-http-proxy:5.2.0",
                                "resources": proxy_resources,
                                "env": [
                                    _secret_env("CONFIGPROXY_AUTH_TOKEN", "proxy-token")
                                ],
                            }
                        ]
                    }
                }
            },
        },
        {
            "kind": "Service",
            "metadata": {"name": "torghut-notebooks-proxy-public"},
            "spec": {"type": "ClusterIP"},
        },
        {
            "kind": "Service",
            "metadata": {"name": "torghut-notebooks-hub"},
            "spec": {},
        },
        {
            "kind": "Ingress",
            "metadata": {
                "name": "torghut-notebooks",
                "annotations": {"tailscale.com/tags": "tag:torghut-notebooks"},
            },
            "spec": {
                "ingressClassName": "tailscale",
                "rules": [{"host": "torghut-notebooks.ide-newton.ts.net"}],
                "tls": [{"hosts": ["torghut-notebooks.ide-newton.ts.net"]}],
            },
        },
        {
            "kind": "PersistentVolumeClaim",
            "metadata": {"name": "torghut-notebooks-hub-db-dir"},
            "spec": {
                "storageClassName": "rook-ceph-block",
                "resources": {"requests": {"storage": "1Gi"}},
            },
        },
        {
            "kind": "Secret",
            "metadata": {"name": "torghut-notebooks-hub"},
            "data": {"values.yaml": encoded_values},
        },
        {
            "kind": "NetworkPolicy",
            "metadata": {"name": "torghut-notebooks-singleuser"},
        },
        *[
            {"kind": "SealedSecret", "metadata": {"name": name}}
            for name in (
                "torghut-notebook-hub",
                "torghut-notebook-postgres",
                "torghut-notebook-clickhouse",
            )
        ],
    ]


def test_notebook_image_uses_a_dedicated_minimal_locked_dependency_group() -> None:
    pyproject_path = REPO_ROOT / "services/torghut/pyproject.toml"
    pyproject = tomllib.loads(pyproject_path.read_text())
    runtime = pyproject["dependency-groups"]["notebook-runtime"]
    for required in (
        "jupyterhub==5.5.0",
        "jupyterlab>=4.3.4,<5.0",
        "numpy>=2.1.2,<3.0",
        "pandas>=2.2.3,<3.0",
        "plotly>=6.0.0,<7.0",
        "psycopg[binary]>=3.2.1,<4.0",
    ):
        assert required in runtime
    runtime_text = "\n".join(runtime).lower()
    for forbidden in ("alpaca", "tigerbeetle", "kafka", "hyperliquid-python-sdk"):
        assert forbidden not in runtime_text
    nix_source = (REPO_ROOT / "nix/images/torghut-notebook.nix").read_text()
    assert "--only-group notebook-runtime" in nix_source
    assert "--no-install-project" in nix_source
    extra_commands = nix_source.split("extraCommands = ''", maxsplit=1)[1].split(
        "'';", maxsplit=1
    )[0]
    fake_root_commands = nix_source.split("fakeRootCommands = ''", maxsplit=1)[1].split(
        "'';", maxsplit=1
    )[0]
    assert "chown" not in extra_commands
    assert "chown 1000:100 ./home/jovyan" in fake_root_commands
    assert (
        'Entrypoint = [ "${startNotebook}/bin/start-torghut-notebook" ];' in nix_source
    )


def test_notebook_entrypoint_seeds_only_absent_canonical_notebooks() -> None:
    source = (
        REPO_ROOT / "services/torghut/scripts/start_torghut_notebook.sh"
    ).read_text()
    assert 'if [[ ! -e "${workspace_dir}/${notebook}" ]]; then' in source
    assert 'cp "${canonical_dir}/${notebook}" "${workspace_dir}/${notebook}"' in source
    assert "cp -f" not in source
    assert "rm " not in source
    assert 'if [[ "$#" -eq 0 ]]; then' in source
    assert "set -- jupyterhub-singleuser" in source
    assert 'exec "$@"' in source
    assert 'exec jupyterhub-singleuser "$@"' not in source


def test_chart_and_digest_contracts_are_pinned() -> None:
    kustomization = yaml.safe_load((NOTEBOOKS_DIR / "kustomization.yaml").read_text())
    assert kustomization["helmCharts"] == [
        {
            "name": "jupyterhub",
            "repo": "https://hub.jupyter.org/helm-chart/",
            "version": "4.4.0",
            "releaseName": "torghut-notebooks",
            "namespace": "torghut",
            "valuesFile": "values.yaml",
        }
    ]
    values = yaml.safe_load((NOTEBOOKS_DIR / "values.yaml").read_text())
    assert values["hub"]["image"]["tag"] == "4.4.0"
    assert values["proxy"]["chp"]["image"]["tag"] == "5.2.0"
    assert "cmd" not in values["singleuser"]
    assert values["singleuser"]["image"]["name"].endswith("@sha256")
    assert re.fullmatch(r"[0-9a-f]{64}", values["singleuser"]["image"]["tag"])


def test_singleuser_memory_uses_jupyterhub_byte_specifications() -> None:
    values = yaml.safe_load((NOTEBOOKS_DIR / "values.yaml").read_text())
    memory = values["singleuser"]["memory"]
    assert memory == {"guarantee": "8G", "limit": "16G"}
    assert all(re.fullmatch(r"[1-9][0-9]*[KMGT]", value) for value in memory.values())


def test_render_validator_accepts_the_complete_production_contract(
    tmp_path: Path,
) -> None:
    from scripts.validate_notebook_render import validate

    rendered = tmp_path / "notebooks.yaml"
    rendered.write_text(yaml.safe_dump_all(_representative_render()))
    validate(rendered)


def test_render_validator_rejects_namespace_and_public_load_balancer(
    tmp_path: Path,
) -> None:
    from scripts.validate_notebook_render import validate

    namespace_render = tmp_path / "namespace.yaml"
    namespace_render.write_text(
        yaml.safe_dump_all(
            [
                *_representative_render(),
                {"kind": "Namespace", "metadata": {"name": "torghut"}},
            ]
        )
    )
    with pytest.raises(AssertionError, match="must not contain Namespace"):
        validate(namespace_render)

    load_balancer_render = tmp_path / "load-balancer.yaml"
    documents = _representative_render()
    documents.append(
        {
            "kind": "Service",
            "metadata": {"name": "public-notebooks"},
            "spec": {"type": "LoadBalancer"},
        }
    )
    load_balancer_render.write_text(yaml.safe_dump_all(documents))
    with pytest.raises(AssertionError):
        validate(load_balancer_render)


def test_render_validator_rejects_non_object_documents(tmp_path: Path) -> None:
    from scripts.validate_notebook_render import validate

    malformed = tmp_path / "malformed.yaml"
    malformed.write_text("- not-an-object\n")
    with pytest.raises(AssertionError, match="must be an object"):
        validate(malformed)


def test_hub_has_fixed_auto_login_without_identity() -> None:
    values = yaml.safe_load((NOTEBOOKS_DIR / "values.yaml").read_text())
    extra_config = values["hub"]["extraConfig"]["00-torghut-single-operator"]
    assert "class TorghutSingleOperatorAuthenticator(Authenticator)" in extra_config
    assert "auto_login = True" in extra_config
    assert 'return {"name": "torghut", "admin": False}' in extra_config
    forbidden = ("Keycloak", "OAuth", "password", "REMOTE_USER", "identity")
    assert all(term not in extra_config for term in forbidden)
    assert values["hub"]["config"]["JupyterHub"]["admin_access"] is False
    assert values["hub"]["allowNamedServers"] is False


def test_tailscale_owner_is_the_only_notebook_ingress_principal() -> None:
    values = yaml.safe_load((NOTEBOOKS_DIR / "values.yaml").read_text())
    assert values["ingress"]["annotations"] == {
        "tailscale.com/tags": "tag:torghut-notebooks"
    }

    policy_source = (
        REPO_ROOT / "tofu/tailscale/templates/policy.hujson.tmpl"
    ).read_text()
    policy = json.loads(re.sub(r"//.*", "", policy_source))
    assert policy["tagOwners"]["tag:torghut-notebooks"] == ["tag:k8s-operator"]

    general_rule = next(rule for rule in policy["acls"] if rule["src"] == ["*"])
    assert "10.244.0.0/16:*" not in general_rule["dst"]
    assert "10.96.0.0/12:*" not in general_rule["dst"]

    route_rule = next(
        rule for rule in policy["acls"] if "10.244.0.0/16:*" in rule["dst"]
    )
    assert route_rule["src"] == [
        "autogroup:owner",
        "tag:k8s-operator",
        "tag:k8s",
        "tag:k8s-subnet-router",
        "tag:kube-node",
    ]

    notebook_rule = next(
        rule for rule in policy["acls"] if rule["dst"] == ["tag:torghut-notebooks:443"]
    )
    assert notebook_rule["src"] == ["autogroup:owner"]


def test_hub_extra_config_has_a_valid_fixed_authenticator_contract() -> None:
    values = yaml.safe_load((NOTEBOOKS_DIR / "values.yaml").read_text())
    extra_config = values["hub"]["extraConfig"]["00-torghut-single-operator"]
    tree = ast.parse(extra_config, filename="torghut-jupyterhub-extra-config")
    compile(tree, "torghut-jupyterhub-extra-config", "exec")

    authenticator = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef)
        and node.name == "TorghutSingleOperatorAuthenticator"
    )
    assert [ast.unparse(base) for base in authenticator.bases] == ["Authenticator"]
    auto_login = next(
        node
        for node in authenticator.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "auto_login"
            for target in node.targets
        )
    )
    assert ast.literal_eval(auto_login.value) is True

    authenticate = next(
        node
        for node in authenticator.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "authenticate"
    )
    result = next(node for node in authenticate.body if isinstance(node, ast.Return))
    assert ast.literal_eval(result.value) == {"name": "torghut", "admin": False}

    assignments = {
        target.id: node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    assert ast.dump(assignments["cookie_secret"]) == ast.dump(
        ast.parse(
            'os.environ.get("TORGHUT_HUB_COOKIE_SECRET", "").strip()', mode="eval"
        ).body
    )
    assert ast.dump(assignments["crypt_key"]) == ast.dump(
        ast.parse(
            'os.environ.get("TORGHUT_HUB_CRYPT_KEY", "").strip()', mode="eval"
        ).body
    )


def test_no_namespace_or_plaintext_secret_is_committed() -> None:
    yaml_sources = "\n".join(path.read_text() for path in NOTEBOOKS_DIR.glob("*.yaml"))
    assert "kind: Namespace" not in yaml_sources
    secrets = list(
        yaml.safe_load_all((NOTEBOOKS_DIR / "sealed-secrets.yaml").read_text())
    )
    assert len(secrets) == 3
    for secret in secrets:
        assert set(secret["spec"]) == {"encryptedData", "template"}
        assert "data" not in secret["spec"]["template"]
        assert "stringData" not in secret["spec"]["template"]
    hub_secret = next(
        secret
        for secret in secrets
        if secret["metadata"]["name"] == "torghut-notebook-hub"
    )
    assert set(hub_secret["spec"]["encryptedData"]) == {
        "cookie-secret",
        "crypt-key",
        "proxy-token",
    }


def test_database_principals_are_read_only_and_bounded() -> None:
    postgres = yaml.safe_load(
        (REPO_ROOT / "argocd/applications/torghut/postgres-cluster.yaml").read_text()
    )
    role = next(
        role
        for role in postgres["spec"]["managed"]["roles"]
        if role["name"] == "torghut_notebook"
    )
    assert role["login"] is True
    assert role["connectionLimit"] == 4
    assert role["inRoles"] == ["pg_read_all_data"]
    assert role["passwordSecret"]["name"] == "torghut-notebook-postgres"
    assert role.get("superuser", False) is False
    assert role.get("createdb", False) is False
    assert role.get("createrole", False) is False

    clickhouse = yaml.safe_load(
        (
            REPO_ROOT / "argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml"
        ).read_text()
    )
    profiles = clickhouse["spec"]["configuration"]["profiles"]
    assert profiles == {
        "notebook/readonly": 1,
        "notebook/max_execution_time": 30,
        "notebook/max_result_rows": 100000,
        "notebook/result_overflow_mode": "throw",
        "notebook/max_memory_usage": 2147483648,
        "notebook/max_threads": 4,
    }
    users = clickhouse["spec"]["configuration"]["users"]
    assert users["torghut_notebook/profile"] == "notebook"
    assert users["torghut_notebook/password"]["valueFrom"]["secretKeyRef"] == {
        "name": "torghut-notebook-clickhouse",
        "key": "password",
    }
