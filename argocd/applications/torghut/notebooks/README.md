# Torghut notebooks

This overlay renders upstream `jupyterhub/jupyterhub` chart `4.4.2` (Hub `5.5.2`, configurable HTTP proxy `5.3.0`) into the existing `torghut` namespace. The public
proxy remains `ClusterIP`; `torghut-notebooks.ide-newton.ts.net` is reachable only through the Tailscale ingress.
The runtime is standard JupyterLab on the cluster; it does not use a Colab VM or local-runtime bridge.

The Hub intentionally maps every admitted tailnet request to the single internal user key `torghut`. There is no
password, Keycloak, OAuth, admin user, named server, or account-management flow. Hub cookie, crypt, and proxy integrity tokens
come from `torghut-notebook-hub`; deterministic values in the chart-generated Secret are rendering placeholders and
are not referenced by the running Hub or proxy.

The ingress uses the repository's existing `tag:k8s` convention, which is already delegated to the Kubernetes
operator and avoids a separate tailnet-policy bootstrap. Admission follows the tailnet's established Kubernetes
service ACL boundary without adding an application identity or login flow. Direct Pod and Service CIDR routes remain
restricted to the tailnet owner and tagged Kubernetes infrastructure identities so routed cluster addresses do not
broaden access beyond the existing infrastructure policy.

Notebook pods receive only a CNPG-managed `pg_read_all_data` role, a ClickHouse `readonly=1` profile, and the GET-only
Torghut scheduler status URL. They do not receive broker, TigerBeetle, Kafka, Flink, Alpaca, or Kubernetes credentials,
and service-account token automounting is disabled.
The dedicated image installs only the locked `notebook-runtime` dependency group, so mutation SDKs are absent as well.

The rendered NetworkPolicies restrict intended traffic and require live policy enforcement to provide network isolation.
The Tailscale boundary, one trusted operator, read-only principals, statement/result/memory/thread caps, and absence
of mutation secrets also constrain notebook access.

Resources are deliberately bounded: a notebook requests 2 CPU/8 GiB and is limited to 8 CPU/16 GiB; Hub requests
250m/512 MiB and proxy requests 100m/128 MiB. The persistent workspace is 50 GiB and Hub SQLite is 1 GiB. Tighten or
aggregate a query before increasing these limits.

Rollback is a Git revert of the chart or notebook image digest pin. Both PVCs and the read-only principals are retained.


## Hub and proxy upgrade

Hub and proxy images use immutable multi-architecture digests. The notebook runtime
uses JupyterHub 5.5.2 as well, keeping the Hub and single-user packages aligned.
The existing Kargo Torghut release publishes all required runtime images from the
same source commit and promotes their exact digests before Argo reconciles.

Before the 4.4.2 rollout, create a native SQLite backup of the running Hub database
under `/srv/jupyterhub/upgrade-backups/`, run `PRAGMA integrity_check`, and retain
its checksum and original PVC/Secret identities. Verify a separate copy with the
target Hub's `jupyterhub upgrade-db` and compare all table records and credentials.
The native 5.5.2 rehearsal preserved all 17 tables and passed integrity checks.
The Hub and proxy can restart without replacing the notebook workspace PVC or
changing the existing single-operator admission and read-only data principals.
After rollout, verify those identities and exercise notebook startup and a kernel
request through the existing private endpoint. Keep the database backup for recovery.
