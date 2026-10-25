"""Check the rendered coordinated-cutover targets, including rejected regressions."""

import base64
import copy
import json
import subprocess
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def resource(targets, target, kind, name):
    matches = [
        item
        for item in targets[target]
        if item and item["kind"] == kind and item["metadata"]["name"] == name
    ]
    require(len(matches) == 1, f"{target}: expected one {kind}/{name}")
    return matches[0]


def container(targets, target, kind, name):
    pod = resource(targets, target, kind, name)["spec"]["template"]["spec"]
    return next(item for item in pod["containers"] if item["name"] == name)


def values(item):
    return {entry["name"]: entry.get("value") for entry in item.get("env", [])}


def allows_database_or_api(targets, target, policy, port, labels):
    expected = {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ofz"}},
        "podSelector": {"matchLabels": labels},
    }
    rules = resource(targets, target, "NetworkPolicy", policy)["spec"]["egress"]
    return any(
        expected in rule.get("to", [])
        and {"protocol": "TCP", "port": port} in rule.get("ports", [])
        for rule in rules
    )


def validate(targets):
    workloads = [
        ("tengri", "Deployment", "tengri"),
        ("proompteng", "Deployment", "proompteng"),
        ("keycloak", "StatefulSet", "keycloak"),
        ("ofz", "Deployment", "ofz-api"),
    ]
    for target, documents in targets.items():
        for item in documents:
            if item:
                require(
                    item["kind"] != "Namespace",
                    f"{target}: namespace is ApplicationSet-owned",
                )
    native = resource(targets, "ofz", "SpiceDBCluster", "ofz")["spec"]["config"]
    require(
        native.get("dispatchCacheEnabled") == "false"
        and native.get("dispatchClusterCacheEnabled") == "false",
        "ofz: unqualified dispatch caches must stay disabled",
    )
    native_pool = int(native["datastoreConnPoolReadMaxOpen"]) + int(
        native["datastoreConnPoolWriteMaxOpen"]
    )
    maximum_connections = int(
        resource(targets, "ofz", "Cluster", "ofz-db")["spec"]["postgresql"][
            "parameters"
        ]["max_connections"]
    )
    require(
        (int(native["replicas"]) + 1) * native_pool + 3 * (14 + 14 + 8) + 6 * 4
        <= maximum_connections - 30,
        "ofz: simultaneous rolling surges exhaust the SQL connection budget",
    )
    roles = {
        item["name"]: item
        for item in resource(targets, "ofz", "Cluster", "ofz-db")["spec"]["managed"][
            "roles"
        ]
    }
    limits = {
        "ofz_migrator": 2,
        "ofz_api": 42,
        "ofz_archiver": 4,
        "tengri_migrator": 2,
        "tengri_controller": 42,
        "tengri_bff": 24,
        "tengri_supervisor": 24,
    }
    require(
        roles.keys() == limits.keys(),
        "ofz: every control database caller needs its own role",
    )
    for item in targets["ofz"]:
        if item and item["kind"] == "SealedSecret":
            require(
                item["metadata"]
                .get("annotations", {})
                .get("argocd.argoproj.io/sync-wave")
                == "-9",
                "ofz: Argo must create each outer SealedSecret before database and native consumers",
            )
        if item and item["kind"] == "NetworkPolicy":
            require(
                item["metadata"]
                .get("annotations", {})
                .get("argocd.argoproj.io/sync-wave")
                == "-5",
                "ofz: network isolation must precede owner jobs and serving workloads",
            )
    for name, limit in limits.items():
        role = roles[name]
        require(
            role["connectionLimit"] == limit
            and role["login"] is True
            and all(
                role[key] is False
                for key in [
                    "inherit",
                    "superuser",
                    "createdb",
                    "createrole",
                    "replication",
                    "bypassrls",
                ]
            ),
            f"ofz: {name} exceeds its database authority or connection budget",
        )
        require(
            role["passwordSecret"]["name"] == name.replace("_", "-") + "-db-auth",
            f"ofz: {name} credential binding changed",
        )
    for name, database, owner, command in [
        ("ofz-control-migrate", "ofz_control", "ofz_migrator", "migrate"),
        (
            "tengri-control-migrate",
            "tengri_control",
            "tengri_migrator",
            "migrate-runtime",
        ),
    ]:
        job = resource(targets, "ofz", "Job", name)
        app = next(iter(job["spec"]["template"]["spec"]["containers"]))
        require(
            app["args"] == [command]
            and f"dbname={database} user={owner}" in values(app)["OFZ_DATABASE_DSN"],
            f"ofz: {name} must use its schema owner",
        )
        require(
            job["metadata"]["annotations"].get("argocd.argoproj.io/sync-wave") == "-4",
            "ofz: schema migration must precede serving workloads",
        )
    export = resource(targets, "ofz", "Deployment", "ofz-audit-export")["spec"]
    bootstrap = resource(targets, "ofz", "Job", "ofz-platform-bootstrap")
    bootstrap_pod = bootstrap["spec"]["template"]["spec"]
    bootstrap_app = bootstrap_pod["containers"][0]
    require(
        bootstrap_app["args"] == ["bootstrap", "/var/run/ofz/bootstrap/manifest.json"]
        and "dbname=ofz_control user=ofz_migrator"
        in values(bootstrap_app)["OFZ_DATABASE_DSN"]
        and bootstrap["metadata"]["annotations"].get("argocd.argoproj.io/sync-wave")
        == "-3",
        "ofz: approved owner bootstrap must follow migration and retain the platform fence",
    )
    require(
        {
            item["name"]: item.get("secret", {}).get("secretName")
            for item in bootstrap_pod["volumes"]
        }.get("bootstrap")
        == "ofz-bootstrap-manifest",
        "ofz: bootstrap requires the protected approved manifest",
    )
    require(
        export["replicas"] == 2
        and export["strategy"]["rollingUpdate"]["maxSurge"] == 0,
        "ofz: archive leadership must fit its four-connection budget",
    )
    activation = resource(targets, "ofz", "Job", "ofz-platform-activate")
    activation_pod = activation["spec"]["template"]["spec"]
    activation_app = activation_pod["containers"][0]
    require(
        activation["metadata"]["annotations"].get("argocd.argoproj.io/hook")
        == "PostSync"
        and activation_app["args"]
        == ["activate", "/var/run/ofz/bootstrap/manifest.json"]
        and activation_pod["serviceAccountName"] == "ofz-migrator"
        and values(activation_app) == values(bootstrap_app)
        and activation_pod["volumes"] == bootstrap_pod["volumes"],
        "ofz: archive-gated activation must use only the approved owner manifest and authority",
    )
    reader = resource(targets, "ofz", "Role", "ofz-public-ca-reader")
    require(
        reader["rules"]
        == [
            {
                "apiGroups": [""],
                "resources": ["secrets"],
                "resourceNames": ["ofz-db-public-ca"],
                "verbs": ["get"],
            }
        ],
        "ofz: public CA projection must not permit discovery or access to unrelated Secrets",
    )
    publisher = resource(targets, "ofz", "Role", "ofz-ca-publisher")
    require(
        publisher["rules"]
        == [
            {
                "apiGroups": [""],
                "resources": ["secrets"],
                "resourceNames": ["ofz-db-ca"],
                "verbs": ["get"],
            }
        ],
        "ofz: only the namespace-local CA publisher may read the private CA Secret",
    )
    local_store = resource(targets, "ofz", "SecretStore", "ofz-ca-source")["spec"]
    require(
        local_store["provider"]["kubernetes"]["remoteNamespace"] == "ofz"
        and local_store["provider"]["kubernetes"]["auth"]["serviceAccount"]
        == {"name": "ofz-ca-publisher"},
        "ofz: private CA source must remain namespace-scoped",
    )
    public_ca = resource(targets, "ofz", "ExternalSecret", "ofz-db-public-ca")["spec"]
    require(
        public_ca["secretStoreRef"] == {"kind": "SecretStore", "name": "ofz-ca-source"}
        and public_ca["target"]["name"] == "ofz-db-public-ca"
        and public_ca.get("dataFrom") is None
        and public_ca["data"]
        == [
            {
                "secretKey": "ca.crt",
                "remoteRef": {"key": "ofz-db-ca", "property": "ca.crt"},
            }
        ]
        and public_ca["refreshInterval"] == "1m",
        "ofz: shared trust bundle must contain only the refreshed public certificate",
    )
    for item in targets["ofz"]:
        if item and item["kind"] in ["Deployment", "Job"]:
            for volume in item["spec"]["template"]["spec"].get("volumes", []):
                secret = volume.get("secret", {})
                if secret.get("secretName") == "ofz-db-ca":
                    require(
                        secret.get("items") == [{"key": "ca.crt", "path": "ca.crt"}],
                        "ofz: database callers must not mount the CA signing key",
                    )
    ca_store = resource(targets, "ofz", "ClusterSecretStore", "ofz-database-ca")["spec"]
    require(
        ca_store["conditions"] == [{"namespaces": ["tengri", "proompteng"]}]
        and ca_store["provider"]["kubernetes"]["remoteNamespace"] == "ofz"
        and ca_store["provider"]["kubernetes"]["auth"]["serviceAccount"]
        == {"name": "ofz-public-ca-reader", "namespace": "ofz"},
        "ofz: database CA store must retain its exact reader and application namespace allowlist",
    )
    for target in ["tengri", "proompteng"]:
        ca = resource(targets, target, "ExternalSecret", "ofz-database-ca")["spec"]
        require(
            ca.get("dataFrom") is None
            and ca["data"]
            == [
                {
                    "secretKey": "ca.crt",
                    "remoteRef": {"key": "ofz-db-public-ca", "property": "ca.crt"},
                }
            ]
            and ca["secretStoreRef"]
            == {"kind": "ClusterSecretStore", "name": "ofz-database-ca"}
            and ca["refreshInterval"] == "1m",
            f"{target}: only the refreshed public CA may leave the Ofz namespace",
        )
        require(
            not any(
                item
                and item.get("kind") == "SealedSecret"
                and item["metadata"]["name"]
                in ["tengri-runtime", "tengri-spicedb-key", "tengri-bff"]
                for item in targets[target]
            ),
            f"{target}: obsolete authority must be deleted during hard cutover",
        )
    export_pod = export["template"]["spec"]
    export_app = export_pod["containers"][0]
    require(
        "user=ofz_archiver" in values(export_app)["OFZ_DATABASE_DSN"],
        "ofz: exporter requires the restricted archive role",
    )
    require(
        not any(
            item.get("secret", {}).get("secretName") == "ofz-spicedb-key"
            for item in export_pod["volumes"]
        ),
        "ofz: exporter must not hold native policy authority",
    )
    export_network = resource(targets, "ofz", "NetworkPolicy", "ofz-audit-export")[
        "spec"
    ]
    require(
        export_network["ingress"] == []
        and export_network["egress"][-1]
        == {
            "to": [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": "rook-ceph"}
                    },
                    "podSelector": {"matchLabels": {"app": "rook-ceph-rgw"}},
                }
            ],
            "ports": [{"protocol": "TCP", "port": 8080}],
        },
        "ofz: exporter egress requires the private Ceph object gateway",
    )
    for target, kind, name in workloads:
        spec = resource(targets, target, kind, name)["spec"]
        require(spec["replicas"] == 2, f"{target}: two serving replicas required")
        pod = spec["template"]["spec"]
        labels = spec["template"]["metadata"]["labels"]
        spread = (
            pod.get("affinity", {})
            .get("podAntiAffinity", {})
            .get("requiredDuringSchedulingIgnoredDuringExecution", [])
        )
        require(
            any(
                term["topologyKey"] == "kubernetes.io/hostname"
                and term["labelSelector"]["matchLabels"]
                and all(
                    labels.get(key) == value
                    for key, value in term["labelSelector"]["matchLabels"].items()
                )
                for term in spread
            ),
            f"{target}: required host spread must select the serving Pods",
        )
        pdb = resource(targets, target, "PodDisruptionBudget", name)["spec"]
        require(
            pdb.get("minAvailable") == 1,
            f"{target}: retain one replica during eviction",
        )
        require(
            all(
                labels.get(key) == value
                for key, value in pdb["selector"]["matchLabels"].items()
            ),
            f"{target}: disruption budget must select the serving Pods",
        )

    for target, role in [("tengri", "tengri_controller"), ("proompteng", "tengri_bff")]:
        spec = resource(targets, target, "Deployment", target)["spec"]["template"][
            "spec"
        ]
        app = container(targets, target, "Deployment", target)
        env = values(app)
        require(
            env.get("OFZ_GRPC_ENDPOINT") == "ofz-api.ofz.svc.cluster.local:9443",
            f"{target}: central API required",
        )
        require(
            role in env.get("TENGRI_DATABASE_DSN", ""),
            f"{target}: restricted database role required",
        )
        require(not app.get("envFrom"), f"{target}: unclassified credential injection")
        require(
            not {
                "TENGRI_AUTHZ_ENDPOINT",
                "TENGRI_AUTHZ_KEY_FILE",
                "TENGRI_RUNTIME_SECRET_DIRECTORY",
                "BETTER_AUTH_URL",
            }.intersection(env),
            f"{target}: legacy authority must be removed",
        )
        volumes = {volume["name"]: volume for volume in spec["volumes"]}
        mounts = {mount["mountPath"]: mount for mount in app["volumeMounts"]}
        expected = {
            "/var/run/tengri/database": "tengri-controller-db"
            if target == "tengri"
            else "tengri-bff-db",
            "/var/run/tengri/database-ca": "ofz-database-ca",
        }
        if target == "tengri":
            expected["/var/run/tengri/guest-signing"] = "tengri-guest-signing"
            require(
                env.get("TENGRI_GUEST_SIGNING_KEY_FILE")
                == "/var/run/tengri/guest-signing/key"
                and env.get("TENGRI_GUEST_RECOVERY_GENERATION_FILE")
                == "/var/run/tengri/guest-signing/recovery-generation",
                "tengri: signed guest requests require the private key and recovery generation",
            )
        else:
            require(
                not any(
                    volume.get("secret", {}).get("secretName") == "tengri-guest-signing"
                    for volume in volumes.values()
                ),
                "proompteng: guest signing key belongs only to controllers",
            )
        for path, secret in expected.items():
            mount = mounts.get(path, {})
            require(
                mount.get("readOnly") is True,
                f"{target}: {path} must be mounted read-only",
            )
            require(
                volumes.get(mount.get("name"), {}).get("secret", {}).get("secretName")
                == secret,
                f"{target}: {path} requires {secret}",
            )
        require(
            not any(
                volume.get("secret", {}).get("secretName")
                in {"tengri-runtime", "tengri-spicedb-key", "tengri-bff"}
                for volume in volumes.values()
            ),
            f"{target}: legacy credential volume remains",
        )
    bff = resource(targets, "proompteng", "Deployment", "proompteng")["spec"][
        "template"
    ]["spec"]
    require(
        not bff.get("nodeSelector", {}).get("kubernetes.io/arch"),
        "proompteng: host spread requires both architectures",
    )
    for target, policy in [
        ("tengri", "tengri-control-plane"),
        ("proompteng", "proompteng-web"),
    ]:
        require(
            allows_database_or_api(
                targets, target, policy, 9443, {"app.kubernetes.io/name": "ofz-api"}
            ),
            f"{target}: API egress is blocked",
        )
        require(
            allows_database_or_api(
                targets, target, policy, 5432, {"cnpg.io/cluster": "ofz-db"}
            ),
            f"{target}: shared database egress is blocked",
        )
    require(
        allows_database_or_api(
            targets, "tengri", "tengri-slots", 5432, {"cnpg.io/cluster": "ofz-db"}
        ),
        "tengri: supervisor database egress is blocked",
    )
    traefik = {
        "namespaceSelector": {
            "matchLabels": {"kubernetes.io/metadata.name": "traefik"}
        },
        "podSelector": {"matchLabels": {"app.kubernetes.io/name": "traefik"}},
    }
    bff_egress = resource(targets, "proompteng", "NetworkPolicy", "proompteng-web")[
        "spec"
    ]["egress"]
    require(
        any(
            traefik in rule.get("to", [])
            and {"protocol": "TCP", "port": 8443} in rule.get("ports", [])
            for rule in bff_egress
        ),
        "proompteng: post-DNAT identity-provider egress is blocked",
    )
    crd = resource(
        targets, "tengri", "CustomResourceDefinition", "microvms.runtime.proompteng.ai"
    )
    require(
        crd["spec"] == targets["crd"][0]["spec"],
        "tengri: rendered CRD differs from the generated contract",
    )
    require(
        not any(
            item
            and item["kind"] == "ConfigMap"
            and item["metadata"]["name"] == "tengri-auth-nonces"
            for item in targets["tengri"]
        ),
        "tengri: replay state must be durable SQL",
    )
    kc = values(container(targets, "keycloak", "StatefulSet", "keycloak"))
    require(
        kc.get("KC_CACHE_STACK") == "jdbc-ping" and kc.get("KC_CACHE") == "ispn",
        "keycloak: distributed JDBC cache required",
    )
    require(
        kc.get("KC_CACHE_EMBEDDED_MTLS_ENABLED") == "true",
        "keycloak: cache transport mTLS required",
    )
    require(
        kc.get("KC_HOSTNAME") == "https://auth.proompteng.ai"
        and kc.get("KC_HOSTNAME_STRICT") == "true",
        "keycloak: fixed HTTPS issuer required",
    )
    require(
        "sslmode=verify-full" in kc.get("KC_DB_URL", ""),
        "keycloak: database identity verification required",
    )
    keycloak_pod = resource(targets, "keycloak", "StatefulSet", "keycloak")["spec"][
        "template"
    ]["spec"]
    keycloak_ca = next(
        volume for volume in keycloak_pod["volumes"] if volume["name"] == "database-ca"
    )["secret"]
    require(
        keycloak_ca["defaultMode"] == 0o440
        and keycloak_ca.get("items") == [{"key": "ca.crt", "path": "ca.crt"}],
        "keycloak: mount only the public database CA certificate with mode 0440",
    )
    theme_mounts = [
        mount
        for mount in container(targets, "keycloak", "StatefulSet", "keycloak")[
            "volumeMounts"
        ]
        if mount["name"] == "login-theme"
    ]
    require(
        theme_mounts
        == [
            {
                "name": "login-theme",
                "mountPath": "/opt/keycloak/themes/tengri/login",
                "readOnly": True,
            }
        ],
        "keycloak: the dedicated login theme must be mounted read-only",
    )
    theme = next(
        volume for volume in keycloak_pod["volumes"] if volume["name"] == "login-theme"
    )["configMap"]
    theme_files = {
        "theme.properties": "theme.properties",
        "webauthnRegister.js": "resources/js/webauthnRegister.js",
        "webauthnAuthenticate.js": "resources/js/webauthnAuthenticate.js",
        "webauthn-authenticate.ftl": "webauthn-authenticate.ftl",
        "template.ftl": "template.ftl",
        "tengri.css": "resources/css/tengri.css",
        "messages_en.properties": "messages/messages_en.properties",
        "fruit-pear.svg": "resources/img/fruit-pear.svg",
        "wallpaper.webp": "resources/img/wallpaper.webp",
        "GeistSans.woff2": "resources/fonts/GeistSans.woff2",
        "OFL.txt": "resources/fonts/OFL.txt",
        "pictogrammers-LICENSE.txt": "resources/img/pictogrammers-LICENSE.txt",
    }
    require(
        theme["items"]
        == [{"key": key, "path": path} for key, path in theme_files.items()],
        "keycloak: branded assets must use the paths imported by the login templates",
    )
    theme_root = Path("argocd/applications/keycloak/tengri/theme/login")
    theme_config = resource(targets, "keycloak", "ConfigMap", theme["name"])
    binary_assets = {"wallpaper.webp", "GeistSans.woff2"}
    require(
        theme_config["data"]
        == {
            key: (theme_root / path).read_text()
            for key, path in theme_files.items()
            if key not in binary_assets
        }
        and {
            key: base64.b64decode(value)
            for key, value in theme_config["binaryData"].items()
        }
        == {
            key: (theme_root / path).read_bytes()
            for key, path in theme_files.items()
            if key in binary_assets
        },
        "keycloak: the deployed theme must contain the browser-qualified templates, modules and brand assets",
    )
    require(
        len(json.dumps(theme_config).encode()) < 1024 * 1024,
        "keycloak: the complete login theme must fit within the ConfigMap size limit",
    )
    require(
        kc.get("KC_DB_POOL_MAX_SIZE") == "20",
        "keycloak: bounded connection pool required",
    )
    database = resource(targets, "keycloak", "Cluster", "keycloak-db")["spec"]
    require(database["instances"] == 3, "keycloak: three database instances required")
    capacity_mib = int(database["storage"]["size"].removesuffix("Gi")) * 1024
    retained_wal_mib = int(
        database["postgresql"]["parameters"]
        .get("max_slot_wal_keep_size", "-1")
        .removesuffix("MB")
    )
    require(
        0 < retained_wal_mib <= capacity_mib // 4,
        "keycloak: replica WAL retention must be bounded to a quarter of database storage",
    )
    require(
        database["affinity"]["podAntiAffinityType"] == "required",
        "keycloak: database host spread required",
    )
    require(
        database["affinity"].get("tolerations")
        == [
            {
                "key": "workload.proompteng.ai/compute-local",
                "operator": "Equal",
                "value": "true",
                "effect": "NoSchedule",
            }
        ],
        "keycloak: third database host requires the exact compute-local toleration",
    )
    require(
        database["postgresql"]["synchronous"]
        == {"method": "any", "number": 1, "dataDurability": "required"},
        "keycloak: synchronous durability required",
    )
    checkpoint = resource(targets, "keycloak", "Backup", "keycloak-server-26-7-4")
    require(
        checkpoint["metadata"]["annotations"]
        == {
            "argocd.argoproj.io/sync-wave": "-10",
            "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
        }
        and checkpoint["spec"]["method"] == "volumeSnapshot"
        and checkpoint["spec"]["cluster"]["name"] == "keycloak-db"
        and checkpoint["spec"]["online"] is True,
        "keycloak: the server upgrade requires a fresh protected checkpoint before its wave",
    )
    ingress = resource(targets, "keycloak", "IngressRoute", "keycloak")["spec"]
    require(
        ingress["entryPoints"] == ["websecure"]
        and ingress["tls"]["secretName"] == "auth-proompteng-ai-tls",
        "keycloak: reviewed HTTPS certificate required",
    )
    for target in ["ofz", "keycloak"]:
        store = resource(targets, target, "ObjectStore", f"{target}-db")["spec"]
        config = store["configuration"]
        require(
            config["destinationPath"] == f"s3://{target}-database-backups/"
            and config["endpointURL"]
            == "http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80"
            and "encryption" not in config["data"]
            and "encryption" not in config["wal"]
            and store["retentionPolicy"] == "35d",
            f"{target}: Ceph base backups and WAL are required",
        )
        require(
            config["s3Credentials"]
            == {
                "accessKeyId": {
                    "name": f"{target}-database-backup",
                    "key": "AWS_ACCESS_KEY_ID",
                },
                "secretAccessKey": {
                    "name": f"{target}-database-backup",
                    "key": "AWS_SECRET_ACCESS_KEY",
                },
            },
            f"{target}: database writer must be separate from the audit writer",
        )
        cluster = resource(targets, target, "Cluster", f"{target}-db")["spec"]
        require(
            cluster["affinity"]["podAntiAffinityType"] == "required"
            and cluster["affinity"]["topologyKey"] == "kubernetes.io/hostname"
            and cluster["affinity"].get("tolerations")
            == [
                {
                    "key": "workload.proompteng.ai/compute-local",
                    "operator": "Equal",
                    "value": "true",
                    "effect": "NoSchedule",
                }
            ],
            f"{target}: database replicas must use three hosts without removing the compute taint",
        )
        require(
            resource(targets, target, "Cluster", f"{target}-db")["metadata"]
            .get("annotations", {})
            .get("argocd.argoproj.io/sync-wave")
            == "-8",
            f"{target}: database plugin must be installed before the immediate backup wave",
        )
        require(
            cluster["postgresql"]["parameters"]["archive_timeout"] == "60s"
            and cluster["plugins"]
            == [
                {
                    "name": "barman-cloud.cloudnative-pg.io",
                    "enabled": True,
                    "isWALArchiver": True,
                    "parameters": {
                        "barmanObjectName": f"{target}-db",
                        "serverName": f"{target}-db",
                    },
                }
            ],
            f"{target}: native backup and WAL archive binding changed",
        )
        scheduled = resource(targets, target, "ScheduledBackup", f"{target}-db-daily")[
            "spec"
        ]
        require(
            scheduled["immediate"] is False
            and scheduled["cluster"]["name"] == f"{target}-db"
            and scheduled["method"] == "plugin"
            and scheduled["pluginConfiguration"]["name"]
            == "barman-cloud.cloudnative-pg.io",
            f"{target}: daily schedule must not duplicate the explicit initial backup",
        )
        initial = resource(
            targets, target, "Backup", f"{target}-db-ceph-cutover-primary"
        )
        require(
            initial["spec"]["method"] == "plugin"
            and initial["spec"]["target"] == "primary"
            and initial["spec"]["pluginConfiguration"]["name"]
            == "barman-cloud.cloudnative-pg.io"
            and initial["spec"]["cluster"]["name"] == f"{target}-db"
            and initial["metadata"]["annotations"].get("argocd.argoproj.io/sync-wave")
            == "-6"
            and initial["metadata"]["annotations"].get(
                "argocd.argoproj.io/sync-options"
            )
            == "Prune=false,Delete=false",
            f"{target}: new store requires a protected physical backup before serving changes",
        )
    for name in ["keycloak-tengri-broker", "keycloak-tengri-bff"]:
        credential = resource(targets, "keycloak", "SealedSecret", name)
        require(
            credential["metadata"]
            .get("annotations", {})
            .get("argocd.argoproj.io/sync-wave")
            == "-9",
            "keycloak: outer SealedSecrets must precede realm bootstrap",
        )
    certificate = resource(targets, "keycloak", "Certificate", "auth-proompteng-ai")
    require(
        certificate["spec"]["dnsNames"] == ["auth.proompteng.ai"]
        and certificate["spec"]["secretName"] == ingress["tls"]["secretName"],
        "keycloak: issuer certificate must match the ingress and public hostname",
    )
    tunnel = resource(targets, "cloudflare", "Deployment", "cloudflared-deployment")
    config_name = tunnel["spec"]["template"]["spec"]["volumes"][0]["configMap"]["name"]
    require(
        config_name.startswith("cloudflared-config-")
        and config_name != "cloudflared-config",
        "keycloak: changed tunnel configuration must roll its serving Pod",
    )
    config = resource(targets, "cloudflare", "ConfigMap", config_name)["data"][
        "config.yaml"
    ]
    routes = json.loads(
        subprocess.check_output(["yq", "-o=json", "."], input=config, text=True)
    )["ingress"]
    issuer_routes = [
        route for route in routes if route.get("hostname") == "auth.proompteng.ai"
    ]
    require(
        len(issuer_routes) == 1, "keycloak: one exact public issuer route is required"
    )
    issuer_route = issuer_routes[0]
    require(
        issuer_route["service"] == "https://traefik.traefik.svc.cluster.local:443"
        and issuer_route.get("originRequest", {})
        == {"originServerName": "auth.proompteng.ai"},
        "keycloak: public issuer route must verify the origin TLS identity",
    )
    require(
        routes.index(issuer_route)
        < next(
            index
            for index, route in enumerate(routes)
            if route.get("hostname") == "*.proompteng.ai"
        ),
        "keycloak: verified issuer route must precede the wildcard route",
    )
    network = resource(targets, "keycloak", "NetworkPolicy", "keycloak-server")["spec"]
    for direction, peer_key in [("ingress", "from"), ("egress", "to")]:
        ports = set()
        for rule in network[direction]:
            transport = {
                entry["port"]
                for entry in rule.get("ports", [])
                if entry["port"] in {7800, 57800}
            }
            if transport:
                ports.update(transport)
                require(
                    rule[peer_key]
                    == [{"podSelector": {"matchLabels": {"app": "keycloak"}}}],
                    f"keycloak: {direction} transport must stay server-only",
                )
        require(
            ports == {7800, 57800}, f"keycloak: {direction} cache transport is blocked"
        )


def main():
    directory = Path(sys.argv[1])
    targets = {
        name: json.loads((directory / f"{name}.json").read_text())
        for name in ["tengri", "proompteng", "keycloak", "ofz", "crd", "cloudflare"]
    }
    validate(targets)
    mutations = [
        lambda data: resource(data, "ofz", "Cluster", "ofz-db")["spec"]["postgresql"][
            "parameters"
        ].update(max_connections="200"),
        lambda data: next(
            role
            for role in resource(data, "ofz", "Cluster", "ofz-db")["spec"]["managed"][
                "roles"
            ]
            if role["name"] == "tengri_controller"
        ).update(connectionLimit=36),
        lambda data: next(
            role
            for role in resource(data, "ofz", "Cluster", "ofz-db")["spec"]["managed"][
                "roles"
            ]
            if role["name"] == "tengri_supervisor"
        ).update(connectionLimit=12),
        lambda data: resource(data, "ofz", "Backup", "ofz-db-ceph-cutover-primary")[
            "spec"
        ].update(method="volumeSnapshot"),
        lambda data: resource(
            data, "keycloak", "Backup", "keycloak-db-ceph-cutover-primary"
        )["metadata"]["annotations"].update({"argocd.argoproj.io/sync-wave": "0"}),
        lambda data: resource(data, "ofz", "Backup", "ofz-db-ceph-cutover-primary")[
            "spec"
        ].update(target="prefer-standby"),
        lambda data: resource(
            data, "keycloak", "Backup", "keycloak-db-ceph-cutover-primary"
        )["spec"].update(target="prefer-standby"),
        lambda data: resource(data, "ofz", "Cluster", "ofz-db")["spec"][
            "affinity"
        ].update(podAntiAffinityType="preferred"),
        lambda data: resource(data, "ofz", "Job", "ofz-platform-activate")["spec"][
            "template"
        ]["spec"]["containers"][0].update(
            args=["bootstrap", "/var/run/ofz/bootstrap/manifest.json"]
        ),
        lambda data: resource(data, "ofz", "Role", "ofz-public-ca-reader")["rules"][
            0
        ].pop("resourceNames"),
        lambda data: resource(data, "ofz", "Role", "ofz-public-ca-reader")["rules"][
            0
        ].update(resourceNames=["ofz-db-ca"]),
        lambda data: resource(data, "ofz", "Role", "ofz-ca-publisher")["rules"][0].pop(
            "resourceNames"
        ),
        lambda data: resource(data, "ofz", "ExternalSecret", "ofz-db-public-ca")[
            "spec"
        ]["data"][0]["remoteRef"].update(property="ca.key"),
        lambda data: resource(data, "ofz", "ExternalSecret", "ofz-db-public-ca")[
            "spec"
        ]["secretStoreRef"].update(kind="ClusterSecretStore"),
        lambda data: next(
            volume
            for volume in resource(data, "ofz", "Deployment", "ofz-api")["spec"][
                "template"
            ]["spec"]["volumes"]
            if volume.get("secret", {}).get("secretName") == "ofz-db-ca"
        )["secret"].pop("items"),
        lambda data: resource(data, "tengri", "ExternalSecret", "ofz-database-ca")[
            "spec"
        ]["data"][0]["remoteRef"].update(property="ca.key"),
        lambda data: resource(data, "proompteng", "ExternalSecret", "ofz-database-ca")[
            "spec"
        ].update(dataFrom=[{"extract": {"key": "ofz-db-ca"}}]),
        lambda data: resource(data, "ofz", "ClusterSecretStore", "ofz-database-ca")[
            "spec"
        ].update(conditions=[{"namespaceRegexes": [".*"]}]),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["metadata"][
            "annotations"
        ].pop("argocd.argoproj.io/sync-wave"),
        lambda data: next(
            volume
            for volume in resource(data, "keycloak", "StatefulSet", "keycloak")["spec"][
                "template"
            ]["spec"]["volumes"]
            if volume["name"] == "database-ca"
        )["secret"].pop("items"),
        lambda data: resource(data, "ofz", "ObjectStore", "ofz-db")["spec"][
            "configuration"
        ].update(endpointURL="https://rook-ceph-rgw.rook-ceph.svc"),
        lambda data: resource(data, "keycloak", "ObjectStore", "keycloak-db")["spec"][
            "configuration"
        ].update(destinationPath="s3://ofz-database-backups/"),
        lambda data: resource(data, "ofz", "ObjectStore", "ofz-db")["spec"][
            "configuration"
        ]["wal"].update(encryption="AES256"),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["spec"][
            "postgresql"
        ]["parameters"].update(archive_timeout="1h"),
        lambda data: resource(data, "keycloak", "ScheduledBackup", "keycloak-db-daily")[
            "spec"
        ].update(immediate=True),
        lambda data: container(data, "tengri", "Deployment", "tengri")["env"].append(
            {"name": "TENGRI_GUEST_SIGNING_KEY_FILE", "value": "/tmp/wrong-key"}
        ),
        lambda data: resource(data, "proompteng", "Deployment", "proompteng")["spec"][
            "template"
        ]["spec"]["volumes"].append(
            {"name": "guest-signing", "secret": {"secretName": "tengri-guest-signing"}}
        ),
        lambda data: resource(data, "ofz", "SpiceDBCluster", "ofz")["spec"][
            "config"
        ].update(dispatchCacheEnabled="true"),
        lambda data: resource(data, "ofz", "SpiceDBCluster", "ofz")["spec"][
            "config"
        ].update(datastoreConnPoolReadMaxOpen="20", datastoreConnPoolWriteMaxOpen="10"),
        lambda data: resource(data, "tengri", "Deployment", "tengri")["spec"].update(
            replicas=1
        ),
        lambda data: resource(data, "proompteng", "Deployment", "proompteng")["spec"][
            "template"
        ]["spec"].pop("affinity"),
        lambda data: resource(data, "tengri", "Deployment", "tengri")["spec"][
            "template"
        ]["spec"].update(volumes=[]),
        lambda data: container(data, "keycloak", "StatefulSet", "keycloak")[
            "env"
        ].append({"name": "KC_CACHE_EMBEDDED_MTLS_ENABLED", "value": "false"}),
        lambda data: container(data, "keycloak", "StatefulSet", "keycloak").update(
            volumeMounts=[]
        ),
        lambda data: next(
            volume
            for volume in resource(data, "keycloak", "StatefulSet", "keycloak")["spec"][
                "template"
            ]["spec"]["volumes"]
            if volume["name"] == "login-theme"
        )["configMap"]["items"].pop(),
        lambda data: resource(data, "keycloak", "StatefulSet", "keycloak")["spec"][
            "template"
        ]["spec"]["volumes"][0]["secret"].update(defaultMode=440),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["spec"][
            "postgresql"
        ]["synchronous"].update(dataDurability="preferred"),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["spec"][
            "storage"
        ].update(size="5Gi"),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["spec"][
            "postgresql"
        ]["parameters"].pop("max_slot_wal_keep_size"),
        lambda data: resource(data, "keycloak", "Cluster", "keycloak-db")["spec"][
            "affinity"
        ].update(tolerations=[]),
        lambda data: resource(data, "keycloak", "Backup", "keycloak-server-26-7-4")[
            "metadata"
        ]["annotations"].update({"argocd.argoproj.io/sync-wave": "0"}),
        lambda data: resource(
            data, "keycloak", "SealedSecret", "keycloak-tengri-broker"
        )["metadata"].pop("annotations"),
        lambda data: resource(data, "keycloak", "Certificate", "auth-proompteng-ai")[
            "spec"
        ].update(dnsNames=["other.proompteng.ai"]),
        lambda data: resource(
            data, "cloudflare", "Deployment", "cloudflared-deployment"
        )["spec"]["template"]["spec"]["volumes"][0]["configMap"].update(
            name="cloudflared-config"
        ),
        lambda data: next(
            item for item in data["cloudflare"] if item and item["kind"] == "ConfigMap"
        )["data"].update({"config.yaml": "ingress: []\n"}),
        lambda data: next(
            item for item in data["cloudflare"] if item and item["kind"] == "ConfigMap"
        )["data"].update(
            {
                "config.yaml": next(
                    item
                    for item in data["cloudflare"]
                    if item and item["kind"] == "ConfigMap"
                )["data"]["config.yaml"].replace(
                    "originServerName: auth.proompteng.ai",
                    "originServerName: auth.proompteng.ai\n      noTLSVerify: true",
                )
            }
        ),
        lambda data: resource(
            data, "tengri", "CustomResourceDefinition", "microvms.runtime.proompteng.ai"
        )["spec"].update(versions=[]),
        lambda data: data["ofz"].append(
            {"kind": "Namespace", "metadata": {"name": "ofz"}}
        ),
        lambda data: resource(data, "tengri", "NetworkPolicy", "tengri-control-plane")[
            "spec"
        ].update(egress=[]),
        lambda data: resource(data, "keycloak", "NetworkPolicy", "keycloak-server")[
            "spec"
        ]["ingress"][-1].update({"from": [{"ipBlock": {"cidr": "0.0.0.0/0"}}]}),
    ]
    mutations.extend(
        [
            lambda data: resource(data, "ofz", "SealedSecret", "ofz-api-db-auth")[
                "metadata"
            ].pop("annotations"),
            lambda data: resource(data, "ofz", "NetworkPolicy", "ofz-migrate")[
                "metadata"
            ].pop("annotations"),
            lambda data: resource(data, "ofz", "Job", "ofz-platform-bootstrap")["spec"][
                "template"
            ]["spec"]["containers"][0].update(
                args=["activate", "/var/run/ofz/bootstrap/manifest.json"]
            ),
            lambda data: resource(data, "ofz", "Job", "ofz-platform-bootstrap")["spec"][
                "template"
            ]["spec"]["volumes"][-1]["secret"].update(
                secretName="unapproved-bootstrap"
            ),
            lambda data: resource(data, "ofz", "Cluster", "ofz-db")["spec"]["managed"][
                "roles"
            ][1].update(superuser=True),
            lambda data: resource(data, "ofz", "Job", "ofz-control-migrate")["spec"][
                "template"
            ]["spec"]["containers"][0]["env"][0].update(
                value="dbname=ofz_control user=ofz_api sslmode=require"
            ),
            lambda data: resource(data, "ofz", "Deployment", "ofz-audit-export")[
                "spec"
            ]["strategy"]["rollingUpdate"].update(maxSurge=2),
            lambda data: resource(data, "ofz", "NetworkPolicy", "ofz-audit-export")[
                "spec"
            ]["egress"][-1]["to"][0].update(ipBlock={"cidr": "0.0.0.0/0"}),
            lambda data: resource(
                data, "proompteng", "NetworkPolicy", "proompteng-web"
            )["spec"].update(
                egress=[
                    rule
                    for rule in resource(
                        data, "proompteng", "NetworkPolicy", "proompteng-web"
                    )["spec"]["egress"]
                    if {"protocol": "TCP", "port": 8443} not in rule.get("ports", [])
                ]
            ),
            lambda data: next(
                rule
                for rule in resource(
                    data, "proompteng", "NetworkPolicy", "proompteng-web"
                )["spec"]["egress"]
                if {"protocol": "TCP", "port": 8443} in rule.get("ports", [])
            )["to"][0]["podSelector"]["matchLabels"].update(
                {"app.kubernetes.io/name": "wrong-identity-provider"}
            ),
        ]
    )
    for index, mutate in enumerate(mutations):
        invalid = copy.deepcopy(targets)
        mutate(invalid)
        try:
            validate(invalid)
        except ValueError:
            continue
        raise RuntimeError(f"HA regression {index + 1} was accepted")
    print(
        f"PASS: {len(targets) - 1} rendered targets and {len(mutations)} rejected regressions"
    )


if __name__ == "__main__":
    main()
