# Torghut notebooks

This overlay renders upstream `jupyterhub/jupyterhub` chart `4.4.0` into the existing `torghut` namespace. The public
proxy remains `ClusterIP`; `torghut-notebooks.ide-newton.ts.net` is reachable only through the Tailscale ingress.
The runtime is standard JupyterLab on the cluster; it does not use a Colab VM or local-runtime bridge.

The Hub intentionally maps every admitted tailnet request to the single internal user key `torghut`. There is no
password, Keycloak, OAuth, admin user, named server, or account-management flow. Hub cookie, crypt, and proxy integrity tokens
come from `torghut-notebook-hub`; deterministic values in the chart-generated Secret are rendering placeholders and
are not referenced by the running Hub or proxy.

Notebook pods receive only a CNPG-managed `pg_read_all_data` role, a ClickHouse `readonly=1` profile, and the GET-only
Torghut scheduler status URL. They do not receive broker, TigerBeetle, Kafka, Flink, Alpaca, or Kubernetes credentials,
and service-account token automounting is disabled.
The dedicated image installs only the locked `notebook-runtime` dependency group, so mutation SDKs are absent as well.

The rendered NetworkPolicies document intended traffic, but the current cluster uses Flannel without a policy engine.
They are not an isolation claim. The operative controls are the Tailscale boundary, one trusted operator, read-only
principals, statement/result/memory/thread caps, and absence of mutation secrets.

Resources are deliberately bounded: a notebook requests 2 CPU/8 GiB and is limited to 8 CPU/16 GiB; Hub requests
250m/512 MiB and proxy requests 100m/128 MiB. The persistent workspace is 50 GiB and Hub SQLite is 1 GiB. Tighten or
aggregate a query before increasing these limits.

Rollback is a Git revert of the chart or notebook image digest pin. Both PVCs and the read-only principals are retained.
