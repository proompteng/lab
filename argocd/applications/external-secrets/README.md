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
