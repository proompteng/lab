# GlitchTip reliability ontology

[GlitchTip knowledge](glitchtip-knowledge.json) covers hourly issue-event volume, week-over-week issue regressions,
release correlation and unresolved issue aging. The [audit Job](../../../argocd/applications/glitchtip/glitchtip-audit-views-job.yaml)
exposes only counts, UTC buckets and internal numeric project/issue identifiers. It does not expose free text,
individual events, user or assignment data, billing, authentication, sessions or credentials. The pinned
[GlitchTip 7.0 issue model](https://gitlab.com/glitchtip/glitchtip-backend/-/blob/v7.0.0/apps/issue_events/models.py)
stores issues in `issue_events_issue` and current status in `issue_events_issueindex`; only the status code and
join keys are used from the latter.

## Onboard the Galactic standby

1. Before the reviewed GitOps sync, provision `glitchtip/glitchtip-audit-ro-db` through the approved secret-sync
   path. Use a `kubernetes.io/basic-auth` Secret for `glitchtip_audit_ro` with a dedicated password and the
   `cnpg.io/reload: "true"` label. Do not use the application credential for catalog access.
2. Verify the [Galactic context](../../runbooks/galactic-kubernetes-access.md), then confirm CNPG reconciled the
   role, the PostSync `glitchtip-audit-views` Job succeeded after migrations, and `glitchtip-pg-ro` has a ready
   replica endpoint.
   The Job runs on the primary as the database owner; the DDL and grants replicate to the standby. It can also run
   as a standalone Job from the reviewed manifest after migrations and role reconciliation. If it fails, fix the
   prerequisite and rerun the same Job without broadening grants. Check any non-owner clients before rollout: the
   Job removes the default `PUBLIC` grants for database `CREATE`/`TEMPORARY` and `public` schema access.
3. In Auto Ontology, test `glitchtip-pg-ro.glitchtip.svc.cluster.local:5432` with database `glitchtip`, user
   `glitchtip_audit_ro` and hostname-verified CNPG TLS. As that login, require `pg_is_in_recovery()` to return `true`
   and `transaction_read_only` to be `on`. Verify reads of the six `glitchtip_audit` views succeed, base-table reads
   and database/schema/temp creation are denied, and only `glitchtip_audit` is ingested. Never fall back to `-rw` or
   `-r`. NetworkPolicies are additive: the new SQL rule targets replicas only and is not a deny rule for the
   primary. Verify that the separate port 8000 rule preserves CNPG operator and peer traffic. A future kube-router
   activation must account for the new namespace in its [policy preflight](../../runbooks/kube-router-network-policy-rollout.md).
4. Set the `glitchtip canonical rule` tag and follow [catalog publish and readback](../../agents/auto-ontology-operations.md)
   from a reviewed revision. Check a bounded query from the catalog before using it in an incident. To withdraw
   access, disable the connection and have the database owner revoke the audit schema and view grants on the
   primary; removing the Job alone does not undo SQL.

Counts cover retained, recorded issue events, not severity-filtered errors or unique users. Recent data may lag.
An increase does not prove a reopen, and the 24-hour windows around releases do not establish causation.

## Validate locally

```sh
bun run packages/scripts/src/agents/validate-ontology-bundles.ts
bun run packages/scripts/src/agents/sync-auto-ontology-bundle.ts \
  --bundle docs/glitchtip/ontology/glitchtip-knowledge.json --mode dry-run
```

Dry-run validates bundle shape and SQL syntax without making a connection or publishing. To verify the SQL, run the
Job's block twice as the owner in a disposable PostgreSQL database migrated by GlitchTip 7.0, then run all four
analyses as `glitchtip_audit_ro` against synthetic data and check the denied privileges. Do not use a production dump.
