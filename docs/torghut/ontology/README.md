# Torghut market-data ontology

[The ONT-1 bundle](torghut-knowledge.json) describes market data and research inputs in the Galactic ClickHouse
`signal` database. Its four analyses are bounded diagnostic reads, not trading signals or qualification evidence.

## ClickHouse access contract

- Provision `torghut/torghut-audit-ro-clickhouse` through the approved secret-sync path **before** the ClickHouse
  Installation reconciles. The Secret's `password_sha256_hex` key holds the 64-character SHA-256 hex digest of a
  dedicated password. The operator reads the digest via SecretKeyRef; Auto Ontology logs in as `torghut_audit_ro`
  with the original password from the secret manager. Do not log or commit either value or a connection string.
- The [ClickHouse Installation](../../../argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml) binds
  `torghut_audit_ro` to `auto_ontology_ro`: `readonly=1`, a 30-second execution limit, a 50,000-row result threshold,
  and 2 GiB of query memory. The connector's result settings match the profile; it can lower the deadline to 1–30
  seconds. Overflow stops the result stream, so bound queries and do not treat truncated results as complete.
- Explicit `SELECT` grants restrict application data access to the eight listed `signal` tables. ClickHouse's legacy
  `allow_databases` is not a profile setting and cannot be combined with explicit grants. Built-in catalog metadata
  remains readable for discovery; do not grant query-log access, write privileges, or access to other source tables.
- The [ontology ingress rule](../../../argocd/applications/torghut/clickhouse/auto-ontology-networkpolicy.yaml)
  allows TCP 8123 from only `auto-ontology` to the two ClickHouse replicas. Policies are additive: Torghut's existing
  kube-router rollout allowance still preserves other clients. The dedicated credential and ClickHouse grants enforce
  the data boundary independently of the network rule.

## Live onboarding

1. Verify the Secret reference (without displaying its data), then reconcile the reviewed ClickHouse configuration
   through Galactic GitOps. Confirm both replicas are ready and that existing readers and writers still work. Use
   the [Galactic access runbook](../../runbooks/galactic-kubernetes-access.md) to verify the target context.
2. In [Auto Ontology](https://auto-ontology.ide-newton.ts.net), open **Settings → Connections** and test a ClickHouse
   connection to host `torghut-clickhouse.torghut.svc.cluster.local`, port `8123`, database `signal`, and user
   `torghut_audit_ro`. This HTTP port is for in-cluster use only. Inject the password through the approved connection
   workflow; review the [connector's credential storage contract](https://github.com/NVIDIA/auto-ontology/blob/v1.3.0/docs/connections.md)
   before adding it. Never reuse an application credential.
3. Verify `SHOW GRANTS` exposes only the eight source grants, a bounded read of `signal.intraday_bars_1m_v2`
   succeeds, and `CHECK GRANT INSERT ON signal.intraday_bars_1m_v2` returns 0. Ingest only the `signal` schema and
   confirm that it is unique in the catalog and contains only the intended source tables. Verify **Settings →
   Agent Settings → SQL Query Timeout** is at most 30 seconds (the default). Auto Ontology 1.3.0's optional
   column-value profiling requests 120 seconds and is rejected; schema discovery and bounded queries do not
   require those samples. Do not raise the database limits to obtain them.
4. In **Settings → Tags**, create `torghut canonical rule` if absent. Preview the reviewed bundle from the repo root:

   ```sh
   bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
     --bundle docs/torghut/ontology/torghut-knowledge.json --mode dry-run
   ```

   Dry-run validates the bundle and SQL without connecting to the database. For an approved publication, follow the
   [shared apply instructions](../../agents/ontology/README.md#preview-and-publish) with the Torghut bundle path.
   Run the four saved analyses against the catalogued source, verify their bounds, and check that a second apply
   reports `writes: 0`. This connection is for research and does not connect to any execution controller.

If onboarding must be reverted, stop using the catalog connection and reconcile the reviewed Git revert before
retiring the dedicated Secret. Do not remove the Secret while a replica still references it.
