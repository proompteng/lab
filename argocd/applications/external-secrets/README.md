# External Secrets

This app installs External Secrets Operator and proves the 1Password SDK provider with a canary
`ExternalSecret`.

## Source of truth

- Provider: 1Password SDK.
- Vault: `infra`.
- Bootstrap token item: `op://infra/external-secrets/service-account-token`.
- Canary item: `external-secrets-canary`, field `password`.

Existing `SealedSecret` manifests are not migrated by this rollout. They remain the source of truth for existing
workloads until each workload is explicitly migrated.

## Bootstrap token

Generate the bootstrap token SealedSecret from 1Password:

```bash
bun run scripts/generate-external-secrets-onepassword-sdk-token-secret.ts
```

The script writes `onepassword-sdk-token-sealedsecret.yaml`. It passes the token through a temporary `0600` file and
does not put the token in command-line arguments.

## Adding a secret

1. Create or update the source item in the `infra` 1Password vault.
2. Label the consuming namespace with `external-secrets.proompteng.ai/enabled=true`.
3. Add an `ExternalSecret` that references `ClusterSecretStore/onepassword-infra`.
4. Verify readiness:

```bash
kubectl -n <namespace> get externalsecret <name>
kubectl -n <namespace> describe externalsecret <name>
kubectl -n <namespace> get secret <target-secret>
```

Do not print secret values during verification. Compare presence, length, or hashes only.

## Refresh and read budget

Static API and SMTP credentials refresh daily. Codex OAuth credentials and the provider canary retain hourly
refreshes. After rotating a credential, let the one-minute provider read cache expire, then explicitly refresh its
ExternalSecret and verify the target value rather than waiting for the next periodic read. Kubernetes Secret
projection can take additional time to reach consumers.

Fetch a multi-field 1Password item once with `dataFrom.extract`. Keep `target.template.mergePolicy: Replace`
and enumerate the existing consumer keys in the template so unrelated item fields cannot enter its Secret.
Buzz reads its Redis password from the existing `buzz-redis-auth` Secret through its existing Kubernetes store.
Its mixed-source runtime Secret keeps hourly reconciliation for database credential changes.

Both SDK stores use a one-minute read cache for repeated reads during reconciliation bursts. This does not
replace refresh policies or increase the account-wide 1Password quota. Include per-field `sourceRef.storeRef`
overrides when calculating provider demand; the top-level store alone does not identify every 1Password read.
